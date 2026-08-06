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

// TestMutationResultsReturnContentHash asserts that loadFile, getFileHash,
// writeFile, and editFile (dryRun + real) all report a consistent contentHash —
// the staleness baseline the JS edit tool uses to refuse an edit whose target
// changed since the model last read it. The invariants: read == getFileHash;
// editFile dryRun == the current (pre-edit) hash; editFile/writeFile results ==
// a fresh getFileHash of the bytes they just wrote.
func TestMutationResultsReturnContentHash(t *testing.T) {
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	const name = "hash.txt"
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, []byte("alpha\nbeta\ngamma\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	hashOf := func(op string, params map[string]any) string {
		t.Helper()
		res, err := ops.Execute(context.Background(), op, params)
		if err != nil {
			t.Fatalf("%s: %v", op, err)
		}
		m, ok := res.(map[string]any)
		if !ok {
			t.Fatalf("%s: result not a map: %T", op, res)
		}
		h, ok := m["contentHash"].(string)
		if !ok || h == "" {
			t.Fatalf("%s: missing contentHash in %v", op, m)
		}
		return h
	}

	readHash := hashOf("loadFile", map[string]any{"path": name})
	if fileHash := hashOf("getFileHash", map[string]any{"path": name}); fileHash != readHash {
		t.Fatalf("loadFile hash %s != getFileHash %s", readHash, fileHash)
	}

	// dryRun edit reports the CURRENT (pre-edit) file hash as the baseline.
	if dryHash := hashOf("editFile", map[string]any{"path": name, "old_str": "beta", "new_str": "BETA", "dryRun": true}); dryHash != readHash {
		t.Fatalf("editFile dryRun hash %s != current file hash %s", dryHash, readHash)
	}

	// Real edit reports the POST-edit hash, matching a fresh getFileHash.
	editHash := hashOf("editFile", map[string]any{"path": name, "old_str": "beta", "new_str": "BETA"})
	if postHash := hashOf("getFileHash", map[string]any{"path": name}); editHash != postHash {
		t.Fatalf("editFile result hash %s != post-edit getFileHash %s", editHash, postHash)
	}
	if editHash == readHash {
		t.Fatalf("edit did not change the content hash")
	}

	// writeFile reports the hash of the exact bytes it wrote.
	writeHash := hashOf("writeFile", map[string]any{"path": name, "content": "brand new\n"})
	if postWrite := hashOf("getFileHash", map[string]any{"path": name}); writeHash != postWrite {
		t.Fatalf("writeFile result hash %s != getFileHash %s", writeHash, postWrite)
	}
}

// TestMutationsRejectStaleExpectedHash asserts that editFile, editFileLines,
// and writeFile refuse to mutate when the caller's expectedHash (the baseline
// its approved preview was computed against) no longer matches the file's
// on-disk bytes — the file changed between preview and write — and that a
// matching expectedHash lets the mutation proceed. A refused mutation must
// leave the file untouched. writeFile with an expectedHash for a file that was
// deleted in the interim simply creates it (nothing would be destroyed).
func TestMutationsRejectStaleExpectedHash(t *testing.T) {
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	const name = "staleness.txt"
	const seed = "alpha\nbeta\ngamma\n"
	abs := filepath.Join(dir, name)
	if err := os.WriteFile(abs, []byte(seed), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	currentHash := func() string {
		t.Helper()
		res, err := ops.Execute(context.Background(), "getFileHash", map[string]any{"path": name})
		if err != nil {
			t.Fatalf("getFileHash: %v", err)
		}
		return res.(map[string]any)["contentHash"].(string)
	}

	requireUnchanged := func() {
		t.Helper()
		got, err := os.ReadFile(abs)
		if err != nil {
			t.Fatalf("read back: %v", err)
		}
		if string(got) != seed {
			t.Fatalf("file mutated despite stale expectedHash: %q", string(got))
		}
	}

	const stale = "0000000000000000000000000000000000000000000000000000000000000000"

	for _, tc := range []struct {
		op     string
		params map[string]any
	}{
		{"editFile", map[string]any{"path": name, "old_str": "beta", "new_str": "BETA", "expectedHash": stale}},
		{"editFileLines", map[string]any{"path": name, "startLine": float64(2), "endLine": float64(2), "newContent": "BETA", "expectedHash": stale}},
		{"writeFile", map[string]any{"path": name, "content": "clobbered\n", "expectedHash": stale}},
	} {
		if _, err := ops.Execute(context.Background(), tc.op, tc.params); err == nil {
			t.Fatalf("%s: expected stale expectedHash to be rejected, got nil", tc.op)
		}
		requireUnchanged()
	}

	// A matching expectedHash lets the edit through.
	if _, err := ops.Execute(context.Background(), "editFile", map[string]any{
		"path": name, "old_str": "beta", "new_str": "BETA", "expectedHash": currentHash(),
	}); err != nil {
		t.Fatalf("editFile with matching expectedHash: %v", err)
	}

	// expectedHash for a since-deleted file: the write creates it.
	if err := os.Remove(abs); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := ops.Execute(context.Background(), "writeFile", map[string]any{
		"path": name, "content": "recreated\n", "expectedHash": stale,
	}); err != nil {
		t.Fatalf("writeFile after delete: %v", err)
	}
	if got, err := os.ReadFile(abs); err != nil || string(got) != "recreated\n" {
		t.Fatalf("recreate failed: %q, %v", string(got), err)
	}
}

// TestEditFileFlexibleMatchRejectsAmbiguous asserts that when the exact match
// fails and the flexible-whitespace fallback (strategy 2) finds the old_str in
// more than one place, the edit is REFUSED rather than silently rewriting the
// first hit — the failure mode that corrupts a file when the model's old_str is
// stale/imprecise. Mirrors the ambiguity guard the exact and regex strategies
// already enforce.
func TestEditFileFlexibleMatchRejectsAmbiguous(t *testing.T) {
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	const name = "ambig.txt"
	abs := filepath.Join(dir, name)
	// Two regions identical after per-line whitespace trimming but with
	// different indentation, so the exact substring match fails and the
	// flexible-whitespace strategy is what finds them — in two places.
	seed := "start\n        do_a()\n        do_b()\nmiddle\n    do_a()\n    do_b()\nend\n"
	if err := os.WriteFile(abs, []byte(seed), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := ops.Execute(context.Background(), "editFile", map[string]any{
		"path":    name,
		"old_str": "do_a()\ndo_b()",
		"new_str": "REPLACED",
	}); err == nil {
		t.Fatal("expected ambiguous flexible-whitespace match to be rejected, got nil")
	}

	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != seed {
		t.Fatalf("file mutated despite ambiguous edit: %q", string(got))
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

// TestEditPreservesCRLF asserts that editing a pure-CRLF (Windows) file rewrites
// only the edited region and leaves every other line's CRLF ending intact,
// rather than silently normalizing the whole file to LF. It also checks that the
// echoed post-write contentHash matches a fresh getFileHash (over the real
// CRLF-restored bytes), so a follow-up edit's staleness guard doesn't misfire; a
// mixed-ending file is left LF-normalized because there's no single ending to
// restore.
func TestEditPreservesCRLF(t *testing.T) {
	dir := t.TempDir()
	ops := NewFileOperations(NewPathScope(dir, nil))

	fileHash := func(name string) string {
		t.Helper()
		res, err := ops.Execute(context.Background(), "getFileHash", map[string]any{"path": name})
		if err != nil {
			t.Fatalf("getFileHash: %v", err)
		}
		return res.(map[string]any)["contentHash"].(string)
	}

	t.Run("editFile keeps CRLF and reports a matching hash", func(t *testing.T) {
		const name = "crlf.txt"
		abs := filepath.Join(dir, name)
		if err := os.WriteFile(abs, []byte("alpha\r\nbeta\r\ngamma\r\n"), 0o644); err != nil {
			t.Fatalf("seed: %v", err)
		}
		res, err := ops.Execute(context.Background(), "editFile", map[string]any{
			"path": name, "old_str": "beta", "new_str": "BETA",
		})
		if err != nil {
			t.Fatalf("editFile: %v", err)
		}
		got, err := os.ReadFile(abs)
		if err != nil {
			t.Fatalf("read back: %v", err)
		}
		if string(got) != "alpha\r\nBETA\r\ngamma\r\n" {
			t.Fatalf("CRLF not preserved: %q", string(got))
		}
		if h := res.(map[string]any)["contentHash"].(string); h != fileHash(name) {
			t.Fatalf("editFile contentHash %s != getFileHash %s", h, fileHash(name))
		}
		// A follow-up edit on the same file must not trip the staleness guard.
		if _, err := ops.Execute(context.Background(), "editFile", map[string]any{
			"path": name, "old_str": "gamma", "new_str": "GAMMA",
		}); err != nil {
			t.Fatalf("consecutive editFile: %v", err)
		}
		if got, _ := os.ReadFile(abs); string(got) != "alpha\r\nBETA\r\nGAMMA\r\n" {
			t.Fatalf("second CRLF edit wrong: %q", string(got))
		}
	})

	t.Run("editFileLines keeps CRLF", func(t *testing.T) {
		const name = "crlf-lines.txt"
		abs := filepath.Join(dir, name)
		if err := os.WriteFile(abs, []byte("alpha\r\nbeta\r\ngamma\r\n"), 0o644); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, err := ops.Execute(context.Background(), "editFileLines", map[string]any{
			"path": name, "startLine": float64(2), "endLine": float64(2), "newContent": "BETA",
		}); err != nil {
			t.Fatalf("editFileLines: %v", err)
		}
		if got, _ := os.ReadFile(abs); string(got) != "alpha\r\nBETA\r\ngamma\r\n" {
			t.Fatalf("CRLF not preserved by editFileLines: %q", string(got))
		}
	})

	t.Run("mixed endings are left LF-normalized", func(t *testing.T) {
		const name = "mixed.txt"
		abs := filepath.Join(dir, name)
		if err := os.WriteFile(abs, []byte("alpha\r\nbeta\ngamma\r\n"), 0o644); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, err := ops.Execute(context.Background(), "editFile", map[string]any{
			"path": name, "old_str": "beta", "new_str": "BETA",
		}); err != nil {
			t.Fatalf("editFile: %v", err)
		}
		if got, _ := os.ReadFile(abs); string(got) != "alpha\nBETA\ngamma\n" {
			t.Fatalf("mixed file not LF-normalized: %q", string(got))
		}
	})
}
