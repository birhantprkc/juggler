//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"juggler/internal/gitignore"
	"juggler/internal/jlog"
	"juggler/internal/skipdirs"

	"github.com/fsnotify/fsnotify"
)

// FileChange represents a single file change event
type FileChange struct {
	Path  string `json:"path"`  // Relative path to the file
	Event string `json:"event"` // write, create, remove, rename
}

// ChangeNotification represents a batch of file changes
type ChangeNotification struct {
	Changes []FileChange `json:"changes"`
}

// gitignoreRebuildDebounce is how long we wait after the last .gitignore edit
// before rebuilding the watch/index. It coalesces a burst (a branch switch
// rewrites many ignore files) into one rebuild.
const gitignoreRebuildDebounce = time.Second

// FileWatcher watches a directory for file changes and sends immediate notifications
type FileWatcher struct {
	watcher     *fsnotify.Watcher
	projectPath string
	changeChan  chan ChangeNotification
	stopChan    chan struct{}
	stopOnce    sync.Once
	index       *PathIndex

	// ign filters gitignored paths out of the watch/index (not the frontend
	// change stream). Rebuilt from scratch on each walk. Owned by the constructor
	// then exclusively by watchLoop, so no locking is needed.
	ign *gitignore.Matcher

	// rebuildC signals watchLoop to rebuild after a debounced .gitignore change;
	// rebuildTimer (touched only on watchLoop) drives the debounce.
	rebuildC     chan struct{}
	rebuildTimer *time.Timer
}

// NewFileWatcher creates a new file watcher for the given project directory
func NewFileWatcher(projectPath string) (*FileWatcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &FileWatcher{
		watcher:     fsw,
		projectPath: projectPath,
		// 100 absorbs a "git checkout" burst (file events arrive faster than the
		// frontend can ack); larger wastes memory, smaller drops events on
		// branch swaps and forces a full re-scan.
		changeChan: make(chan ChangeNotification, 100),
		stopChan:   make(chan struct{}),
		rebuildC:   make(chan struct{}, 1),
	}

	// One BFS walk registers directory watches and builds the path index.
	paths, partial := w.buildWatchesAndIndex(projectPath)
	w.index = newPathIndex(paths, partial)

	jlog.Info("[FileWatcher] Watching project: %s (%d paths indexed)", projectPath, len(paths))

	return w, nil
}

// Index returns the file-path index backing "@" mention completion. Never nil
// for a successfully constructed watcher.
func (w *FileWatcher) Index() *PathIndex {
	return w.index
}

// maxWatchedDirs caps the number of directories we ask fsnotify to watch.
// On darwin fsnotify's kqueue backend opens one fd per *file* under each
// watched directory; an uncapped recursive walk over a tree containing e.g.
// vendored boost / llvm / JUCE sources can punch through the per-process
// fd limit and starve unrelated subsystems (the next open() — a Wails
// Metal shader load, a session file, anything — fails with EMFILE).
const maxWatchedDirs = 1000

// maxCreateWalk bounds the sub-walk triggered when a directory is created (or
// moved in) so a large moved-in tree can't hog the watch goroutine. Staleness
// past this bound is acceptable — a project switch rebuilds the index.
const maxCreateWalk = 20000

// buildWatchesAndIndex does a single breadth-first walk of the project tree
// that (a) registers directory watches up to maxWatchedDirs and (b) collects
// every non-skipped file/dir path (dirs with a trailing "/") for the index, up
// to maxIndexedPaths. BFS matters at the cap: it leaves a representative slice
// (all shallow paths plus the top of every subtree) rather than one subtree in
// full. Indexing continues past the watch cap — only watching stops there.
func (w *FileWatcher) buildWatchesAndIndex(root string) (paths []string, partial bool) {
	watched := 0
	skippedWatch := 0

	// Fresh matcher per walk (so a rebuild picks up edited .gitignore files).
	w.ign = gitignore.NewMatcher(root)

	_ = w.watcher.Add(root)
	watched++

	type queued struct{ abs, rel string }
	queue := []queued{{abs: root, rel: ""}}

	for len(queue) > 0 {
		if len(paths) >= maxIndexedPaths {
			partial = true
			break
		}
		cur := queue[0]
		queue = queue[1:]

		entries, err := os.ReadDir(cur.abs)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			isDir := entry.IsDir()
			if isDir {
				if skipdirs.Skip(name) {
					continue
				}
			}

			rel := name
			if cur.rel != "" {
				rel = cur.rel + "/" + name
			}

			// Gitignored paths are neither watched, indexed, nor queued — so
			// ignored subtrees don't consume the watch/index caps.
			if w.ign.Ignored(rel, isDir) {
				continue
			}

			if len(paths) >= maxIndexedPaths {
				partial = true
				break
			}
			if isDir {
				paths = append(paths, rel+"/")
			} else {
				paths = append(paths, rel)
			}

			if isDir {
				abs := filepath.Join(cur.abs, name)
				if watched < maxWatchedDirs {
					_ = w.watcher.Add(abs)
					watched++
				} else {
					skippedWatch++
				}
				queue = append(queue, queued{abs: abs, rel: rel})
			}
		}
	}

	if skippedWatch > 0 {
		jlog.Info("[FileWatcher] Watch cap (%d dirs) reached; %d dirs unwatched (index still covers them)", maxWatchedDirs, skippedWatch)
	}
	return paths, partial
}

// relSlash converts an absolute path under the project into a project-relative,
// forward-slash path. Returns "" if it cannot be made relative.
func (w *FileWatcher) relSlash(absPath string) string {
	rel, err := filepath.Rel(w.projectPath, absPath)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

// indexCreated adds a newly created path to the index. For a created (or
// moved-in) directory it also runs a bounded sub-walk, since the directory's
// existing contents may not each fire their own create event.
func (w *FileWatcher) indexCreated(absPath string) {
	base := filepath.Base(absPath)
	if strings.HasPrefix(base, ".") {
		return
	}
	if skipdirs.Skip(base) {
		return
	}
	rel := w.relSlash(absPath)
	if rel == "" || rel == "." {
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return // vanished already — nothing to index
	}
	// Don't leak gitignored paths into the index incrementally.
	if w.ign.Ignored(rel, info.IsDir()) {
		return
	}
	if !info.IsDir() {
		w.index.add(rel)
		return
	}
	w.index.add(rel + "/")
	w.indexSubtree(absPath, rel)
}

// indexRemoved drops a removed/renamed path (and, if it was a directory, its
// whole subtree) from the index.
func (w *FileWatcher) indexRemoved(absPath string) {
	rel := w.relSlash(absPath)
	if rel == "" || rel == "." {
		return
	}
	w.index.del(rel)
}

// indexSubtree BFS-walks a subtree and feeds every non-skipped path into the
// index, watching subdirectories as it goes. Bounded by maxCreateWalk.
func (w *FileWatcher) indexSubtree(absRoot, relRoot string) {
	type queued struct{ abs, rel string }
	queue := []queued{{abs: absRoot, rel: relRoot}}
	count := 0

	for len(queue) > 0 && count < maxCreateWalk {
		cur := queue[0]
		queue = queue[1:]

		entries, err := os.ReadDir(cur.abs)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if count >= maxCreateWalk {
				break
			}
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			isDir := entry.IsDir()
			if isDir {
				if skipdirs.Skip(name) {
					continue
				}
			}

			rel := cur.rel + "/" + name
			abs := filepath.Join(cur.abs, name)
			if w.ign.Ignored(rel, isDir) {
				continue
			}
			count++
			if isDir {
				w.index.add(rel + "/")
				_ = w.watcher.Add(abs)
				queue = append(queue, queued{abs: abs, rel: rel})
			} else {
				w.index.add(rel)
			}
		}
	}
}

// Start begins watching for file changes
func (w *FileWatcher) Start() {
	go w.watchLoop()
}

// watchLoop processes file system events.
// This goroutine owns changeChan — it closes it on exit.
func (w *FileWatcher) watchLoop() {
	defer func() {
		w.watcher.Close()
		close(w.changeChan)
		if w.index != nil {
			w.index.close()
		}
		jlog.Debug("[FileWatcher] Stopped")
	}()

	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)

		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			jlog.Error("[FileWatcher] Error: %v", err)

		case <-w.rebuildC:
			w.rebuild()

		case <-w.stopChan:
			return
		}
	}
}

// isIgnoreFile reports whether an absolute path is a git ignore-rule file whose
// edit should trigger an index rebuild.
func isIgnoreFile(absPath string) bool {
	p := filepath.ToSlash(absPath)
	return filepath.Base(p) == ".gitignore" || strings.HasSuffix(p, ".git/info/exclude")
}

// scheduleRebuild (re)arms the debounce timer. Runs only on watchLoop, so the
// timer field needs no lock. The timer callback signals rebuildC; the actual
// rebuild then runs on watchLoop, which owns w.ign and the walk.
func (w *FileWatcher) scheduleRebuild() {
	if w.rebuildTimer == nil {
		w.rebuildTimer = time.AfterFunc(gitignoreRebuildDebounce, func() {
			select {
			case w.rebuildC <- struct{}{}:
			case <-w.stopChan:
			}
		})
		return
	}
	w.rebuildTimer.Reset(gitignoreRebuildDebounce)
}

// rebuild re-walks the tree with a fresh matcher and swaps the index contents.
// Stale watches on now-ignored directories are left in place (harmless: their
// events are filtered by the fresh matcher); newly un-ignored dirs get watched.
func (w *FileWatcher) rebuild() {
	paths, partial := w.buildWatchesAndIndex(w.projectPath)
	if w.index != nil {
		w.index.replace(paths, partial)
	}
	jlog.Info("[FileWatcher] Rebuilt after .gitignore change (%d paths indexed)", len(paths))
}

// handleEvent processes a single file system event
func (w *FileWatcher) handleEvent(event fsnotify.Event) {
	// A .gitignore (or .git/info/exclude) edit changes what should be indexed —
	// schedule a debounced rebuild. Checked before the hidden-file skip below,
	// since .gitignore is a dot-file. No frontend notification is sent for it.
	if isIgnoreFile(event.Name) {
		w.scheduleRebuild()
	}

	// Convert absolute path to relative path
	relPath, err := filepath.Rel(w.projectPath, event.Name)
	if err != nil {
		relPath = event.Name
	}

	// Skip hidden files
	if strings.HasPrefix(filepath.Base(relPath), ".") {
		return
	}

	// Map fsnotify operations to our event types
	eventType := ""
	switch {
	case event.Op&fsnotify.Write == fsnotify.Write:
		eventType = "write"
	case event.Op&fsnotify.Create == fsnotify.Create:
		eventType = "create"
		// If a new directory was created, add it to the watcher
		_ = w.watcher.Add(event.Name) // Ignore errors for dynamic directory watching
		w.indexCreated(event.Name)
	case event.Op&fsnotify.Remove == fsnotify.Remove:
		eventType = "remove"
		w.indexRemoved(event.Name)
	case event.Op&fsnotify.Rename == fsnotify.Rename:
		eventType = "rename"
		w.indexRemoved(event.Name)
	default:
		return // Ignore other operations
	}

	// Send immediately - no batching, no debouncing
	// Context items will handle their own debouncing via _scheduleRefresh()
	change := FileChange{
		Path:  relPath,
		Event: eventType,
	}

	// Send notification (non-blocking)
	select {
	case w.changeChan <- ChangeNotification{Changes: []FileChange{change}}:
	default:
		jlog.Error("[FileWatcher] Dropped file change event (channel full): %s (%s)", relPath, eventType)
	}
}

// Changes returns the channel for receiving change notifications
func (w *FileWatcher) Changes() <-chan ChangeNotification {
	return w.changeChan
}

// Stop stops the file watcher and cleans up resources.
// Safe to call multiple times.
func (w *FileWatcher) Stop() {
	w.stopOnce.Do(func() {
		close(w.stopChan)
		// Reclaim the index goroutine even if Start (hence watchLoop, which
		// also stops the index on teardown) was never called. Idempotent, so
		// the two paths can't double-close.
		if w.index != nil {
			w.index.stopSignal()
		}
	})
}
