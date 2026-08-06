//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// These tests pin two related failure modes seen when a window opens an old
// session:
//
//  1. Load split-brain — if session.json is missing or corrupt, the on-disk
//     conversation folders are the source of truth and must still populate the
//     tab order. Historically Load() scanned the folders into fs.index but then
//     bailed out on the globals read, leaving the manager with a full index yet
//     an empty ConversationOrder: the window showed one seeded tab while the
//     namer silently dodged the hidden real tabs.
//
//  2. New-tab naming — a brand-new blank tab always requests "Task N" and must
//     resolve to a clean, unused "Task K". It must never inherit the generic
//     "(copy)" collision suffix, which is reserved for genuine duplicates.

var bareTaskName = regexp.MustCompile(`^Task \d+$`)

// assertOrderMatchesDisk asserts the recovered ConversationOrder lists exactly
// the conversation folders present on disk (per ConvNames). Divergence is the
// split-brain: the window renders ConversationOrder while the create path
// collision-checks against ConvNames, so any gap names a new tab against
// conversations the window never showed.
func assertOrderMatchesDisk(t *testing.T, store *FileSessionStore, sess *Session) {
	t.Helper()
	names := store.ConvNames()
	if len(sess.ConversationOrder) != len(names) {
		t.Fatalf("ConversationOrder %v disagrees with on-disk folders %v",
			sess.ConversationOrder, names)
	}
	for _, id := range sess.ConversationOrder {
		if _, ok := names[id]; !ok {
			t.Fatalf("ConversationOrder id %s not present on disk %v", id, names)
		}
	}
}

// A missing session.json must not lose the tabs: Load rebuilds the order from
// the conversation folders on disk.
func TestLoad_MissingGlobalsRebuildsOrderFromDisk(t *testing.T) {
	store, dir := newStoreForTest(t)

	for _, name := range []string{"Task 1", "Task 2", "Task 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}

	// The trigger: the manifest is gone but the conversation folders remain.
	if err := os.Remove(filepath.Join(dir, ".juggler", "session.json")); err != nil {
		t.Fatalf("remove session.json: %v", err)
	}

	// A fresh store, as a newly opened window/process would use.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load after missing session.json: %v", err)
	}

	if len(sess.ConversationOrder) != 3 {
		t.Fatalf("ConversationOrder = %v, want all 3 conversations", sess.ConversationOrder)
	}
	assertOrderMatchesDisk(t, fresh, sess)
}

// A corrupt/unparseable session.json is likewise recovered from disk rather
// than discarding every conversation.
func TestLoad_CorruptGlobalsRebuildsOrderFromDisk(t *testing.T) {
	store, dir := newStoreForTest(t)

	for _, name := range []string{"Task 1", "Task 2"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}

	globals := filepath.Join(dir, ".juggler", "session.json")
	if err := os.WriteFile(globals, []byte("{ this is not valid json"), 0o644); err != nil {
		t.Fatalf("corrupt session.json: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load after corrupt session.json: %v", err)
	}

	if len(sess.ConversationOrder) != 2 {
		t.Fatalf("ConversationOrder = %v, want both conversations", sess.ConversationOrder)
	}
	assertOrderMatchesDisk(t, fresh, sess)
}

// The end-to-end reproduction: a manager brought up on a project whose
// session.json vanished must not present a split-brain. The window renders
// GetSession().ConversationOrder; the create path collision-checks against
// ConvNames(). If they disagree, a brand-new tab is named against
// conversations the window never showed — the reported "(copy 2)" bug.
func TestManager_MissingGlobalsNoSplitBrain(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, name := range []string{"Task 1", "Task 2", "Task 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("CreateConversationFolder(%s): %v", name, err)
		}
	}
	if err := os.Remove(filepath.Join(dir, ".juggler", "session.json")); err != nil {
		t.Fatalf("remove session.json: %v", err)
	}

	// A new manager, as a freshly opened window would create.
	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	m := startManager(fresh, dir, "")
	t.Cleanup(m.Shutdown)

	order := m.GetSession().ConversationOrder
	names := m.ConvNames()
	if len(order) != len(names) {
		t.Fatalf("split-brain: ConversationOrder has %d ids %v but ConvNames has %d %v",
			len(order), order, len(names), names)
	}
	for _, id := range order {
		if _, ok := names[id]; !ok {
			t.Fatalf("ConversationOrder id %s missing from ConvNames %v", id, names)
		}
	}
}

// A legacy session.json whose messageHistory is a plain string array (the
// pre-structured shape) must still load. Entries are now opaque
// json.RawMessage, so each string survives verbatim rather than failing the
// manifest parse and triggering a rebuild that would drop the history.
func TestLoad_LegacyStringMessageHistory(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	if err := store.Save(NewSession()); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	globals := filepath.Join(dir, ".juggler", "session.json")
	legacy := `{"version":5,"conversationOrder":[],"activeConversationId":"","messageHistory":["hello","world"],"metadata":{}}`
	if err := os.WriteFile(globals, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy session.json: %v", err)
	}

	fresh, err := NewFileSessionStore(dir)
	if err != nil {
		t.Fatalf("NewFileSessionStore: %v", err)
	}
	sess, err := fresh.Load()
	if err != nil {
		t.Fatalf("Load legacy session.json: %v", err)
	}
	if len(sess.MessageHistory) != 2 {
		t.Fatalf("MessageHistory = %v, want 2 legacy entries", sess.MessageHistory)
	}
	if string(sess.MessageHistory[0]) != `"hello"` || string(sess.MessageHistory[1]) != `"world"` {
		t.Fatalf("legacy entries not preserved verbatim: %q, %q",
			string(sess.MessageHistory[0]), string(sess.MessageHistory[1]))
	}
}

// A brand-new "Task N" create must resolve to the lowest unused "Task K" and
// never a "(copy)" suffix — even when "Task 1 (copy)" already sits on disk.
// Mirrors the reported state: "Task 1" and "Task 1 (copy)" exist, with a gap
// at "Task 2".
func TestCreateConversation_TaskNameNeverGetsCopySuffix(t *testing.T) {
	store, _ := newStoreForTest(t)

	for _, name := range []string{"Task 1", "Task 1 (copy)", "Task 3"} {
		if _, _, _, err := store.CreateConversationFolder(name, ""); err != nil {
			t.Fatalf("seed %q: %v", name, err)
		}
	}

	// A new blank tab always requests "Task N".
	_, name, _, err := store.CreateConversationFolder("Task 1", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if !bareTaskName.MatchString(name) {
		t.Fatalf("new tab name = %q, want a bare \"Task N\" (never a (copy) suffix)", name)
	}
	if name != "Task 2" {
		t.Fatalf("new tab name = %q, want lowest unused \"Task 2\"", name)
	}
}

// Guard: a genuine duplicate of a non-"Task N" name still gets the "(copy)"
// suffix. The Task-number reallocation must not change duplicate behaviour.
func TestCreateConversation_NonTaskNameStillGetsCopySuffix(t *testing.T) {
	store, _ := newStoreForTest(t)

	if _, _, _, err := store.CreateConversationFolder("Charlie", ""); err != nil {
		t.Fatalf("seed Charlie: %v", err)
	}
	_, name, _, err := store.CreateConversationFolder("Charlie", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if name != "Charlie (copy)" {
		t.Fatalf("duplicate name = %q, want \"Charlie (copy)\"", name)
	}
}
