//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestWriteFilePreservesMode asserts that a full rewrite of an existing file
// keeps that file's permission bits rather than resetting them to 0644. A new
// file still gets 0644.
func TestWriteFilePreservesMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits (0755/0600/0644) are not represented on Windows; os.Stat reports 0666")
	}
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	t.Run("overwrite preserves existing mode", func(t *testing.T) {
		const name = "script.sh"
		abs := filepath.Join(dir, name)
		if err := os.WriteFile(abs, []byte("#!/bin/sh\necho old\n"), 0o755); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, err := ops.Execute(context.Background(), "writeFile", map[string]any{
			"path":    name,
			"content": "#!/bin/sh\necho new\n",
		}); err != nil {
			t.Fatalf("writeFile: %v", err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o755 {
			t.Fatalf("mode after overwrite = %o, want 0755", got)
		}
	})

	t.Run("overwrite preserves tightened mode", func(t *testing.T) {
		const name = "secret.txt"
		abs := filepath.Join(dir, name)
		if err := os.WriteFile(abs, []byte("old"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, err := ops.Execute(context.Background(), "writeFile", map[string]any{
			"path":    name,
			"content": "new",
		}); err != nil {
			t.Fatalf("writeFile: %v", err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("mode after overwrite = %o, want 0600", got)
		}
	})

	t.Run("new file gets 0644", func(t *testing.T) {
		const name = "fresh.txt"
		abs := filepath.Join(dir, name)
		if _, err := ops.Execute(context.Background(), "writeFile", map[string]any{
			"path":    name,
			"content": "hello",
		}); err != nil {
			t.Fatalf("writeFile: %v", err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o644 {
			t.Fatalf("mode of new file = %o, want 0644", got)
		}
	})
}

// TestEditFileRejectsIdenticalOldNewStr asserts that an edit where old_str and
// new_str are identical is rejected as an error rather than silently rewriting
// the file with unchanged content and reporting success. The check fires before
// dryRun too, so the JS approval plugin's validate() rejects it before an
// approval modal is ever shown.
func TestEditFileRejectsIdenticalOldNewStr(t *testing.T) {
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	const name = "file.txt"
	abs := filepath.Join(dir, name)
	seed := "line one\nline two\nline three\n"
	if err := os.WriteFile(abs, []byte(seed), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Same content under both the normal and dryRun paths.
	for _, dryRun := range []bool{false, true} {
		_, err := ops.Execute(context.Background(), "editFile", map[string]any{
			"path":    name,
			"old_str": "line two",
			"new_str": "line two",
			"dryRun":  dryRun,
		})
		if err == nil {
			t.Fatalf("dryRun=%v: expected editFile with identical old_str/new_str to fail, got nil", dryRun)
		}
	}

	// The file must be untouched (the non-dryRun call must not have written).
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != seed {
		t.Fatalf("file mutated despite rejected edit: %q", string(got))
	}
}

// TestWriteEditFailOnReadOnlyDir asserts that an OS-level write failure (EACCES
// from a read-only parent directory) is surfaced as a non-nil error from both
// writeFile and editFile, rather than silently swallowed — and that a failed
// mutation leaves the original file untouched. The atomic temp-file+rename
// write needs a writable *directory*, so a read-only dir is the reliable
// trigger (a read-only file alone is still replaceable via rename).
func TestWriteEditFailOnReadOnlyDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX directory permission bits don't gate writes the same way on Windows")
	}
	if os.Getuid() == 0 {
		t.Skip("root bypasses directory permission bits")
	}

	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	roDir := filepath.Join(dir, "readonly")
	if err := os.Mkdir(roDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	existing := filepath.Join(roDir, "file.txt")
	if err := os.WriteFile(existing, []byte("hello world\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Make the parent directory read-only so the temp-file create inside it
	// fails with EACCES. Restore perms in cleanup so t.TempDir can remove it.
	if err := os.Chmod(roDir, 0o555); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(roDir, 0o755) })

	t.Run("writeFile overwrite", func(t *testing.T) {
		if _, err := ops.Execute(context.Background(), "writeFile", map[string]any{
			"path":    existing,
			"content": "new content",
		}); err == nil {
			t.Fatal("expected writeFile into a read-only directory to fail, got nil")
		}
	})

	t.Run("editFile", func(t *testing.T) {
		if _, err := ops.Execute(context.Background(), "editFile", map[string]any{
			"path":    existing,
			"old_str": "world",
			"new_str": "there",
		}); err == nil {
			t.Fatal("expected editFile in a read-only directory to fail, got nil")
		}
	})

	// The original file must be untouched after both failed mutations.
	got, err := os.ReadFile(existing)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "hello world\n" {
		t.Fatalf("file mutated despite failed writes: %q", string(got))
	}
}
