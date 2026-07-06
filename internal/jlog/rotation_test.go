//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jlog

import (
	"os"
	"path/filepath"
	"testing"
)

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return fi.Size()
}

func mustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Errorf("expected %s not to exist", path)
	}
}

// Writing past the cap rotates: the current file is renamed to .1 and a fresh
// (empty-then-written) main file takes over.
func TestRotatesWhenWritePastCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.log")
	w, err := newRotatingWriter(path, 100, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if _, err := w.Write(make([]byte, 60)); err != nil {
		t.Fatal(err)
	}
	if got := fileSize(t, path); got != 60 {
		t.Fatalf("after first write size = %d, want 60 (no rotation yet)", got)
	}
	// 60 + 60 > 100 → rotate before writing.
	if _, err := w.Write(make([]byte, 60)); err != nil {
		t.Fatal(err)
	}
	if got := fileSize(t, path+".1"); got != 60 {
		t.Errorf(".1 size = %d, want 60 (the rotated-out content)", got)
	}
	if got := fileSize(t, path); got != 60 {
		t.Errorf("main size = %d, want 60 (the post-rotation write)", got)
	}
}

// MaxBackups is enforced: only N backups are kept and the oldest is dropped.
func TestRotateEnforcesMaxBackups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.log")
	w, err := newRotatingWriter(path, 10, 2) // tiny cap, keep 2 backups
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	// Each 11-byte write exceeds the 10-byte cap, forcing a rotation on every
	// write after the first. Distinct markers let us verify drop ordering.
	markers := []string{"AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"}
	for _, m := range markers {
		if _, err := w.Write([]byte(m)); err != nil {
			t.Fatal(err)
		}
	}

	// Only main + .1 + .2 may exist; .3 must have been dropped.
	mustNotExist(t, path+".3")

	// Newest-first: main=D, .1=C, .2=B, and A (oldest) is gone.
	read := func(p string) string {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		return string(b)
	}
	if got := read(path); got != "DDDDDDDDDDD" {
		t.Errorf("main = %q, want D run", got)
	}
	if got := read(path + ".1"); got != "CCCCCCCCCCC" {
		t.Errorf(".1 = %q, want C run", got)
	}
	if got := read(path + ".2"); got != "BBBBBBBBBBB" {
		t.Errorf(".2 = %q, want B run", got)
	}
}

// An already-oversized file is rotated at open, before any write.
func TestRotateAtOpenOnOversizedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.log")
	if err := os.WriteFile(path, make([]byte, 200), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err := newRotatingWriter(path, 100, 3) // 200 > 100 → rotate at open
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if got := fileSize(t, path+".1"); got != 200 {
		t.Errorf(".1 size = %d, want 200 (rotated-out original)", got)
	}
	if got := fileSize(t, path); got != 0 {
		t.Errorf("main size = %d, want 0 (fresh after rotate-at-open)", got)
	}
}

// maxBytes <= 0 disables rotation entirely (file grows unbounded, append mode
// preserves prior content across opens).
func TestNoRotationWhenCapDisabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "host.log")
	w, err := newRotatingWriter(path, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(make([]byte, 5000)); err != nil {
		t.Fatal(err)
	}
	w.Close()
	mustNotExist(t, path+".1")
	if got := fileSize(t, path); got != 5000 {
		t.Errorf("size = %d, want 5000 (no rotation)", got)
	}
}
