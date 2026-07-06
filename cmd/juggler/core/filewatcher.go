//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"juggler/internal/jlog"

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

// FileWatcher watches a directory for file changes and sends immediate notifications
type FileWatcher struct {
	watcher     *fsnotify.Watcher
	projectPath string
	changeChan  chan ChangeNotification
	stopChan    chan struct{}
	stopOnce    sync.Once
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
	}

	// Add root directory
	if err := w.addRecursive(projectPath); err != nil {
		fsw.Close()
		return nil, err
	}

	jlog.Info("[FileWatcher] Watching project: %s", projectPath)

	return w, nil
}

// maxWatchedDirs caps the number of directories we ask fsnotify to watch.
// On darwin fsnotify's kqueue backend opens one fd per *file* under each
// watched directory; an uncapped recursive walk over a tree containing e.g.
// vendored boost / llvm / JUCE sources can punch through the per-process
// fd limit and starve unrelated subsystems (the next open() — a Wails
// Metal shader load, a session file, anything — fails with EMFILE).
const maxWatchedDirs = 1000

// skipDirNames lists directory base names that are never watched. These are
// the usual large generated / vendored subtrees; watching them is rarely
// useful and is the most common source of fd exhaustion on darwin.
var skipDirNames = map[string]struct{}{
	"node_modules":        {},
	"vendor":              {},
	"bin":                 {},
	"dist":                {},
	"build":               {},
	"out":                 {},
	"Pods":                {},
	"__pycache__":         {},
	"cmake-build-debug":   {},
	"cmake-build-release": {},
}

// addRecursive adds a directory and all its subdirectories to the watcher.
// Stops early once maxWatchedDirs is reached and logs a warning.
func (w *FileWatcher) addRecursive(root string) error {
	watched := 0
	skipped := 0
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		if info.IsDir() {
			base := filepath.Base(path)
			if strings.HasPrefix(base, ".") && base != "." {
				return filepath.SkipDir
			}
			if _, skip := skipDirNames[base]; skip {
				return filepath.SkipDir
			}

			if watched >= maxWatchedDirs {
				skipped++
				jlog.Debug("[FileWatcher] Reached watch cap (%d dirs); skipping %s and below", maxWatchedDirs, path)
				return filepath.SkipDir
			}
			_ = w.watcher.Add(path)
			watched++
		}

		return nil
	})
	if skipped > 0 {
		jlog.Info("[FileWatcher] Watch cap (%d dirs) reached; %d subtrees skipped (enable debug for paths)", maxWatchedDirs, skipped)
	}
	return err
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

		case <-w.stopChan:
			return
		}
	}
}

// handleEvent processes a single file system event
func (w *FileWatcher) handleEvent(event fsnotify.Event) {
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
	case event.Op&fsnotify.Remove == fsnotify.Remove:
		eventType = "remove"
	case event.Op&fsnotify.Rename == fsnotify.Rename:
		eventType = "rename"
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
	})
}
