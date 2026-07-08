//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// TestIsExecutablePath_WindowsAnyRegularFileAccepted verifies that on Windows
// any regular file is considered executable. Windows has no Unix +x bit:
// isExecutableFile checks !IsDir() only.
func TestIsExecutablePath_WindowsAnyRegularFileAccepted(t *testing.T) {
	f := filepath.Join(t.TempDir(), "claude.exe")
	if err := os.WriteFile(f, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !isExecutablePath(f) {
		t.Fatalf("isExecutablePath(%q) = false, want true on Windows for any regular file", f)
	}
}

// TestIsExecutablePath_WindowsDirectoryRejected verifies that a directory is
// not treated as an executable path on Windows.
func TestIsExecutablePath_WindowsDirectoryRejected(t *testing.T) {
	dir := t.TempDir()
	if isExecutablePath(dir) {
		t.Fatalf("isExecutablePath(%q) = true for a directory, want false", dir)
	}
}

// TestIsExecutablePath_WindowsMissingPathRejected verifies that a nonexistent
// path is not accepted as an executable.
func TestIsExecutablePath_WindowsMissingPathRejected(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist.exe")
	if isExecutablePath(missing) {
		t.Fatalf("isExecutablePath(%q) = true for missing path, want false", missing)
	}
}

// TestIsExecutablePath_WindowsSymlinks verifies symlink behaviour: a symlink
// to a real file must be accepted, and a dangling symlink must be rejected.
// Symlink creation on Windows requires Developer Mode or an elevated process;
// the test skips when os.Symlink returns a permission error.
func TestIsExecutablePath_WindowsSymlinks(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "claude-real.exe")
	if err := os.WriteFile(real, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "claude.exe")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink creation unavailable (requires Developer Mode or elevation): %v", err)
	}
	if !isExecutablePath(link) {
		t.Fatalf("isExecutablePath(%q -> %q) = false, want true", link, real)
	}

	dangling := filepath.Join(dir, "claude-dangling.exe")
	if err := os.Symlink(filepath.Join(dir, "gone.exe"), dangling); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if isExecutablePath(dangling) {
		t.Fatalf("isExecutablePath(%q -> missing) = true, want false", dangling)
	}
}

// TestResolve_WindowsSymlinkedClaudeAccepted verifies that a symlink to a
// real file is accepted as a valid JUGGLER_CLAUDE_PATH override. Skips when
// symlink creation is not available on this Windows installation.
func TestResolve_WindowsSymlinkedClaudeAccepted(t *testing.T) {
	userpathstest.Isolate(t)
	dir := t.TempDir()
	real := filepath.Join(dir, "claude-real.exe")
	if err := os.WriteFile(real, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "claude.exe")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink creation unavailable (requires Developer Mode or elevation): %v", err)
	}
	t.Setenv(claudePathEnvVar, link)
	if got := claudeBinary(); got != link {
		t.Fatalf("claudeBinary() with symlink override = %q, want %q", got, link)
	}
}
