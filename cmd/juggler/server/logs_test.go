//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/logpaths"
)

// writeLog creates path (and any parent dirs) with the given contents, failing
// the test on any error.
func writeLog(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// TestResolveLogPath pins the security gate: paths inside the log dir resolve,
// everything else (traversal, siblings of the log dir, directories, empty) is
// rejected so the content endpoint can never serve arbitrary files.
func TestResolveLogPath(t *testing.T) {
	logDir := t.TempDir()
	t.Setenv("JUGGLER_LOG_DIR", logDir)

	inside := filepath.Join(logDir, "host", "server.log")
	writeLog(t, inside, "ok")

	if got, ok := resolveLogPath(inside); !ok || got != inside {
		t.Errorf("expected %q to resolve; got (%q, %v)", inside, got, ok)
	}

	// A secret outside the log dir, reachable only via traversal, must be denied.
	outside := filepath.Join(t.TempDir(), "secret.txt")
	writeLog(t, outside, "secret")
	traversal := filepath.Join(logDir, "..", filepath.Base(filepath.Dir(outside)), "secret.txt")
	if _, ok := resolveLogPath(traversal); ok {
		t.Errorf("traversal path %q must be rejected", traversal)
	}
	if _, ok := resolveLogPath(outside); ok {
		t.Errorf("outside path %q must be rejected", outside)
	}

	// The log dir itself is not a regular file.
	if _, ok := resolveLogPath(logDir); ok {
		t.Error("the log directory must not resolve as a file")
	}
	if _, ok := resolveLogPath(""); ok {
		t.Error("empty path must be rejected")
	}
}

// TestListSessionLogs verifies the list gathers this project's server logs, its
// per-conversation logs, and the shared app.log — grouped correctly, sorted,
// and skipping files that don't exist.
func TestListSessionLogs(t *testing.T) {
	logDir := t.TempDir()
	t.Setenv("JUGGLER_LOG_DIR", logDir)

	project := "/Users/someone/code/myproj"
	projDir := logpaths.ProjectLogDir(project)

	// server.log exists; server.stderr.log intentionally does not (skipped).
	writeLog(t, filepath.Join(projDir, "server.log"), "srv")
	writeLog(t, filepath.Join(projDir, "conversations", "conv_bbb.log"), "b")
	writeLog(t, filepath.Join(projDir, "conversations", "conv_aaa.log"), "aa")
	writeLog(t, logpaths.AppLogPath(), "app-log")

	files := listSessionLogs(project)

	byName := map[string]logFileInfo{}
	for _, f := range files {
		byName[f.Name] = f
	}

	if _, ok := byName["server.stderr.log"]; ok {
		t.Error("server.stderr.log does not exist and must be omitted")
	}
	if f, ok := byName["server.log"]; !ok || f.Group != "server" || f.Size != 3 {
		t.Errorf("server.log: got %+v (ok=%v)", f, ok)
	}
	if f, ok := byName["app.log"]; !ok || f.Group != "app" {
		t.Errorf("app.log: got %+v (ok=%v)", f, ok)
	}
	for _, n := range []string{"conv_aaa.log", "conv_bbb.log"} {
		if f, ok := byName[n]; !ok || f.Group != "conversations" {
			t.Errorf("%s: got %+v (ok=%v)", n, f, ok)
		}
	}

	// Conversation logs come back in sorted order (aaa before bbb).
	var convOrder []string
	for _, f := range files {
		if f.Group == "conversations" {
			convOrder = append(convOrder, f.Name)
		}
	}
	if len(convOrder) != 2 || convOrder[0] != "conv_aaa.log" || convOrder[1] != "conv_bbb.log" {
		t.Errorf("conversation logs not sorted: %v", convOrder)
	}
}

// TestReadLogWindow covers the four tailing cases: whole-file first read, capped
// first read, incremental append, and post-rotation reset.
func TestReadLogWindow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.log")

	// Whole small file on the first read (offset 0, no cap hit).
	writeLog(t, path, "hello")
	win, err := readLogWindow(path, 0, 100)
	if err != nil {
		t.Fatalf("initial read: %v", err)
	}
	if win.Content != "hello" || win.From != 0 || win.Size != 5 || win.Replaced {
		t.Errorf("whole-file read: got %+v", win)
	}

	// Capped first read returns only the trailing maxInitial bytes, replacing.
	writeLog(t, path, "0123456789ABCDE") // 15 bytes
	win, err = readLogWindow(path, 0, 10)
	if err != nil {
		t.Fatalf("capped read: %v", err)
	}
	if win.Content != "56789ABCDE" || win.From != 5 || win.Size != 15 || !win.Replaced {
		t.Errorf("capped read: got %+v", win)
	}

	// Incremental append: from the last seen offset, only new bytes, appended.
	writeLog(t, path, "helloworld")
	win, err = readLogWindow(path, 5, 100)
	if err != nil {
		t.Fatalf("incremental read: %v", err)
	}
	if win.Content != "world" || win.From != 5 || win.Size != 10 || win.Replaced {
		t.Errorf("incremental read: got %+v", win)
	}

	// Rotation: a stale offset past EOF resets to a fresh window, replacing.
	win, err = readLogWindow(path, 999, 100)
	if err != nil {
		t.Fatalf("rotation read: %v", err)
	}
	if win.Content != "helloworld" || win.From != 0 || win.Size != 10 || !win.Replaced {
		t.Errorf("rotation read: got %+v", win)
	}
}
