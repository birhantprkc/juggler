//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package userpathstest provides the single test helper for isolating Juggler's
// per-user config directory. It lives apart from userpaths so importing the
// testing package never leaks into the production binary.
package userpathstest

import "testing"

// Isolate points HOME (and USERPROFILE, for Windows parity) at a fresh temp dir
// and clears any ambient JUGGLER_CONFIG_DIR so the test resolves its own
// ~/.juggler via userpaths.ConfigDir. CI sets JUGGLER_CONFIG_DIR globally to
// isolate runs; without clearing it, every test in a package would share that
// one directory and bleed state into each other. Returns the home dir.
func Isolate(t testing.TB) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("JUGGLER_CONFIG_DIR", "")
	return home
}
