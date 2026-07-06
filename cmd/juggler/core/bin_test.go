//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
)

// newStoreForTest returns a FileSessionStore rooted at a fresh temp project
// with an empty session saved so Load() succeeds.
func newStoreForTest(t *testing.T) (*FileSessionStore, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	return store, dir
}

// binnedDirFor scans .juggler/trash and returns the on-disk folder path for id.
func binnedDirFor(t *testing.T, projectDir, id string) string {
	t.Helper()
	idx, err := ScanConvDirs(filepath.Join(projectDir, ".juggler", "trash"))
	if err != nil {
		t.Fatalf("scan trash dir: %v", err)
	}
	dir, ok := idx.ByID[id]
	if !ok {
		t.Fatalf("conversation %s not found under .juggler/trash", id)
	}
	return dir
}

// Binning a conversation moves its folder out of the active set and into
// .juggler/bin/, where it lingers indefinitely (no auto-expiry) until restored
// or emptied.
func TestBinConversationMovesToBin(t *testing.T) {
	store, dir := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}

	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}

	// Folder physically left .juggler/ for .juggler/bin/.
	if _, ok := store.ConvDir(id); ok {
		t.Fatalf("expected %s to be absent from the active index after binning", id)
	}
	binnedDir := binnedDirFor(t, dir, id)
	if _, err := os.Stat(binnedDir); err != nil {
		t.Fatalf("binned folder missing: %v", err)
	}

	list := store.BinnedConvList()
	if len(list) != 1 {
		t.Fatalf("BinnedConvList len = %d, want 1", len(list))
	}
	if row := list[0]; row.ID != id || row.Name != "Alpha" {
		t.Fatalf("row = %+v, want id=%s name=Alpha", row, id)
	}
}

// Restoring a binned conversation moves its folder back into the active set,
// intact, and clears it from the bin — the "fish it back out" path.
func TestRestoreConversationRoundTrip(t *testing.T) {
	store, _ := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Beta", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}
	if err := store.RestoreConversation(id); err != nil {
		t.Fatalf("RestoreConversation: %v", err)
	}

	// Back in the active index, gone from the bin listing.
	if _, ok := store.ConvDir(id); !ok {
		t.Fatalf("expected %s back in the active index after restore", id)
	}
	if list := store.BinnedConvList(); len(list) != 0 {
		t.Fatalf("BinnedConvList = %+v, want empty after restore", list)
	}
}

// EmptyBin removes every binned conversation; restored ones are untouched.
func TestEmptyBin(t *testing.T) {
	store, _ := newStoreForTest(t)

	for _, name := range []string{"One", "Two"} {
		id, _, _, err := store.CreateConversationFolder(name, "")
		if err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
		if err := store.BinConversation(id); err != nil {
			t.Fatalf("BinConversation(%s): %v", name, err)
		}
	}
	if list := store.BinnedConvList(); len(list) != 2 {
		t.Fatalf("BinnedConvList len = %d, want 2 before empty", len(list))
	}

	removed, err := store.EmptyBin()
	if err != nil {
		t.Fatalf("EmptyBin: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("EmptyBin removed %d, want 2", len(removed))
	}
	if list := store.BinnedConvList(); len(list) != 0 {
		t.Fatalf("BinnedConvList = %+v, want empty after EmptyBin", list)
	}
}
