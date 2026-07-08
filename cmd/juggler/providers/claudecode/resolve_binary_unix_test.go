//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// TestClaudeBinary_NonExecutableOverrideIgnored is Unix-only: it constructs a
// "non-executable" file by withholding the +x permission bit, then asserts the
// resolver rejects it. That premise has no Windows analogue — Windows has no
// +x bit (isExecutableFile is `!IsDir()`), so a plain 0644 file is considered
// runnable and the assertion can't hold there.
func TestClaudeBinary_NonExecutableOverrideIgnored(t *testing.T) {
	// An override that isn't a runnable file must not be returned; resolution
	// falls through to the normal search.
	userpathstest.Isolate(t)
	t.Setenv("SHELL", "")
	bogus := filepath.Join(t.TempDir(), "not-exec")
	if err := os.WriteFile(bogus, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudePathEnvVar, bogus)

	if got := claudeBinary(); got == bogus {
		t.Fatalf("claudeBinary() returned the non-executable override %q", got)
	}
}

// A symlink to a real executable must be accepted (os.Stat follows it), and a
// dangling symlink must be rejected. This covers the standard installs whose
// `claude` on PATH is a symlink (npm/nvm shims, homebrew, the native installer
// into ~/.local/bin).
func TestIsExecutablePath_Symlinks(t *testing.T) {
	dir := t.TempDir()
	real := writeExecutable(t, dir, "claude-real")

	link := filepath.Join(dir, "claude")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if !isExecutablePath(link) {
		t.Fatalf("isExecutablePath(%q -> %q) = false, want true", link, real)
	}

	dangling := filepath.Join(dir, "claude-dangling")
	if err := os.Symlink(filepath.Join(dir, "gone"), dangling); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if isExecutablePath(dangling) {
		t.Fatalf("isExecutablePath(%q -> missing) = true, want false", dangling)
	}
}

// The env override and login-shell probe both accept a symlinked claude.
func TestResolve_SymlinkedClaudeAccepted(t *testing.T) {
	userpathstest.Isolate(t)
	dir := t.TempDir()
	real := writeExecutable(t, dir, "claude-real")
	link := filepath.Join(dir, "claude")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	t.Setenv("SHELL", "")
	t.Setenv(claudePathEnvVar, link)
	if got := claudeBinary(); got != link {
		t.Fatalf("claudeBinary() with symlink override = %q, want %q", got, link)
	}
}
