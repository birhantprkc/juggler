//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"fmt"
	"juggler/cmd/juggler/worker"
	"strings"
	"testing"
	"time"
)

// TestUndoRedoMessageOrder tests that undo/redo preserve message order correctly.
// This is a critical real-world scenario where order bugs are most visible.
func TestUndoRedoMessageOrder(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert 5 messages in order: A, B, C, D, E
	messages := []string{"A", "B", "C", "D", "E"}
	for _, content := range messages {
		w.Tracker().InsertMessage(w.Document().GetItemsLength(), worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  "msg-" + content,
			Content: content,
		})
	}

	// Verify initial order
	items := w.Document().GetItems()
	if len(items) != 5 {
		t.Fatalf("Expected 5 items, got %d", len(items))
	}
	verifyOrder(t, items, messages, "after insert")

	// Undo all 5 insertions
	for i := 4; i >= 0; i-- {
		sendUndo(t, manager, w)
		items := w.Document().GetItems()
		verifyOrder(t, items, messages[:i], fmt.Sprintf("after undo %d", 5-i))
	}

	// Redo all 5 insertions - order MUST be preserved
	for i := 1; i <= 5; i++ {
		sendRedo(t, manager, w)
		items := w.Document().GetItems()
		verifyOrder(t, items, messages[:i], fmt.Sprintf("after redo %d", i))
	}

	// Final verification - all messages in correct order
	items = w.Document().GetItems()
	verifyOrder(t, items, messages, "final state")

	t.Log("SUCCESS: Message order preserved through undo/redo")
}

// TestUndoRedoMultipleDeletes tests undo/redo with multiple delete operations.
// Tests that delete order is preserved correctly.
func TestUndoRedoMultipleDeletes(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert 10 messages
	for i := range 10 {
		w.Document().AppendMessage(worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  string(rune('a' + i)),
			Content: string(rune('A' + i)),
		})
	}

	// Delete indices 2, 5, 7 (C, F, H) - in separate operations
	w.Tracker().DeleteMessages([]int{2}) // Delete C
	w.Tracker().DeleteMessages([]int{4}) // Delete F (was index 5, now 4)
	w.Tracker().DeleteMessages([]int{5}) // Delete H (was index 7, now 5)

	// Verify deletions
	items := w.Document().GetItems()
	if len(items) != 7 {
		t.Fatalf("Expected 7 items after deletes, got %d", len(items))
	}
	expected := []string{"A", "B", "D", "E", "G", "I", "J"}
	verifyOrder(t, items, expected, "after deletes")

	// Undo last delete (H should come back)
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	expected = []string{"A", "B", "D", "E", "G", "H", "I", "J"}
	verifyOrder(t, items, expected, "after undo 1")

	// Undo second delete (F should come back)
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	expected = []string{"A", "B", "D", "E", "F", "G", "H", "I", "J"}
	verifyOrder(t, items, expected, "after undo 2")

	// Undo first delete (C should come back)
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	expected = []string{"A", "B", "C", "D", "E", "F", "G", "H", "I", "J"}
	verifyOrder(t, items, expected, "after undo 3")

	// Redo all deletes - order should be preserved
	sendRedo(t, manager, w) // Delete C again
	sendRedo(t, manager, w) // Delete F again
	sendRedo(t, manager, w) // Delete H again
	items = w.Document().GetItems()
	expected = []string{"A", "B", "D", "E", "G", "I", "J"}
	verifyOrder(t, items, expected, "after redo all")

	t.Log("SUCCESS: Multiple deletes undo/redo correctly")
}

// TestUndoRedoMixedOperations tests undo/redo with mixed insert and delete operations.
// This tests real-world workflows where users insert and delete messages.
func TestUndoRedoMixedOperations(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Operation 1: Insert A, B, C
	w.Tracker().InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "a", Content: "A"})
	w.Tracker().InsertMessage(1, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "b", Content: "B"})
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "c", Content: "C"})

	// Operation 2: Delete B (index 1)
	w.Tracker().DeleteMessages([]int{1})

	// Operation 3: Insert D, E at end
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "d", Content: "D"})
	w.Tracker().InsertMessage(3, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "e", Content: "E"})

	// Current state: [A, C, D, E]
	items := w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "C", "D", "E"}, "after all operations")

	// Undo E insertion
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "C", "D"}, "after undo E")

	// Undo D insertion
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "C"}, "after undo D")

	// Undo B deletion (B should come back)
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B", "C"}, "after undo B deletion")

	// Undo C insertion
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B"}, "after undo C")

	// Redo everything back
	sendRedo(t, manager, w) // Redo C insertion
	sendRedo(t, manager, w) // Redo B deletion
	sendRedo(t, manager, w) // Redo D insertion
	sendRedo(t, manager, w) // Redo E insertion
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "C", "D", "E"}, "after redo all")

	t.Log("SUCCESS: Mixed operations undo/redo correctly")
}

// TestUndoRedoStackBoundaries tests undo/redo at stack boundaries.
// Tests that going beyond undo/redo limits doesn't corrupt state.
func TestUndoRedoStackBoundaries(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert 3 messages
	w.Tracker().InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "a", Content: "A"})
	w.Tracker().InsertMessage(1, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "b", Content: "B"})
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "c", Content: "C"})

	// Undo all 3
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B"}, "after undo 1")
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A"}, "after undo 2")
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{}, "after undo 3")

	// Try to undo past the beginning (should be no-op)
	sendUndo(t, manager, w)
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{}, "after undo beyond start")

	// Redo all 3
	sendRedo(t, manager, w)
	sendRedo(t, manager, w)
	sendRedo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "after redo all")

	// Try to redo past the end (should be no-op)
	sendRedo(t, manager, w)
	sendRedo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "after redo beyond end")

	t.Log("SUCCESS: Stack boundaries handled correctly")
}

// TestUndoRedoBranchingHistory tests undo followed by new operations.
// This tests the real-world scenario where users undo, then make new changes (branching).
func TestUndoRedoBranchingHistory(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert A, B, C
	w.Tracker().InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "a", Content: "A"})
	w.Tracker().InsertMessage(1, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "b", Content: "B"})
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "c", Content: "C"})

	// Undo C
	sendUndo(t, manager, w)
	items := w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B"}, "after undo C")

	// Now insert D instead (this should clear redo stack)
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "d", Content: "D"})
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B", "D"}, "after insert D")

	// Try to redo C - should be no-op (redo stack cleared)
	sendRedo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B", "D"}, "after redo (should be no-op)")

	// But we should be able to undo D
	sendUndo(t, manager, w)
	items = w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "B"}, "after undo D")

	t.Log("SUCCESS: Branching history handled correctly")
}

// TestUndoRedoMixedItemTypes tests undo/redo with different item types.
// Context items are items with an itemId in the items array.
func TestUndoRedoMixedItemTypes(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert message A
	w.Tracker().InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "a", Content: "A"})

	// Insert context item (unified storage)
	w.Tracker().InsertMessage(1, worker.ConversationItem{Type: "rule", ItemID: "ci1", Data: []byte(`{}`)})

	// Insert message B
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "b", Content: "B"})

	// Verify initial state — context item has empty content, user items have "A"/"B"
	items := w.Document().GetItems()
	verifyOrder(t, items, []string{"A", "", "B"}, "initial state")

	// Undo message B
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", ""}, "after undo B")

	// Undo context item
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A"}, "after undo context item")

	// Undo message A
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{}, "after undo A")

	// Redo everything back
	sendRedo(t, manager, w) // Redo A
	verifyOrder(t, w.Document().GetItems(), []string{"A"}, "after redo A")
	sendRedo(t, manager, w) // Redo context item
	verifyOrder(t, w.Document().GetItems(), []string{"A", ""}, "after redo context item")
	sendRedo(t, manager, w) // Redo B
	verifyOrder(t, w.Document().GetItems(), []string{"A", "", "B"}, "after redo B")

	t.Log("SUCCESS: Mixed item types undo/redo correctly")
}

// =============================================================================
// ID-BASED RESOLUTION TESTS
// =============================================================================

// TestUndoDeleteAfterIndexShift tests that undoing a delete works correctly
// even when a builtIn item insertion has shifted all indices.
func TestUndoDeleteAfterIndexShift(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [A(0), B(1), C(2)]
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-a", Content: "A",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-c", Content: "C",
	})

	// Delete B at index 1
	tracker.DeleteMessages([]int{1})

	// State: [A(0), C(1)]
	items := doc.GetItems()
	if len(items) != 2 || items[0].Content != "A" || items[1].Content != "C" {
		t.Fatalf("Expected [A, C], got %v", items)
	}

	// Insert a builtIn at index 0 (shifting everything right)
	doc.InsertMessage(0, worker.ConversationItem{
		Type: "system", ItemID: "builtin-sys", Content: "System", PreventUserDeletion: true,
	})

	// State: [sys(0), A(1), C(2)]
	items = doc.GetItems()
	if len(items) != 3 {
		t.Fatalf("Expected 3 items, got %d", len(items))
	}

	// Undo the delete — B should be restored despite shifted indices
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 4 {
		t.Fatalf("Expected 4 items after undo, got %d", len(items))
	}

	// B should be restored (exact position may vary, but it should exist)
	var foundB bool
	for _, item := range items {
		if item.ItemID == "msg-b" && item.Content == "B" {
			foundB = true
			break
		}
	}
	if !foundB {
		t.Errorf("After undo: B not found in items")
		for i, item := range items {
			t.Logf("  [%d] %s (%s)", i, item.Content, item.ItemID)
		}
	}

	t.Log("SUCCESS: Undo delete after index shift restores correct item")
}

// TestRedoDeleteAfterIndexShift tests that redoing a delete finds the correct
// item by ID even when indices have shifted.
func TestRedoDeleteAfterIndexShift(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [A(0), B(1), C(2)]
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-a", Content: "A",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-c", Content: "C",
	})

	// Delete B at index 1
	tracker.DeleteMessages([]int{1})
	// State: [A(0), C(1)]

	// Undo the delete
	tracker.Undo()
	// State: [A(0), B(1), C(2)]

	// Insert a builtIn at index 0 (shifting everything right)
	doc.InsertMessage(0, worker.ConversationItem{
		Type: "system", ItemID: "builtin-sys", Content: "System", PreventUserDeletion: true,
	})
	// State: [sys(0), A(1), B(2), C(3)]

	// Redo the delete — should delete B by ID, not the item at original index 1
	tracker.Redo()
	items := doc.GetItems()

	// B should be gone
	for _, item := range items {
		if item.ItemID == "msg-b" {
			t.Errorf("After redo: B should have been deleted but was found")
			break
		}
	}

	// A and C should still exist
	var foundA, foundC bool
	for _, item := range items {
		if item.ItemID == "msg-a" {
			foundA = true
		}
		if item.ItemID == "msg-c" {
			foundC = true
		}
	}
	if !foundA || !foundC {
		t.Errorf("After redo: expected A and C to survive, foundA=%v foundC=%v", foundA, foundC)
		for i, item := range items {
			t.Logf("  [%d] %s (%s)", i, item.Content, item.ItemID)
		}
	}

	t.Log("SUCCESS: Redo delete after index shift deletes correct item by ID")
}

// TestUndoReplaceAfterIndexShift tests that undoing a replace finds the correct
// item by ID even when indices have shifted.
func TestUndoReplaceAfterIndexShift(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [A(0), B(1), C(2)]
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-a", Content: "A",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B-original",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-c", Content: "C",
	})

	// Replace B's content
	_ = tracker.ReplaceMessage(1, worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B-updated",
	})

	// Insert a builtIn at index 0 (shifting everything right)
	doc.InsertMessage(0, worker.ConversationItem{
		Type: "system", ItemID: "builtin-sys", Content: "System", PreventUserDeletion: true,
	})
	// State: [sys(0), A(1), B-updated(2), C(3)]

	// Undo the replace — should find B by ID and restore original content
	tracker.Undo()
	items := doc.GetItems()

	// Find B and verify content restored
	var foundB bool
	for _, item := range items {
		if item.ItemID == "msg-b" {
			foundB = true
			if item.Content != "B-original" {
				t.Errorf("After undo: B content expected 'B-original', got '%s'", item.Content)
			}
			break
		}
	}
	if !foundB {
		t.Errorf("After undo: B not found")
		for i, item := range items {
			t.Logf("  [%d] %s (%s)", i, item.Content, item.ItemID)
		}
	}

	t.Log("SUCCESS: Undo replace after index shift restores correct item content")
}

// TestUndoMoveAfterIndexShift tests that undoing a move finds the correct
// item by ID even when indices have shifted.
func TestUndoMoveAfterIndexShift(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [A(0), B(1), C(2)]
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-a", Content: "A",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-c", Content: "C",
	})

	// Move A from index 0 to index 2
	_ = tracker.MoveMessage(0, 2)
	// State: [B(0), C(1), A(2)]

	// Insert a builtIn at index 0 (shifting everything right)
	doc.InsertMessage(0, worker.ConversationItem{
		Type: "system", ItemID: "builtin-sys", Content: "System", PreventUserDeletion: true,
	})
	// State: [sys(0), B(1), C(2), A(3)]

	// Undo the move — should restore A to its original position before B and C.
	// With builtIn at index 0, the expected order is: [System, A, B, C].
	tracker.Undo()
	items := doc.GetItems()
	verifyOrder(t, items, []string{"System", "A", "B", "C"}, "after undo move")
	t.Log("SUCCESS: Undo move after index shift works with ID-based resolution")
}

// TestBackwardCompat_NoItemID verifies that operations without ItemIDs fall back
// to index-based resolution.
func TestBackwardCompat_NoItemID(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [A(0), B(1), C(2)]
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-a", Content: "A",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-b", Content: "B",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type: worker.ItemTypeUser, ItemID: "msg-c", Content: "C",
	})

	// Delete B using tracker (records with ItemID in inverse data)
	tracker.DeleteMessages([]int{1})
	// State: [A(0), C(1)]

	// Undo — should work (has ItemIDs in inverse)
	tracker.Undo()
	verifyOrder(t, doc.GetItems(), []string{"A", "B", "C"}, "after undo")

	// Redo — should use ID-based deletion
	tracker.Redo()
	verifyOrder(t, doc.GetItems(), []string{"A", "C"}, "after redo")

	t.Log("SUCCESS: Backward compat with ItemID-bearing operations works correctly")
}

// TestUndoRedoSubThreadItemDeletion verifies that deleting an item from a subthread's
// nested Y.Array via DeleteThreadItem (which uses authorID as origin, matching the
// browser's behaviour) can be both undone and redone correctly.
func TestUndoRedoSubThreadItemDeletion(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Create a thread with two items in its nested array.
	nestedArr := doc.InsertThread(0, "Do work")
	doc.InsertMessageIntoArray(nestedArr, 0, worker.ConversationItem{Type: "user", ItemID: "sub-1", Content: "First"})
	doc.InsertMessageIntoArray(nestedArr, 1, worker.ConversationItem{Type: "assistant", ItemID: "sub-2", Content: "Second"})

	subItems := doc.GetItemsFromArray(nestedArr)
	if len(subItems) != 2 {
		t.Fatalf("expected 2 sub-items after insert, got %d", len(subItems))
	}

	// Delete the last item via tracker (tracked under authorID — same as browser).
	tracker.DeleteThreadItem(nestedArr, 1)

	subItems = doc.GetItemsFromArray(nestedArr)
	if len(subItems) != 1 {
		t.Fatalf("expected 1 sub-item after delete, got %d", len(subItems))
	}

	// Undo — item must be restored.
	tracker.Undo()
	subItems = doc.GetItemsFromArray(nestedArr)
	if len(subItems) != 2 {
		t.Fatalf("expected 2 sub-items after undo, got %d", len(subItems))
	}

	// Redo — item must be deleted again.
	tracker.Redo()
	subItems = doc.GetItemsFromArray(nestedArr)
	if len(subItems) != 1 {
		t.Fatalf("expected 1 sub-item after redo, got %d", len(subItems))
	}
	if subItems[0].ItemID != "sub-1" {
		t.Fatalf("expected remaining item to be sub-1, got %q", subItems[0].ItemID)
	}

	t.Log("SUCCESS: SubThread item delete/undo/redo works correctly")
}

// Helper functions

func initWorker(t *testing.T, manager *worker.Manager, tmpDir string) *worker.ConversationWorker {
	t.Helper()

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID:   "test-conv",
			Name: "Test",
		},
		Config: worker.WorkerConfig{
			ProjectPath: tmpDir,
		},
	})

	readyChan := make(chan struct{}, 1)
	sendCallback := func(msg []byte) {
		var parsed map[string]any
		if err := json.Unmarshal(msg, &parsed); err == nil {
			if parsed["type"] == "ready" {
				select {
				case readyChan <- struct{}{}:
				default:
				}
			}
		}
	}

	handled := manager.HandleMessage("test-conv", "init", initPayload, sendCallback)
	if !handled {
		t.Fatal("Init not handled")
	}

	select {
	case <-readyChan:
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for ready message")
	}

	w := manager.Get("test-conv")
	if w == nil {
		t.Fatal("Worker not found")
	}

	return w
}

func sendUndo(t *testing.T, manager *worker.Manager, w *worker.ConversationWorker) {
	t.Helper()
	sendOp(t, manager, "undo")
}

func sendRedo(t *testing.T, manager *worker.Manager, w *worker.ConversationWorker) {
	t.Helper()
	sendOp(t, manager, "redo")
}

func sendOp(t *testing.T, manager *worker.Manager, msgType string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"type": msgType})
	ackChan := make(chan struct{}, 1)
	if !manager.HandleMessage("test-conv", msgType, payload, func(msg []byte) {
		var m struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msg, &m) == nil && m.Type == "ack" {
			select {
			case ackChan <- struct{}{}:
			default:
			}
		}
	}) {
		t.Fatalf("%s not handled", msgType)
	}
	select {
	case <-ackChan:
	case <-time.After(2 * time.Second):
		t.Fatalf("timeout waiting for %s ack", msgType)
	}
}

// filterUndeletable returns items with the SYSTEM_1 placeholder stripped out.
// Tests express expectations in terms of user-controlled items; the SYSTEM_1
// system-prompt placeholder is seeded JS-side at thread creation and is
// incidental to the worker operations under test, so it's filtered to keep
// these worker-level tests robust whether or not it's present. Other
// PreventUserDeletion items (e.g. test-fixture builtIns) are preserved — only
// SYSTEM_1 is special.
func filterUndeletable(items []worker.ConversationItem) []worker.ConversationItem {
	out := make([]worker.ConversationItem, 0, len(items))
	for _, it := range items {
		if it.ItemID == "SYSTEM_1" {
			continue
		}
		out = append(out, it)
	}
	return out
}

func verifyOrder(t *testing.T, items []worker.ConversationItem, expected []string, label string) {
	t.Helper()
	items = filterUndeletable(items)
	if len(items) != len(expected) {
		t.Errorf("%s: expected %d items, got %d", label, len(expected), len(items))
		for i, item := range items {
			t.Logf("  [%d] %s", i, item.Content)
		}
		return
	}
	for i, exp := range expected {
		if items[i].Content != exp {
			t.Errorf("%s: item %d expected %s, got %s", label, i, exp, items[i].Content)
		}
	}
}

// TestClearHistoryResetsUndoRedoState tests that ClearHistory() properly clears
// the undo log Y.Array, not just metadata. This is a regression test for a bug
// where ClearHistory() wrote to metadata instead of the Y.Array.
func TestClearHistoryResetsUndoRedoState(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert operations to create undo history
	w.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg-1",
		Content: "First message",
	})

	w.Tracker().InsertMessage(1, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg-2",
		Content: "Second message",
	})

	// Verify we have undo history
	if !w.Tracker().CanUndo() {
		t.Fatal("Expected CanUndo() to be true before ClearHistory")
	}

	// Clear history
	w.Tracker().ClearHistory()

	// CRITICAL: Both must be false after ClearHistory
	if w.Tracker().CanUndo() {
		t.Error("CanUndo() should be false after ClearHistory")
	}
	if w.Tracker().CanRedo() {
		t.Error("CanRedo() should be false after ClearHistory - BUG: log entries not cleared")
	}
}

// =============================================================================
// GROUPING TESTS
// =============================================================================

// TestUndoGrouping_SlowDeletes tests that two separate DeleteMessages calls produce two separate undo steps.
func TestUndoGrouping_SlowDeletes(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert 3 messages
	for i := range 3 {
		w.Tracker().InsertMessage(i, worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  string(rune('a' + i)),
			Content: string(rune('A' + i)),
		})
	}

	// Two separate DeleteMessages calls — tracker.DeleteMessages always calls StopCapturing,
	// so each delete is its own undo group regardless of timing.
	w.Tracker().DeleteMessages([]int{2}) // Delete C
	w.Tracker().DeleteMessages([]int{1}) // Delete B

	verifyOrder(t, w.Document().GetItems(), []string{"A"}, "after two deletes")

	// First undo should only restore B (the more recent delete)
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B"}, "after undo 1 (B restored)")

	// Second undo should restore C
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "after undo 2 (C restored)")

	t.Log("SUCCESS: Separate DeleteMessages calls produce separate undo steps")
}

// TestUndoGrouping_MixedAuxiliaryAndUserFacing tests that auxiliary items (thinking blocks)
// group with previous op, while user-facing items get their own group.
func TestUndoGrouping_MixedAuxiliaryAndUserFacing(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert a user message (user-facing, gets own group)
	w.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "User message",
	})

	// Insert a thinking block (auxiliary, groups with previous)
	w.Tracker().InsertMessage(1, worker.ConversationItem{
		Type:    worker.ItemTypeThinking,
		ItemID:  "think1",
		Content: "Thinking...",
	})

	// Insert an assistant message (user-facing, gets own group)
	w.Tracker().InsertMessage(2, worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "msg2",
		Content: "Assistant reply",
	})

	verifyOrder(t, w.Document().GetItems(), []string{"User message", "Thinking...", "Assistant reply"}, "initial state")

	// First undo should remove assistant message (gets its own group)
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"User message", "Thinking..."}, "after undo 1 (assistant removed)")

	// Second undo should remove both user message AND thinking block
	// (thinking block is auxiliary and groups with user message)
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{}, "after undo 2 (user+thinking removed)")

	t.Log("SUCCESS: Auxiliary items group with previous, user-facing get own group")
}

// TestUndoGrouping_ToolActionGroupsWithResponse tests that tool-action items
// group with the preceding assistant + tool-use from the same LLM response,
// so a single undo removes the entire response (not two separate undo steps).
func TestUndoGrouping_ToolActionGroupsWithResponse(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Simulate LLM response flow: assistant → tool-use → tool-action
	// All should end up in the same undo group.

	// 1. Assistant message (non-auxiliary, starts new group)
	tracker.InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "asst-1",
		Content: "Let me check that for you",
	})

	// 2. Tool-use (auxiliary, groups with previous)
	tracker.InsertMessage(1, worker.ConversationItem{
		Type:      "tool-use",
		ItemID:    "tu-1",
		ToolUseID: "call-123",
		ToolName:  "ask_user",
	})

	// 3. Tool-action (should group with the response, not start a new group)
	tracker.InsertMessage(2, worker.ConversationItem{
		Type:      worker.ItemTypeToolAction,
		ItemID:    "ta-1",
		ToolUseID: "call-123",
		ToolName:  "ask_user",
	})

	// assistant + tool-use + tool-action — types differ, content is empty for tool items
	items := doc.GetItems()
	if len(items) != 3 {
		t.Fatalf("Expected 3 items, got %d", len(items))
	}
	if items[0].Type != worker.ItemTypeAssistant || items[1].Type != "tool-use" || items[2].Type != worker.ItemTypeToolAction {
		t.Fatalf("Unexpected types: [%s, %s, %s]", items[0].Type, items[1].Type, items[2].Type)
	}

	// A single undo should remove ALL three (same undo group)
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 0 {
		t.Errorf("Expected 0 items after single undo, got %d", len(items))
		for i, item := range items {
			t.Logf("  remaining[%d]: type=%s id=%s", i, item.Type, item.ItemID)
		}
	}

	// Single redo should restore all three in correct order
	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 3 {
		t.Errorf("Expected 3 items after redo, got %d", len(items))
	}
	if len(items) == 3 {
		if items[0].Type != worker.ItemTypeAssistant || items[1].Type != "tool-use" || items[2].Type != worker.ItemTypeToolAction {
			t.Errorf("After redo: wrong types [%s, %s, %s]", items[0].Type, items[1].Type, items[2].Type)
		}
	}

	t.Log("SUCCESS: Tool-action groups with assistant response for atomic undo")
}

// =============================================================================
// CONTEXT ITEM EDGE CASES
// =============================================================================

// TestUndoContextItemDelete tests that deleting a context item can be undone,
// restoring it with correct type and data.
func TestUndoContextItemDelete(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert a context item
	ciData := []byte(`{"use":"read-file","path":"test.go"}`)
	w.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:   "rule",
		ItemID: "ci-test-1",
		Data:   ciData,
	})

	// Delete it
	w.Tracker().DeleteMessages([]int{0})

	items := filterUndeletable(w.Document().GetItems())
	if len(items) != 0 {
		t.Fatalf("Expected 0 items after delete, got %d", len(items))
	}

	// Undo should restore with correct type and data
	sendUndo(t, manager, w)
	items = filterUndeletable(w.Document().GetItems())
	if len(items) != 1 {
		t.Fatalf("Expected 1 item after undo, got %d", len(items))
	}
	if items[0].Type != "rule" {
		t.Errorf("Expected type 'rule', got '%s'", items[0].Type)
	}
	if items[0].ItemID != "ci-test-1" {
		t.Errorf("Expected ItemID 'ci-test-1', got '%s'", items[0].ItemID)
	}

	t.Log("SUCCESS: Context item delete undone correctly")
}

// TestUndoContextItemReplace tests replacing context item data and undoing it.
func TestUndoContextItemReplace(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert a context item
	w.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:   "rule",
		ItemID: "ci-test-1",
		Data:   []byte(`{"use":"read-file","path":"original.go"}`),
	})

	// Replace data
	_ = w.Tracker().ReplaceMessage(0, worker.ConversationItem{
		Type:   "rule",
		ItemID: "ci-test-1",
		Data:   []byte(`{"use":"read-file","path":"updated.go"}`),
	})

	// Undo should restore original data
	sendUndo(t, manager, w)
	items := filterUndeletable(w.Document().GetItems())
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}

	// Check that the restored data contains the original path (JSON key order may vary)
	dataStr := string(items[0].Data)
	if !strings.Contains(dataStr, "original.go") {
		t.Errorf("Expected data to contain 'original.go', got '%s'", dataStr)
	}

	t.Log("SUCCESS: Context item replace undone correctly")
}

// =============================================================================
// REPLACE OPERATION TESTS
// =============================================================================

// TestUndoReplace tests that replacing a message content can be undone.
// Uses direct document/tracker to isolate replace behavior from insert grouping.
func TestUndoReplace(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Insert bypassing tracker to avoid groupId linking
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "Original content",
	})

	// Replace content via tracker
	_ = tracker.ReplaceMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "Modified content",
	})

	items := doc.GetItems()
	if items[0].Content != "Modified content" {
		t.Fatalf("Expected 'Modified content', got '%s'", items[0].Content)
	}

	// Undo restores original
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item after undo, got %d", len(items))
	}
	if items[0].Content != "Original content" {
		t.Errorf("Expected 'Original content' after undo, got '%s'", items[0].Content)
	}

	// Redo applies modification again
	tracker.Redo()
	items = doc.GetItems()
	if items[0].Content != "Modified content" {
		t.Errorf("Expected 'Modified content' after redo, got '%s'", items[0].Content)
	}

	t.Log("SUCCESS: Replace undo/redo works correctly")
}

// TestUndoReplaceAfterUndo tests that undoing a replace, then performing a new
// operation, clears the redo stack.
// Uses direct document/tracker to isolate replace behavior from insert grouping.
func TestUndoReplaceAfterUndo(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Insert bypassing tracker
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "V1",
	})

	// Replace to V2 via tracker
	_ = tracker.ReplaceMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "V2",
	})

	// Undo back to V1
	tracker.Undo()
	items := doc.GetItems()
	if len(items) != 1 || items[0].Content != "V1" {
		t.Fatalf("Expected 'V1' after undo, got %d items", len(items))
	}

	// Now insert a new item (should clear redo for V2)
	tracker.InsertMessage(1, worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "msg2",
		Content: "New message",
	})

	// Redo should be no-op (redo stack cleared by new operation)
	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items (redo should be no-op), got %d", len(items))
	}

	t.Log("SUCCESS: New operation after undo clears redo stack")
}

// =============================================================================
// MOVE OPERATION TESTS
// =============================================================================

// TestUndoMove tests that moving an item can be undone.
func TestUndoMove(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert A, B, C
	w.Tracker().InsertMessage(0, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "a", Content: "A"})
	w.Tracker().InsertMessage(1, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "b", Content: "B"})
	w.Tracker().InsertMessage(2, worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "c", Content: "C"})

	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "initial")

	// Move A (index 0) to index 2
	_ = w.Tracker().MoveMessage(0, 2)

	verifyOrder(t, w.Document().GetItems(), []string{"B", "C", "A"}, "after move")

	// Undo should move it back
	sendUndo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "after undo move")

	// Redo should move again
	sendRedo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"B", "C", "A"}, "after redo move")

	t.Log("SUCCESS: Move undo/redo works correctly")
}

// =============================================================================
// CLEAR ALL TESTS
// =============================================================================

// TestUndoClearAll tests that ClearAll with multiple items can be undone,
// restoring all items in correct order.
func TestUndoClearAll(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert mixed items: message, context item, message
	w.Tracker().InsertMessage(0, worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "msg1",
		Content: "Hello",
	})

	w.Tracker().InsertMessage(1, worker.ConversationItem{
		Type:   "rule",
		ItemID: "ci-1",
		Data:   []byte(`{"use":"tree"}`),
	})

	w.Tracker().InsertMessage(2, worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "msg2",
		Content: "World",
	})

	items := filterUndeletable(w.Document().GetItems())
	if len(items) != 3 {
		t.Fatalf("Expected 3 items before ClearAll, got %d", len(items))
	}

	// ClearAll
	w.Tracker().ClearAll()

	items = filterUndeletable(w.Document().GetItems())
	if len(items) != 0 {
		t.Fatalf("Expected 0 items after ClearAll, got %d", len(items))
	}

	// Undo should restore all items in correct order
	sendUndo(t, manager, w)
	items = filterUndeletable(w.Document().GetItems())
	if len(items) != 3 {
		t.Fatalf("Expected 3 items after undo ClearAll, got %d", len(items))
	}

	if items[0].Type != worker.ItemTypeUser || items[0].Content != "Hello" {
		t.Errorf("Item 0: expected user/Hello, got %s/%s", items[0].Type, items[0].Content)
	}
	if items[1].Type != "rule" || items[1].ItemID != "ci-1" {
		t.Errorf("Item 1: expected rule/ci-1, got %s/%s", items[1].Type, items[1].ItemID)
	}
	if items[2].Type != worker.ItemTypeAssistant || items[2].Content != "World" {
		t.Errorf("Item 2: expected assistant/World, got %s/%s", items[2].Type, items[2].Content)
	}

	t.Log("SUCCESS: ClearAll undo restores all items correctly")
}

// =============================================================================
// TOOL-ACTION STATE PRESERVATION
// =============================================================================

// TestUndoRedoToolActionStatePreservation tests that undo/redo preserves
// tool-action state changes (state, result) that happen after insertion.
//
// Reproduces the bug: when a tool-action is inserted (state="", result=null),
// then approved externally (state="completed", result set), undo+redo would
// restore the stale insert-time state instead of the current state.
func TestUndoRedoToolActionStatePreservation(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Insert a tool-action via tracker (state empty, no result — like initial insert)
	tracker.InsertMessage(0, worker.ConversationItem{
		Type:     worker.ItemTypeToolAction,
		ItemID:   "ta-1",
		ToolName: "ask_user",
	})

	// Verify it was inserted
	items := doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item, got %d", len(items))
	}
	if items[0].State != "" {
		t.Fatalf("Expected empty state, got %q", items[0].State)
	}

	// Simulate main thread approving and setting result via in-place field updates,
	// matching the real worker flow (UpdateToolActionFieldsRecursive uses Y.Map.Set,
	// not delete+insert, so the original Y.Map container is never tombstoned).
	_ = doc.UpdateItemByID("ta-1", "state", "completed")
	_ = doc.UpdateItemByID("ta-1", "result", "user answered yes")

	// Verify approval
	items = doc.GetItems()
	if items[0].State != "completed" {
		t.Fatalf("Expected state 'approved', got %q", items[0].State)
	}

	// Undo — should remove the tool-action
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 0 {
		t.Fatalf("Expected 0 items after undo, got %d", len(items))
	}

	// Redo — should restore with CURRENT state (approved + result), not stale state
	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item after redo, got %d", len(items))
	}
	if items[0].State != "completed" {
		t.Errorf("After redo: expected state 'approved', got %q", items[0].State)
	}
	if string(items[0].Result) != `"user answered yes"` {
		t.Errorf("After redo: expected result '\"user answered yes\"', got %q", string(items[0].Result))
	}

	// Verify idempotency: undo+redo again should still preserve state
	tracker.Undo()
	if len(doc.GetItems()) != 0 {
		t.Fatal("Expected 0 items after second undo")
	}
	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Fatal("Expected 1 item after second redo")
	}
	if items[0].State != "completed" {
		t.Errorf("After second redo: expected state 'approved', got %q", items[0].State)
	}

	t.Log("SUCCESS: Undo/redo preserves tool-action state changes")
}

// TestUndoRedoToolActionWithContentReplace tests the real-world flow where
// a tool-action is inserted, then a content replace is tracked (via streaming),
// then approval happens (NOT tracked). On redo, both the insert and the replace
// must reflect the approved state, not the stale pre-approval state.
func TestUndoRedoToolActionWithContentReplace(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Step 1: Insert tool-action via tracker (simulates worker inserting it)
	tracker.InsertMessage(0, worker.ConversationItem{
		Type:     worker.ItemTypeToolAction,
		ItemID:   "ta-1",
		ToolName: "ask_user",
		Content:  "initial",
	})

	// Step 2: Content update via tracker (simulates streaming content update)
	contentUpdated := worker.ConversationItem{
		Type:     worker.ItemTypeToolAction,
		ItemID:   "ta-1",
		ToolName: "ask_user",
		Content:  "What do you think?",
	}
	_ = tracker.ReplaceMessage(0, contentUpdated)

	// Step 3: Approval and result set (tracked via tracker.ReplaceMessage)
	approvedItem := worker.ConversationItem{
		Type:     worker.ItemTypeToolAction,
		ItemID:   "ta-1",
		ToolName: "ask_user",
		Content:  "What do you think?",
		State:    "completed",
		Result:   json.RawMessage(`"user said yes"`),
	}
	_ = tracker.ReplaceMessage(0, approvedItem)

	// Verify current state
	items := doc.GetItems()
	if items[0].State != "completed" {
		t.Fatalf("Expected approved, got %q", items[0].State)
	}

	// Undo — should remove the tool-action (undoes replace then insert)
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 0 {
		t.Fatalf("Expected 0 items after undo, got %d", len(items))
	}

	// Redo — should restore with approved state (both insert and replace
	// forward data should have been snapshotted)
	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("Expected 1 item after redo, got %d", len(items))
	}
	if items[0].State != "completed" {
		t.Errorf("After redo: expected state 'approved', got %q", items[0].State)
	}
	if items[0].Content != "What do you think?" {
		t.Errorf("After redo: expected content 'What do you think?', got %q", items[0].Content)
	}
	if string(items[0].Result) != `"user said yes"` {
		t.Errorf("After redo: expected result, got %q", string(items[0].Result))
	}

	// Verify idempotency
	tracker.Undo()
	tracker.Redo()
	items = doc.GetItems()
	if items[0].State != "completed" {
		t.Errorf("After second redo: expected approved, got %q", items[0].State)
	}

	t.Log("SUCCESS: Undo/redo with content replace preserves tool-action approval state")
}

// =============================================================================
// STRESS / EDGE CASES
// =============================================================================

// TestUndoEmptyTracker tests undo/redo on a fresh tracker with no operations.
func TestUndoEmptyTracker(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Both should be no-ops on empty tracker
	if w.Tracker().CanUndo() {
		t.Error("CanUndo() should be false on empty tracker")
	}
	if w.Tracker().CanRedo() {
		t.Error("CanRedo() should be false on empty tracker")
	}

	// Undo/redo should not panic or corrupt state
	sendUndo(t, manager, w)
	sendRedo(t, manager, w)

	items := w.Document().GetItems()
	if len(items) != 0 {
		t.Errorf("Expected 0 items after no-op undo/redo, got %d", len(items))
	}

	t.Log("SUCCESS: Empty tracker handles undo/redo gracefully")
}

// TestUndoRedoRapidCycles tests 100+ rapid undo/redo cycles for state consistency.
func TestUndoRedoRapidCycles(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()
	manager := worker.NewManager()
	defer manager.Shutdown()

	w := initWorker(t, manager, tmpDir)

	// Insert 3 messages
	for i := range 3 {
		w.Tracker().InsertMessage(i, worker.ConversationItem{
			Type:    worker.ItemTypeUser,
			ItemID:  string(rune('a' + i)),
			Content: string(rune('A' + i)),
		})
	}

	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "initial")

	// Undo all
	sendUndo(t, manager, w)
	sendUndo(t, manager, w)
	sendUndo(t, manager, w)

	if len(w.Document().GetItems()) != 0 {
		t.Fatalf("Expected 0 items after full undo")
	}

	// 100 rapid undo/redo cycles from empty → full → empty
	for cycle := range 100 {
		// Redo all 3
		sendRedo(t, manager, w)
		sendRedo(t, manager, w)
		sendRedo(t, manager, w)

		items := w.Document().GetItems()
		if len(items) != 3 {
			t.Fatalf("Cycle %d redo: expected 3 items, got %d", cycle, len(items))
		}

		// Undo all 3
		sendUndo(t, manager, w)
		sendUndo(t, manager, w)
		sendUndo(t, manager, w)

		items = w.Document().GetItems()
		if len(items) != 0 {
			t.Fatalf("Cycle %d undo: expected 0 items, got %d", cycle, len(items))
		}
	}

	// Final: redo all and verify order
	sendRedo(t, manager, w)
	sendRedo(t, manager, w)
	sendRedo(t, manager, w)
	verifyOrder(t, w.Document().GetItems(), []string{"A", "B", "C"}, "after 100 cycles")

	t.Log("SUCCESS: 100 rapid undo/redo cycles maintain state consistency")
}

// =============================================================================
// DELETE UP TO HERE / DELETE FROM HERE — BUILTIN ITEM PROTECTION
// =============================================================================

// TestDeleteUpToHere_WithBuiltInItems tests the core bug: "delete up to here"
// should skip builtIn items. When only non-builtIn items are deleted, undo
// should restore them in the correct order.
func TestDeleteUpToHere_WithBuiltInItems(t *testing.T) {
	t.Parallel()
	doc := worker.NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Set up: [builtIn-sys(0), agents(1), user(2), error(3)]
	doc.AppendMessage(worker.ConversationItem{
		Type:                "system",
		ItemID:              "sys",
		Content:             "System prompt",
		PreventUserDeletion: true,
	})
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "agents",
		Content: "Agents",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeUser,
		ItemID:  "user",
		Content: "User msg",
	})
	doc.AppendMessage(worker.ConversationItem{
		Type:    worker.ItemTypeAssistant,
		ItemID:  "error",
		Content: "Error msg",
	})

	items := doc.GetItems()
	if len(items) != 4 {
		t.Fatalf("Expected 4 items, got %d", len(items))
	}

	// Clear undo history so setup inserts are not on the undo stack.
	tracker.ClearHistory()

	// Simulate "delete up to here" on error(3): delete agents(1) and user(2)
	// only (skipping builtIn sys). Delete in reverse order like the frontend does.
	tracker.DeleteMessages([]int{2}) // delete user (now at index 2)
	tracker.DeleteMessages([]int{1}) // delete agents (now at index 1)

	// Verify state after delete: [builtIn-sys, error]
	items = doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("Expected 2 items after delete, got %d", len(items))
	}
	if items[0].ItemID != "sys" || items[1].ItemID != "error" {
		t.Errorf("Expected [sys, error], got [%s, %s]", items[0].ItemID, items[1].ItemID)
	}

	// Undo both deletes → verify order is [builtIn-sys, agents, user, error]
	tracker.Undo() // restore agents
	tracker.Undo() // restore user
	items = doc.GetItems()
	if len(items) != 4 {
		t.Fatalf("Expected 4 items after undo, got %d", len(items))
	}
	expectedIDs := []string{"sys", "agents", "user", "error"}
	for i, expID := range expectedIDs {
		if items[i].ItemID != expID {
			t.Errorf("After undo: item %d expected ID %s, got %s", i, expID, items[i].ItemID)
		}
	}

	t.Log("SUCCESS: Delete up to here with builtIn items preserves order on undo")
}
