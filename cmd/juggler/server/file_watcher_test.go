//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
)

func TestIsPluginFile(t *testing.T) {
	cases := map[string]bool{
		"/a/b/foo-context-item.js":     true,
		"/a/b/juggler.extension.json":  true,
		"/a/b/review.md":               true, // user-command definition (or a stray .md — harmless)
		"/a/b/icon.svg":                false,
		"/a/juggler.extension.json.js": true,  // .js suffix
		"/a/notes.json":                false, // a non-manifest json is ignored
	}
	for path, want := range cases {
		if got := isPluginFile(path); got != want {
			t.Errorf("isPluginFile(%q) = %v, want %v", path, got, want)
		}
	}
}

// TestClassifyPluginEvent covers the watcher's per-event reaction, in particular
// that a newly created extension directory (a `juggler ext link`/`add`) triggers
// BOTH a subtree watch and a hot-reload broadcast — because its files already
// exist, so no per-file Create event will otherwise fire to load it.
func TestClassifyPluginEvent(t *testing.T) {
	cases := []struct {
		name      string
		path      string
		op        fsnotify.Op
		isDir     bool
		watchTree bool
		broadcast bool
	}{
		{"new linked extension dir", "/ext/linked", fsnotify.Create, true, true, true},
		{"new nested capability dir", "/ext/linked/context-items", fsnotify.Create, true, true, true},
		{"edited capability file", "/ext/linked/foo-context-item.js", fsnotify.Write, false, false, true},
		{"new capability file", "/ext/linked/bar-context-item.js", fsnotify.Create, false, false, true},
		{"removed capability file", "/ext/linked/gone-context-item.js", fsnotify.Remove, false, false, true},
		{"edited manifest", "/ext/linked/juggler.extension.json", fsnotify.Write, false, false, true},
		{"edited command definition", "/commands/review.md", fsnotify.Write, false, false, true},
		{"unrelated non-plugin edit", "/ext/linked/icon.svg", fsnotify.Write, false, false, false},
		{"chmod on capability file", "/ext/linked/foo-context-item.js", fsnotify.Chmod, false, false, false},
	}
	for _, c := range cases {
		got := classifyPluginEvent(c.path, c.op, c.isDir)
		if got.watchTree != c.watchTree || got.broadcast != c.broadcast {
			t.Errorf("%s: classifyPluginEvent(%q, %v, dir=%v) = {watchTree:%v broadcast:%v}, want {watchTree:%v broadcast:%v}",
				c.name, c.path, c.op, c.isDir, got.watchTree, got.broadcast, c.watchTree, c.broadcast)
		}
	}
}

// TestAddPluginTreeRecursiveAndSymlinks verifies that addPluginTree registers
// watches on a container, its nested capability directories, AND a symlinked
// extension dir (the shape `juggler ext link` produces), de-duplicating shared
// resolved paths via the watched set.
func TestAddPluginTreeRecursiveAndSymlinks(t *testing.T) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new watcher: %v", err)
	}
	defer watcher.Close()

	container := t.TempDir()

	// A regular extension with a nested capability directory.
	regular := filepath.Join(container, "regular")
	regularCtx := filepath.Join(regular, "context-items")
	if err := os.MkdirAll(regularCtx, 0o755); err != nil {
		t.Fatal(err)
	}

	// A symlinked extension pointing outside the container, also with a nested dir.
	external := filepath.Join(t.TempDir(), "linked")
	externalCmds := filepath.Join(external, "commands")
	if err := os.MkdirAll(externalCmds, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(container, "linked")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	watched := map[string]bool{}
	extDirs := map[string]bool{}
	n := addPluginTree(watcher, container, watched, extDirs)
	if n == 0 {
		t.Fatal("addPluginTree watched no directories")
	}

	mustWatch := []string{container, regular, regularCtx, external, externalCmds}
	for _, dir := range mustWatch {
		resolved, err := filepath.EvalSymlinks(dir)
		if err != nil {
			t.Fatalf("evalsymlinks %s: %v", dir, err)
		}
		if !watched[resolved] {
			t.Errorf("expected %s (resolved %s) to be watched", dir, resolved)
		}
		// The epoch bump is gated on this set, so a linked extension's real
		// location must be marked too — its edits are the whole point of the
		// dev workflow.
		if !extDirs[resolved] {
			t.Errorf("expected %s (resolved %s) to be marked as extension code", dir, resolved)
		}
	}

	// Idempotence: a second pass over an already-watched tree adds nothing new.
	before := len(watched)
	if extra := addPluginTree(watcher, container, watched, extDirs); extra != 0 {
		t.Errorf("second addPluginTree added %d dirs, want 0", extra)
	}
	if len(watched) != before {
		t.Errorf("watched set grew from %d to %d on re-add", before, len(watched))
	}
}

// TestAddPluginTreeMissingDir tolerates an absent directory (returns 0, no panic).
func TestAddPluginTreeMissingDir(t *testing.T) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatalf("new watcher: %v", err)
	}
	defer watcher.Close()

	watched := map[string]bool{}
	if n := addPluginTree(watcher, filepath.Join(t.TempDir(), "nope"), watched, nil); n != 0 {
		t.Errorf("addPluginTree on missing dir = %d, want 0", n)
	}
}

// TestIsExtensionEvent covers the gate that decides whether a watcher event
// busts the extension URL epoch. Only the extension tree does: a user-command
// edit shares the same broadcast but carries no new capability code, and
// bumping the epoch for it would pointlessly re-import every extension.
func TestIsExtensionEvent(t *testing.T) {
	extDirs := map[string]bool{
		filepath.FromSlash("/ext/my-ext"):               true,
		filepath.FromSlash("/ext/my-ext/context-items"): true,
	}
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"file in extension dir", filepath.FromSlash("/ext/my-ext/context-items/a.js"), true},
		{"the extension dir itself", filepath.FromSlash("/ext/my-ext"), true},
		{"user command file", filepath.FromSlash("/commands/review.md"), false},
		{"unwatched sibling", filepath.FromSlash("/ext/other/a.js"), false},
	}
	for _, c := range cases {
		if got := isExtensionEvent(c.path, extDirs); got != c.want {
			t.Errorf("%s: isExtensionEvent(%q) = %v, want %v", c.name, c.path, got, c.want)
		}
	}
}

// TestHandleReloadExtensions covers POST /api/extensions/reload: it must both
// advance the URL epoch (so the reload actually re-imports edited files instead
// of replaying cached modules) and broadcast plugin-changed (so the engine
// worker reloads too, not just the viewer that clicked).
func TestHandleReloadExtensions(t *testing.T) {
	s := &Server{
		router:        mux.NewRouter(),
		staticVersion: "test",
		serverAPIs:    serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(fstest.MapFS{}, "", t.TempDir())},
		wsFleet:       wsFleet{hub: newClientHub()},
	}
	s.setupRoutes()

	client := testRoleClient("v1", ClientRoleViewer, "local")
	s.hub.register(client)
	nextClientsCount(t, client) // drain the join notification

	before := s.extensionsAPI.UserExtensionURLPrefix()

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest("POST", "/api/extensions/reload", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/extensions/reload = %d, want 200", rec.Code)
	}

	if after := s.extensionsAPI.UserExtensionURLPrefix(); after == before {
		t.Errorf("URL prefix still %q after a reload — the module cache would replay stale code", after)
	}

	select {
	case msg := <-client.send:
		m, ok := msg.json.(map[string]any)
		if !ok {
			t.Fatalf("expected map message, got %T", msg.json)
		}
		if m["type"] != "plugin-changed" {
			t.Errorf("broadcast type = %v, want plugin-changed", m["type"])
		}
	case <-time.After(time.Second):
		t.Fatal("no plugin-changed broadcast after reload")
	}
}
