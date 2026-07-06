//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestOSResolvePath covers the resolve+exist gate the open/reveal commands run
// before launching anything. The actual launch shells out to a GUI handler and
// is not exercised here.
func TestOSResolvePath(t *testing.T) {
	dir := t.TempDir()
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", dir, err)
	}
	fileName := "note.txt"
	abs := filepath.Join(realDir, fileName)
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	o := NewOSOperations(NewPathScope(realDir, nil))

	t.Run("relative path resolves against workingDir", func(t *testing.T) {
		got, err := o.resolvePath(map[string]any{"path": fileName})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != abs {
			t.Fatalf("got %q, want %q", got, abs)
		}
	})

	t.Run("absolute path passes through", func(t *testing.T) {
		got, err := o.resolvePath(map[string]any{"path": abs})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != abs {
			t.Fatalf("got %q, want %q", got, abs)
		}
	})

	t.Run("missing path param errors", func(t *testing.T) {
		if _, err := o.resolvePath(map[string]any{}); err == nil {
			t.Fatal("expected error for missing path")
		}
	})

	t.Run("nonexistent path errors", func(t *testing.T) {
		if _, err := o.resolvePath(map[string]any{"path": "does-not-exist.txt"}); err == nil {
			t.Fatal("expected error for nonexistent path")
		}
	})

	t.Run("unknown operation errors", func(t *testing.T) {
		if _, err := o.Execute(context.Background(), "frobnicate", map[string]any{"path": abs}); err == nil {
			t.Fatal("expected error for unknown operation")
		}
	})
}
