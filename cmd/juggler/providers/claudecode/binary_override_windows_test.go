//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package claudecode

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// TestConfiguredClaudeBinary_AcceptsRegularFile verifies that on Windows any
// regular file stored in the credentials store is returned by
// configuredClaudeBinary. Windows has no Unix execute-permission bit:
// isExecutableFile checks !IsDir() only, so any regular file qualifies. This
// is the Windows complement of the Unix-only
// TestConfiguredClaudeBinary_IgnoresNonExecutableStoreValue, which asserts the
// opposite: that a file without the +x bit is REJECTED.
func TestConfiguredClaudeBinary_AcceptsRegularFile(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(claudePathEnvVar, "")
	plain := filepath.Join(t.TempDir(), "claude.exe")
	if err := os.WriteFile(plain, []byte("not a real binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := core.NewCredentialsStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetRawKey(BinaryPathCredKey, plain); err != nil {
		t.Fatal(err)
	}

	if got := configuredClaudeBinary(); got != plain {
		t.Fatalf("Windows: regular file in store should be accepted, got %q, want %q", got, plain)
	}
}
