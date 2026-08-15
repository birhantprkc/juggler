//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSnapshotEngineGraph snapshots the real embedded engine graph to disk and
// asserts the transform is self-contained: the entry exists, the graph root and
// an SDK facade are present, every import is a relative file path, and no bare
// juggler/* specifier or /worker-module loader URL survives (Node can resolve
// neither).
func TestSnapshotEngineGraph(t *testing.T) {
	s := &Server{} // zero value: assetsFromDisk=false, staticVersion="" → reads embed
	dir := t.TempDir()

	entry, err := s.snapshotEngineGraph(dir)
	if err != nil {
		t.Fatalf("snapshotEngineGraph: %v", err)
	}

	// Entry generated at the snapshot root.
	if got := filepath.Base(entry); got != engineSnapshotEntry {
		t.Errorf("entry base = %q, want %q", got, engineSnapshotEntry)
	}
	if _, err := os.Stat(entry); err != nil {
		t.Errorf("entry file missing: %v", err)
	}

	// The sibling glue modules are copied beside the entry at the snapshot root:
	// the extension loader hooks (glue registers ./engine-loader-hooks.mjs) and
	// the query_code worker_threads sandbox (delegate + worker + its loader
	// hooks). Missing any of them breaks node mode — extensions or query_code.
	for _, name := range []string{
		engineLoaderHooksName,
		"engine-sandbox-node.mjs",
		"engine-sandbox-worker.mjs",
		"engine-sandbox-loader-hooks.mjs",
	} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("snapshot root module %q missing: %v", name, err)
		}
	}

	// The graph root and SDK members it actually pulls in (proves the SDK map +
	// relative traversal both ran) were written at their mirrored locations.
	for _, rel := range []string{"js/engine-app.js", "sdk/context-item.js", "sdk/strategy-type.js", "sdk/lib/html.js"} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			t.Errorf("expected snapshot file %q missing: %v", rel, err)
		}
	}

	// engine-app.js must have its imports rewritten to relative paths.
	engineApp, err := os.ReadFile(filepath.Join(dir, "js/engine-app.js"))
	if err != nil {
		t.Fatalf("read snapshot engine-app.js: %v", err)
	}
	src := string(engineApp)
	if strings.Contains(src, "'juggler/") || strings.Contains(src, "\"juggler/") {
		t.Errorf("snapshot engine-app.js still contains a bare juggler/* specifier")
	}
	if strings.Contains(src, "/worker-module?") {
		t.Errorf("snapshot engine-app.js contains a /worker-module loader URL (Node can't import it)")
	}
	if !strings.Contains(src, "'./services/websocket.js'") {
		t.Errorf("snapshot engine-app.js missing expected relative import './services/websocket.js'")
	}

	// The whole graph is substantial — a regression that snapshots only the
	// entry (e.g. traversal broke) would leave this near zero.
	if n := countFiles(t, dir); n < 50 {
		t.Errorf("snapshot wrote %d files, expected the full graph (>= 50)", n)
	}

	// No bare juggler/* SDK specifier may survive in ANY module — Node has no
	// import map to resolve them, so a single leftover is a hard load failure.
	// This walks the whole snapshot, not just the entry, so an unmapped
	// specifier deep in the graph is caught here rather than at runtime.
	assertNoBareSDKSpecifier(t, dir)
}

func assertNoBareSDKSpecifier(t *testing.T, root string) {
	t.Helper()
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, marker := range []string{"from 'juggler/", "from \"juggler/", "import('juggler/", "import(\"juggler/"} {
			if strings.Contains(string(b), marker) {
				t.Errorf("%s still contains an unrewritten SDK specifier (%q)", p, marker)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk snapshot: %v", err)
	}
}

func TestPrepareNodeEngineHostCleanup(t *testing.T) {
	s := &Server{} // zero value reads the embedded graph, matching TestSnapshotEngineGraph.
	spec, err := s.PrepareNodeEngineHost()
	if err != nil {
		t.Fatalf("PrepareNodeEngineHost: %v", err)
	}
	dir := filepath.Dir(spec.Entry)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("snapshot directory missing before cleanup: %v", err)
	}
	spec.Cleanup()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("snapshot directory remains after cleanup: err=%v", err)
	}
}

func TestSnapshotRelPath(t *testing.T) {
	cases := []struct {
		from, to, want string
	}{
		{"/js/engine-app.js", "/js/services/websocket.js", "./services/websocket.js"},
		{"/js/engine-app.js", "/sdk/ops.js", "../sdk/ops.js"},
		{"/js/registries/base-registry.js", "/js/services/websocket.js", "../services/websocket.js"},
		{"/js/a.js", "/js/a.js", "./a.js"},
		{"/sdk/lib/html.js", "/sdk/lib/ansi.js", "./ansi.js"},
	}
	for _, tc := range cases {
		if got := snapshotRelPath(tc.from, tc.to); got != tc.want {
			t.Errorf("snapshotRelPath(%q, %q) = %q, want %q", tc.from, tc.to, got, tc.want)
		}
	}
}

func countFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			n++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk snapshot: %v", err)
	}
	return n
}
