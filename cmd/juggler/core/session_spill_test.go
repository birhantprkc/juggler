//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBinConversationRemovesSpillDir verifies binning a conversation deletes its
// full-output spill directory under .juggler/bash-output/ — spills are
// recoverable command output, not conversation state, so they go with it.
func TestBinConversationRemovesSpillDir(t *testing.T) {
	store, dir := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}

	spillDir := filepath.Join(dir, ".juggler", "bash-output", id)
	if err := os.MkdirAll(spillDir, 0o755); err != nil {
		t.Fatalf("mkdir spill dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(spillDir, "x.log"), []byte("out"), 0o644); err != nil {
		t.Fatalf("write spill file: %v", err)
	}

	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}

	if _, err := os.Stat(spillDir); !os.IsNotExist(err) {
		t.Fatalf("expected spill dir %s to be gone, stat err = %v", spillDir, err)
	}
}
