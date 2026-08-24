//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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

// BinSizeBytes tallies the on-disk size of everything under .juggler/trash/:
// zero for an empty bin (no trash dir yet), non-trivial once a conversation
// carrying a known payload is binned, and back to zero after EmptyBin.
func TestBinSizeBytesReflectsContents(t *testing.T) {
	store, _ := newStoreForTest(t)

	if got := store.BinSizeBytes(); got != 0 {
		t.Fatalf("BinSizeBytes on empty bin = %d, want 0", got)
	}

	id, _, dir, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	const payload = 4096
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), make([]byte, payload), 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}

	if got := store.BinSizeBytes(); got < payload {
		t.Fatalf("BinSizeBytes after binning = %d, want >= %d", got, payload)
	}

	if _, err := store.EmptyBin(); err != nil {
		t.Fatalf("EmptyBin: %v", err)
	}
	if got := store.BinSizeBytes(); got != 0 {
		t.Fatalf("BinSizeBytes after EmptyBin = %d, want 0", got)
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

// binConvAged creates a conversation whose last activity is `age` old (a
// back-dated txns/ blob, the signal lastActivityTime reads) and bins it.
func binConvAged(t *testing.T, store *FileSessionStore, name string, age time.Duration) string {
	t.Helper()
	id, _, dir, err := store.CreateConversationFolder(name, "")
	if err != nil {
		t.Fatalf("CreateConversationFolder(%s): %v", name, err)
	}
	txn := filepath.Join(dir, "txns", "txn_0.json")
	if err := os.MkdirAll(filepath.Dir(txn), 0o755); err != nil {
		t.Fatalf("mkdir txns(%s): %v", name, err)
	}
	if err := os.WriteFile(txn, []byte("{}"), 0o644); err != nil {
		t.Fatalf("write txn(%s): %v", name, err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(txn, when, when); err != nil {
		t.Fatalf("chtimes(%s): %v", name, err)
	}
	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation(%s): %v", name, err)
	}
	return id
}

// EmptyBinOlderThan removes only the conversations whose last activity predates
// the cutoff, leaving newer ones in the bin — and takes the staging directory
// with it, so nothing is left behind under .juggler/.
func TestEmptyBinOlderThan(t *testing.T) {
	store, dir := newStoreForTest(t)

	day := 24 * time.Hour
	ancient := binConvAged(t, store, "Ancient", 400*day)
	stale := binConvAged(t, store, "Stale", 31*day)
	fresh := binConvAged(t, store, "Fresh", 2*day)

	removed, err := store.EmptyBinOlderThan(time.Now().Add(-30 * day))
	if err != nil {
		t.Fatalf("EmptyBinOlderThan: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("removed = %v, want the two conversations older than 30 days", removed)
	}
	gone := map[string]bool{removed[0]: true, removed[1]: true}
	if !gone[ancient] || !gone[stale] {
		t.Fatalf("removed = %v, want %s and %s", removed, ancient, stale)
	}

	list := store.BinnedConvList()
	if len(list) != 1 || list[0].ID != fresh {
		t.Fatalf("BinnedConvList = %+v, want only %s left", list, fresh)
	}

	// The staging directory the qualifying folders were moved into is trashed
	// with them, not left as litter beside .juggler/trash/.
	leftovers, err := filepath.Glob(filepath.Join(dir, ".juggler", "trash.emptying-*"))
	if err != nil {
		t.Fatalf("glob staging dirs: %v", err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("staging dirs left behind: %v", leftovers)
	}
}

// A cutoff nothing matches is a no-op: no error, no staging directory, bin
// untouched.
func TestEmptyBinOlderThanMatchingNothing(t *testing.T) {
	store, dir := newStoreForTest(t)

	fresh := binConvAged(t, store, "Fresh", time.Hour)

	removed, err := store.EmptyBinOlderThan(time.Now().Add(-30 * 24 * time.Hour))
	if err != nil {
		t.Fatalf("EmptyBinOlderThan: %v", err)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v, want nothing", removed)
	}
	list := store.BinnedConvList()
	if len(list) != 1 || list[0].ID != fresh {
		t.Fatalf("BinnedConvList = %+v, want %s still binned", list, fresh)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".juggler", "trash.emptying-*"))
	if len(leftovers) != 0 {
		t.Fatalf("staging dirs created for a no-op empty: %v", leftovers)
	}
}
