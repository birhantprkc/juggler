//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/mcp"
	"juggler/internal/jlog"

	"github.com/fsnotify/fsnotify"
)

// maxPluginWatchDepth bounds the recursion when registering watches on an
// extension tree, a cheap guard against a pathological symlink cycle that
// EvalSymlinks deduplication didn't already break.
const maxPluginWatchDepth = 12

// StartWatchers constructs and starts the filesystem watcher (which walks
// the project tree and registers fsnotify watches), kicks off the broadcast
// goroutine, and starts the plugin-directory watcher. Call this once, after
// the engine is up and the server is serving — earlier and you'd be
// holding kernel watch handles for events with no audience.
//
// In no-project boot mode this is a no-op for the file watcher; the watcher
// will be created later when the user picks a project via SwitchProject.
func (s *Server) StartWatchers() {
	st := s.projectState.Load()
	if st != nil && st.projectPath != "" && st.fileWatcher == nil {
		fw, err := core.NewFileWatcher(st.projectPath)
		if err != nil {
			jlog.Error("Failed to create file watcher: %v", err)
		} else {
			fw.Start()
			// Install into the live projectState. We rebuild the struct
			// to keep the atomic-pointer write-once semantics clean.
			newSt := *st
			newSt.fileWatcher = fw
			newSt.fileChangesCh = make(chan struct{})
			s.projectState.Store(&newSt)
			go s.forwardFileChanges(&newSt)
		}
	}
	s.startPluginWatcher()
	// When the MCP tool snapshot changes (a server became ready, crashed, or
	// sent tools/list_changed), reuse the extension hot-reload broadcast so
	// connected engines reload registries and pick up the new tool set.
	mcp.SetChangeHook(func() {
		s.broadcastToAll(map[string]any{"type": "plugin-changed", "path": "config/mcp"})
	})
	s.RefreshProviders()
	s.startUpdateChecker()
}

func (s *Server) flushFileChangeBatch(changes []core.FileChange) {
	// Dedupe by path (keep latest event type per path)
	seen := make(map[string]core.FileChange)
	for _, c := range changes {
		seen[c.Path] = c
	}

	deduped := make([]core.FileChange, 0, len(seen))
	for _, c := range seen {
		deduped = append(deduped, c)
	}

	s.broadcastToAll(map[string]any{
		"type":    "file-change",
		"changes": deduped,
	})
}

// startPluginWatcher watches the extension container directories
// (~/.juggler/extensions and <project>/.juggler/extensions) for changes,
// broadcasting plugin-changed for hot reload. Extension containers hold one
// subdirectory per extension — often a symlink created by `juggler ext link` —
// so each tree is registered recursively with symlinks resolved, and newly
// created subdirectories (a freshly linked or added extension) are picked up on
// the fly.
func (s *Server) startPluginWatcher() {
	dirs := s.pluginWatchDirs()
	if len(dirs) == 0 {
		return
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		jlog.Error("[PluginWatcher] Failed to create watcher: %v", err)
		return
	}

	// Resolved-path set shared across all roots and later Create events, so a dir
	// reachable via two paths (e.g. a symlink) is only watched once.
	watched := map[string]bool{}
	total := 0
	for _, dir := range dirs {
		n := addPluginTree(watcher, dir, watched)
		if n > 0 {
			jlog.Info("[PluginWatcher] Watching %d dir(s) under: %s", n, dir)
		}
		total += n
	}

	if total == 0 {
		watcher.Close()
		return
	}

	go func() {
		defer watcher.Close()
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				isDir := false
				if fi, err := os.Stat(event.Name); err == nil {
					isDir = fi.IsDir()
				}
				action := classifyPluginEvent(event.Name, event.Op, isDir)
				// A freshly linked/added extension dir's files already exist, so
				// start watching its subtree for subsequent edits.
				if action.watchTree {
					addPluginTree(watcher, event.Name, watched)
				}
				if action.broadcast {
					jlog.Info("[PluginWatcher] Plugin changed: %s", event.Name)
					s.broadcastToAll(map[string]any{
						"type": "plugin-changed",
						"path": event.Name,
					})
				}

			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				jlog.Error("[PluginWatcher] Error: %v", err)

			case <-s.shutdownChan:
				return
			}
		}
	}()
}

// pluginWatchDirs returns the extension container directories whose trees the
// watcher should register, all owned by the ExtensionsAPI. The container is
// created if absent so a `juggler ext link` performed while the server is already
// running is caught by the watch on the container.
func (s *Server) pluginWatchDirs() []string {
	api := s.extensionsAPI
	var dirs []string
	for _, extDir := range []string{api.UserExtensionDir()} {
		if extDir == "" {
			continue
		}
		_ = os.MkdirAll(extDir, 0o755)
		dirs = append(dirs, extDir)
	}
	return dirs
}

// isPluginFile reports whether a changed path is one a hot reload cares about:
// any JS capability file or an extension manifest.
func isPluginFile(name string) bool {
	return strings.HasSuffix(name, ".js") || filepath.Base(name) == "juggler.extension.json"
}

// pluginEventAction is how the plugin watcher reacts to one filesystem event.
type pluginEventAction struct {
	watchTree bool // begin watching name's subtree (a newly appeared extension dir)
	broadcast bool // emit plugin-changed so connected viewers hot-reload
}

// classifyPluginEvent decides the watcher's reaction to a filesystem event. It is
// pure (no IO) so the decision is unit-testable; the caller supplies isDir.
//
// A newly created directory is a freshly linked or added extension (`juggler ext
// link`/`add`). Its capability files already exist on disk, so no per-file Create
// events fire for them — without broadcasting here the extension would not load
// until the next unrelated edit. So a new dir both starts a watch AND broadcasts.
func classifyPluginEvent(name string, op fsnotify.Op, isDir bool) pluginEventAction {
	if op&fsnotify.Create != 0 && isDir {
		return pluginEventAction{watchTree: true, broadcast: true}
	}
	if !isPluginFile(name) {
		return pluginEventAction{}
	}
	if op&(fsnotify.Write|fsnotify.Create|fsnotify.Remove|fsnotify.Rename) == 0 {
		return pluginEventAction{}
	}
	return pluginEventAction{broadcast: true}
}

// addPluginTree registers watches on dir and every subdirectory beneath it,
// resolving symlinks (so a `juggler ext link` target dir is watched at its real
// location) and de-duplicating via the shared watched set. It returns the number
// of directories newly added. A missing dir contributes nothing.
func addPluginTree(watcher *fsnotify.Watcher, dir string, watched map[string]bool) int {
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return 0 // absent or dangling — nothing to watch
	}
	return addDirRecursive(watcher, resolved, watched, 0)
}

// addDirRecursive adds a single resolved directory and recurses into its
// subdirectories, following symlinked children (each extension under a container
// may itself be a symlink). depth is bounded by maxPluginWatchDepth.
func addDirRecursive(watcher *fsnotify.Watcher, dir string, watched map[string]bool, depth int) int {
	if depth > maxPluginWatchDepth || watched[dir] {
		return 0
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return 0
	}
	if err := watcher.Add(dir); err != nil {
		return 0
	}
	watched[dir] = true
	count := 1

	entries, err := os.ReadDir(dir)
	if err != nil {
		return count
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		// Resolve each child so a symlinked extension dir is followed to its real
		// path; non-directories and dangling links are skipped.
		childResolved, err := filepath.EvalSymlinks(full)
		if err != nil {
			continue
		}
		fi, err := os.Stat(childResolved)
		if err != nil || !fi.IsDir() {
			continue
		}
		count += addDirRecursive(watcher, childResolved, watched, depth+1)
	}
	return count
}
