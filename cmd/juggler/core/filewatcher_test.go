//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeTree(t *testing.T, root string, rels []string) {
	t.Helper()
	for _, rel := range rels {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestFileWatcher_IndexBuildsFromTree checks the construction-time BFS walk
// populates the index across the whole tree (deep files included) while
// honoring the skip-list. No file events are involved — this is deterministic.
func TestFileWatcher_IndexBuildsFromTree(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{
		"web/js/components/git/git-status-card.js",
		"node_modules/pkg/junk-widget.js", // skipped subtree
		"src/main.go",
	})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()

	// Deep file is found and ranks first for a near-unique substring.
	got := searchPaths(w.Index(), "git-status", 20)
	if len(got) == 0 || got[0] != "web/js/components/git/git-status-card.js" {
		t.Fatalf("expected deep file ranked first, got %v", got)
	}

	// node_modules contents are excluded by the skip-list.
	if got := searchPaths(w.Index(), "junk-widget", 20); len(got) != 0 {
		t.Errorf("skip-listed subtree should not be indexed, got %v", got)
	}
}

// TestFileWatcher_StopReclaimsIndexWithoutStart guards against an index
// goroutine leak: the index goroutine starts at construction, so Stop() must
// reclaim it even when Start() (hence watchLoop) was never called.
func TestFileWatcher_StopReclaimsIndexWithoutStart(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, []string{"a.go"})

	w, err := NewFileWatcher(root)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately do NOT call Start().
	w.Stop()

	select {
	case <-w.index.stopped:
		// Owner goroutine exited — reclaimed, no leak.
	case <-time.After(2 * time.Second):
		t.Fatal("index goroutine not reclaimed after Stop() without Start()")
	}
}
