//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A per-conversation Logger writes to its own file; Rename moves that file (and
// continues writing there); Close flushes and stops the actor.
func TestLoggerWriteRenameClose(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "conv_abc123xyz.log")
	newPath := filepath.Join(dir, "My Tab--conv_abc123xyz.log")

	l := NewLogger(oldPath, 10, 5)
	l.Info("first line %d", 1)
	l.Rename(newPath)
	l.Info("second line %d", 2)
	l.Close()

	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Errorf("old path %q should have been renamed away (err=%v)", oldPath, err)
	}
	b, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("read renamed log %q: %v", newPath, err)
	}
	content := string(b)
	if !strings.Contains(content, "first line 1") {
		t.Errorf("renamed log missing pre-rename line: %q", content)
	}
	if !strings.Contains(content, "second line 2") {
		t.Errorf("renamed log missing post-rename line: %q", content)
	}
	// Lines are level-tagged like the process sink.
	if !strings.Contains(content, "[INFO]") {
		t.Errorf("renamed log missing level tag: %q", content)
	}
}

// A nil *Logger is a valid no-op handle: every method must be safe to call.
func TestNilLoggerIsSafe(t *testing.T) {
	var l *Logger
	l.Info("info %d", 1)
	l.Debug("debug")
	l.Trace("trace")
	l.Error("error")
	l.Tool("tool", "summary")
	l.Rename("/tmp/whatever.log")
	l.Close()
}

// Rename to the same path (or empty) is a harmless no-op that keeps writing.
func TestLoggerRenameNoopPaths(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "conv_x.log")
	l := NewLogger(p, 10, 5)
	l.Info("before")
	l.Rename(p)  // same path
	l.Rename("") // empty
	l.Info("after")
	l.Close()

	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %q: %v", p, err)
	}
	if c := string(b); !strings.Contains(c, "before") || !strings.Contains(c, "after") {
		t.Errorf("log lost lines across no-op renames: %q", c)
	}
}
