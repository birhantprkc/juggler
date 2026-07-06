//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// TestMessageInsertion demonstrates message insertion with helpers.
func TestMessageInsertion(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Insert messages using tracker (creates undo entries)
	ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg-1",
		Content: "Hello",
	})

	err := helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("Message did not appear: %v", err)
	}

	itemCount := 1
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
		Items: []helpers.ItemAssertion{
			{Index: 0, Type: "user", Content: "Hello"},
		},
	})

	// Insert another message
	ts.Worker.Tracker().InsertMessage(1, worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "msg-2",
		Content: "Hi there!",
	})

	err = helpers.WaitForItemCount(t, ts.Worker, 2, 2*time.Second)
	if err != nil {
		t.Fatalf("Second message did not appear: %v", err)
	}

	itemCount = 2
	helpers.AssertDocumentState(t, ts.Worker, helpers.DocumentState{
		ItemCount: &itemCount,
		Items: []helpers.ItemAssertion{
			{Index: 0, Type: "user", Content: "Hello"},
			{Index: 1, Type: "assistant", Content: "Hi there!"},
		},
	})

	t.Log("SUCCESS: Message insertion works")
}

// TestItemDeletion tests deleting items from the document.
func TestItemDeletion(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Insert two items
	ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    "user",
		Content: "First",
	})
	ts.Worker.Tracker().InsertMessage(1, worker.ConversationItem{
		Type:    "user",
		Content: "Second",
	})

	err := helpers.WaitForItemCount(t, ts.Worker, 2, 2*time.Second)
	if err != nil {
		t.Fatalf("Items did not appear: %v", err)
	}

	// Delete first item
	ts.Worker.Tracker().DeleteMessages([]int{0})

	err = helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("Item was not deleted: %v", err)
	}

	// Verify remaining item is "Second"
	doc := ts.GetDocument()
	items := doc.GetItems()
	if items[0].Content != "Second" {
		t.Errorf("Expected 'Second', got %q", items[0].Content)
	}

	t.Log("SUCCESS: Item deletion works")
}

// TestUndoRedo tests undo/redo functionality.
func TestUndoRedo(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)

	// Insert an item
	ts.Worker.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    "user",
		Content: "Test",
	})

	err := helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("Item did not appear: %v", err)
	}

	// Delete it
	ts.Worker.Tracker().DeleteMessages([]int{0})

	err = helpers.WaitForItemCount(t, ts.Worker, 0, 2*time.Second)
	if err != nil {
		t.Fatalf("Item was not deleted: %v", err)
	}

	// Undo should restore it
	tracker := ts.Worker.Tracker()
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo")
	}
	tracker.Undo()

	err = helpers.WaitForItemCount(t, ts.Worker, 1, 2*time.Second)
	if err != nil {
		t.Fatalf("Undo did not restore item: %v", err)
	}

	// Redo should delete it again
	if !tracker.CanRedo() {
		t.Fatal("Should be able to redo")
	}
	tracker.Redo()

	err = helpers.WaitForItemCount(t, ts.Worker, 0, 2*time.Second)
	if err != nil {
		t.Fatalf("Redo did not delete item: %v", err)
	}

	t.Log("SUCCESS: Undo/redo works")
}
