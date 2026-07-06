//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCopyFileIfExists covers the server-side duplicate's file copy: a present
// source is copied byte-for-byte, and a missing source is a no-op (a source
// that has never persisted yields a legitimately empty clone, not an error).
func TestCopyFileIfExists(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "doc.yjs")
	dst := filepath.Join(dir, "clone", "doc.yjs")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}

	want := []byte("yjs-binary-state-\x00\x01\x02")
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyFileIfExists(src, dst); err != nil {
		t.Fatalf("copyFileIfExists: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dst: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("copied %q, want %q", got, want)
	}

	// Missing source is a no-op (no error, no dst created).
	missingDst := filepath.Join(dir, "clone", "absent.yjs")
	if err := copyFileIfExists(filepath.Join(dir, "absent.yjs"), missingDst); err != nil {
		t.Errorf("missing source should be a no-op, got %v", err)
	}
	if _, err := os.Stat(missingDst); !os.IsNotExist(err) {
		t.Error("no-op copy should not create the destination")
	}
}

// TestCopyDirContents covers the txns/ blob copy: every flat file is copied and
// a missing source directory is a no-op.
func TestCopyDirContents(t *testing.T) {
	dir := t.TempDir()
	srcTxns := filepath.Join(dir, "src", "txns")
	dstTxns := filepath.Join(dir, "clone", "txns")
	if err := os.MkdirAll(srcTxns, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"txn_1.json": `{"a":1}`,
		"txn_2.json": `{"b":2}`,
		"txn_3.json": `{"c":3}`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(srcTxns, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := copyDirContents(srcTxns, dstTxns); err != nil {
		t.Fatalf("copyDirContents: %v", err)
	}
	for name, body := range files {
		got, err := os.ReadFile(filepath.Join(dstTxns, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if string(got) != body {
			t.Errorf("%s = %q, want %q", name, got, body)
		}
	}

	// Missing source directory is a no-op (source had no txns).
	if err := copyDirContents(filepath.Join(dir, "nope"), filepath.Join(dir, "clone2", "txns")); err != nil {
		t.Errorf("missing source dir should be a no-op, got %v", err)
	}
}
