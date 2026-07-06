//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// TestConfiguredClaudeBinary_IgnoresNonExecutableStoreValue is Unix-only: it
// constructs a "non-executable" settings-panel value by withholding the +x
// permission bit, then asserts the resolver ignores it. That premise has no
// Windows analogue — Windows has no +x bit (isExecutableFile is `!IsDir()`), so
// a plain 0644 file is considered runnable and the assertion can't hold there.
func TestConfiguredClaudeBinary_IgnoresNonExecutableStoreValue(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(claudePathEnvVar, "")
	bogus := filepath.Join(t.TempDir(), "claude.txt")
	if err := os.WriteFile(bogus, []byte("not a binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetRawKey(BinaryPathCredKey, bogus); err != nil {
		t.Fatal(err)
	}

	if got := configuredClaudeBinary(); got == bogus {
		t.Fatalf("non-executable store value must be ignored, got %q", got)
	}
}
