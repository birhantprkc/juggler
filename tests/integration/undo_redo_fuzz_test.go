//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"fmt"
	"juggler/cmd/juggler/worker"
	"juggler/tests/helpers"
	"sort"
	"testing"
	"time"
)

// FuzzUndoRedoInsertDelete performs random sequences of inserts and deletes,
// then verifies that undoing all operations restores the empty initial state.
func FuzzUndoRedoInsertDelete(f *testing.F) {
	// Seed corpus: each byte encodes an operation
	f.Add([]byte{0x00, 0x01, 0x02, 0x80, 0x03})             // inserts then a delete
	f.Add([]byte{0x00, 0x01, 0x02, 0x03, 0x80, 0x81, 0x82}) // inserts then deletes
	f.Add([]byte{0x00, 0x80})                               // insert then delete
	f.Add([]byte{0x00, 0x01, 0x80, 0x02, 0x80})             // interleaved

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 100 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		opCount := 0
		nextID := 0

		for _, b := range data {
			if b < 0x80 {
				// Insert operation
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				idx := 0
				length := doc.GetItemsLength()
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})
				opCount++
			} else {
				// Delete operation
				length := doc.GetItemsLength()
				if length == 0 {
					continue
				}
				idx := int(b-0x80) % length
				tracker.DeleteMessages([]int{idx})
				opCount++
			}
		}

		// Capture final state before undoing
		finalItems := doc.GetItems()
		finalIDs := make([]string, len(finalItems))
		for i, item := range finalItems {
			finalIDs[i] = item.ItemID
		}

		// Undo all operations — should return to empty state
		for i := 0; i < opCount; i++ {
			tracker.Undo()
		}

		items := doc.GetItems()
		if len(items) != 0 {
			t.Errorf("After undoing all %d ops, expected 0 items, got %d", opCount, len(items))
		}

		// Redo all operations — should return to final state exactly
		for i := 0; i < opCount; i++ {
			tracker.Redo()
		}

		redone := doc.GetItems()
		if len(redone) != len(finalIDs) {
			t.Fatalf("After redo all: expected %d items, got %d", len(finalIDs), len(redone))
		}
		for i, expID := range finalIDs {
			if redone[i].ItemID != expID {
				t.Errorf("After redo all: item %d expected %s, got %s", i, expID, redone[i].ItemID)
			}
		}

		// Undo all again to verify consistency
		for i := 0; i < opCount; i++ {
			tracker.Undo()
		}

		items = doc.GetItems()
		if len(items) != 0 {
			t.Errorf("After second full undo, expected 0 items, got %d", len(items))
		}
	})
}

// FuzzUndoRedoWithBuiltInItems performs random insert/delete operations on
// non-builtIn items while a fixed builtIn item (system prompt) exists at index 0.
// Verifies the builtIn item always survives undo/redo and non-builtIn items
// return to the correct state.
func FuzzUndoRedoWithBuiltInItems(f *testing.F) {
	f.Add([]byte{0x00, 0x01, 0x80, 0x02})
	f.Add([]byte{0x00, 0x80, 0x00, 0x80})
	f.Add([]byte{0x00, 0x01, 0x02, 0x80, 0x80})

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 100 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		// Start with a builtIn item (system prompt) at index 0
		doc.AppendMessage(worker.ConversationItem{
			Type:                "system",
			ItemID:              "sys-builtin",
			Content:             "System",
			PreventUserDeletion: true,
		})

		opCount := 0
		nextID := 0

		for _, b := range data {
			if b < 0x80 {
				// Insert non-builtIn after the builtIn item
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				length := doc.GetItemsLength()
				idx := 1 // at minimum after builtIn
				if length > 1 {
					idx = 1 + int(b)%(length) // range [1, length]
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})
				opCount++
			} else {
				// Delete a non-builtIn item if one exists
				items := doc.GetItems()
				var nonBuiltInIndices []int
				for i, item := range items {
					if !item.PreventUserDeletion {
						nonBuiltInIndices = append(nonBuiltInIndices, i)
					}
				}
				if len(nonBuiltInIndices) == 0 {
					continue
				}
				idx := nonBuiltInIndices[int(b-0x80)%len(nonBuiltInIndices)]
				tracker.DeleteMessages([]int{idx})
				opCount++
			}
		}

		// Undo all tracked operations — should return to just builtIn item
		for i := 0; i < opCount; i++ {
			tracker.Undo()
		}

		items := doc.GetItems()
		if len(items) != 1 {
			t.Errorf("After undo all: expected 1 item (builtIn), got %d", len(items))
		}
		if len(items) > 0 && !items[0].PreventUserDeletion {
			t.Errorf("After undo all: expected builtIn item at index 0, got %s", items[0].ItemID)
		}

		// Redo all
		for i := 0; i < opCount; i++ {
			tracker.Redo()
		}

		// BuiltIn should still be at index 0
		items = doc.GetItems()
		if len(items) == 0 || !items[0].PreventUserDeletion {
			t.Errorf("After redo all: builtIn item missing or not at index 0")
		}
	})
}

// FuzzUndoRedoOrderPreservation performs random insert/delete sequences, then
// verifies that undo-all followed by redo-all produces the same final state.
func FuzzUndoRedoOrderPreservation(f *testing.F) {
	f.Add([]byte{0x00, 0x01, 0x02, 0x80, 0x03, 0x04})
	f.Add([]byte{0x00, 0x01, 0x80, 0x80, 0x02})
	f.Add([]byte{0x00, 0x01, 0x02, 0x03, 0x04})

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 100 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		opCount := 0
		nextID := 0

		for _, b := range data {
			if b < 0x80 {
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				length := doc.GetItemsLength()
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})
				opCount++
			} else {
				length := doc.GetItemsLength()
				if length == 0 {
					continue
				}
				idx := int(b-0x80) % length
				tracker.DeleteMessages([]int{idx})
				opCount++
			}
		}

		// Capture final state
		finalItems := doc.GetItems()
		finalIDs := make([]string, len(finalItems))
		for i, item := range finalItems {
			finalIDs[i] = item.ItemID
		}

		// Undo all
		for i := 0; i < opCount; i++ {
			tracker.Undo()
		}

		// Redo all — should match final state exactly
		for i := 0; i < opCount; i++ {
			tracker.Redo()
		}

		redoneItems := doc.GetItems()
		if len(redoneItems) != len(finalIDs) {
			t.Fatalf("After undo-all/redo-all: expected %d items, got %d", len(finalIDs), len(redoneItems))
		}
		for i, expID := range finalIDs {
			if redoneItems[i].ItemID != expID {
				t.Errorf("After undo-all/redo-all: item %d expected %s, got %s", i, expID, redoneItems[i].ItemID)
			}
		}
	})
}

// FuzzUndoRedoAllOps performs random sequences of insert, delete, replace, and
// move operations, then verifies undo-all restores the empty state and redo-all
// reproduces the final state.
func FuzzUndoRedoAllOps(f *testing.F) {
	// Byte encoding:
	// 0x00..0x3F  insert
	// 0x40..0x7F  replace content of existing item
	// 0x80..0xBF  delete
	// 0xC0..0xFF  move
	f.Add([]byte{0x00, 0x01, 0x40, 0x80, 0x02, 0xC0})
	f.Add([]byte{0x00, 0x01, 0x02, 0x41, 0x42, 0x80, 0xC1})
	f.Add([]byte{0x00, 0x40, 0x00, 0x40}) // insert, replace, insert, replace

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 80 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		opCount := 0
		nextID := 0
		replaceSeq := 0

		for _, b := range data {
			length := doc.GetItemsLength()

			switch {
			case b < 0x40: // insert
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})
				opCount++

			case b < 0x80: // replace
				if length == 0 {
					continue
				}
				idx := int(b-0x40) % length
				items := doc.GetItems()
				replaceSeq++
				updated := items[idx]
				updated.Content = fmt.Sprintf("%s-r%d", updated.Content, replaceSeq)
				_ = tracker.ReplaceMessage(idx, updated)
				opCount++

			case b < 0xC0: // delete
				if length == 0 {
					continue
				}
				idx := int(b-0x80) % length
				tracker.DeleteMessages([]int{idx})
				opCount++

			default: // move
				if length < 2 {
					continue
				}
				from := int(b-0xC0) % length
				to := (from + 1 + int(b)%max(length-1, 1)) % length
				if from == to {
					continue
				}
				_ = tracker.MoveMessage(from, to)
				opCount++
			}
		}

		// Capture final state
		finalItems := doc.GetItems()
		type snapshot struct {
			id, content string
		}
		finalSnap := make([]snapshot, len(finalItems))
		for i, item := range finalItems {
			finalSnap[i] = snapshot{item.ItemID, item.Content}
		}

		// Undo all — should return to empty
		for i := 0; i < opCount; i++ {
			tracker.Undo()
		}
		if n := doc.GetItemsLength(); n != 0 {
			t.Errorf("After undo all %d ops: expected 0 items, got %d", opCount, n)
		}

		// Redo all — should match final state
		for i := 0; i < opCount; i++ {
			tracker.Redo()
		}
		redone := doc.GetItems()
		if len(redone) != len(finalSnap) {
			t.Fatalf("After redo all: expected %d items, got %d", len(finalSnap), len(redone))
		}
		for i, exp := range finalSnap {
			if redone[i].ItemID != exp.id || redone[i].Content != exp.content {
				t.Errorf("Item %d: expected %s/%s, got %s/%s",
					i, exp.id, exp.content, redone[i].ItemID, redone[i].Content)
			}
		}
	})
}

// FuzzUndoRedoWithIndexShifts exercises ID-based resolution by inserting
// untracked builtIn items between undo/redo steps, shifting all indices.
// Verifies that undo/redo still produces correct results despite the shifts.
func FuzzUndoRedoWithIndexShifts(f *testing.F) {
	// Byte encoding:
	// 0x00..0x3F  insert tracked item
	// 0x40..0x5F  delete tracked item
	// 0x60..0x7F  replace tracked item
	// 0x80..0x9F  insert untracked builtIn (shifts indices)
	// 0xA0..0xBF  undo
	// 0xC0..0xFF  redo
	f.Add([]byte{0x00, 0x01, 0x40, 0x80, 0xA0, 0xC0}) // insert, insert, delete, shift, undo, redo
	f.Add([]byte{0x00, 0x01, 0x80, 0xA0, 0xA0})       // inserts, shift, undo, undo
	f.Add([]byte{0x00, 0x60, 0x80, 0xA0, 0xA0, 0xC0}) // insert, replace, shift, undo, undo, redo

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 80 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		nextID := 0
		builtInID := 0

		for _, b := range data {
			length := doc.GetItemsLength()

			switch {
			case b < 0x40: // insert tracked
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})

			case b < 0x60: // delete tracked
				items := doc.GetItems()
				var nonBuiltIn []int
				for i, item := range items {
					if !item.PreventUserDeletion {
						nonBuiltIn = append(nonBuiltIn, i)
					}
				}
				if len(nonBuiltIn) == 0 {
					continue
				}
				idx := nonBuiltIn[int(b-0x40)%len(nonBuiltIn)]
				tracker.DeleteMessages([]int{idx})

			case b < 0x80: // replace tracked
				items := doc.GetItems()
				var nonBuiltIn []int
				for i, item := range items {
					if !item.PreventUserDeletion {
						nonBuiltIn = append(nonBuiltIn, i)
					}
				}
				if len(nonBuiltIn) == 0 {
					continue
				}
				idx := nonBuiltIn[int(b-0x60)%len(nonBuiltIn)]
				updated := items[idx]
				updated.Content += "-edited"
				_ = tracker.ReplaceMessage(idx, updated)

			case b < 0xA0: // insert untracked builtIn (index shift!)
				id := fmt.Sprintf("builtin-%d", builtInID)
				builtInID++
				idx := 0
				if length > 0 {
					idx = int(b-0x80) % (length + 1)
				}
				doc.InsertMessage(idx, worker.ConversationItem{
					Type:                "system",
					ItemID:              id,
					Content:             id,
					PreventUserDeletion: true,
				})

			case b < 0xC0: // undo
				tracker.Undo()

			default: // redo
				tracker.Redo()
			}
		}

		// Invariant: no panics, no duplicate IDs, no items with empty type
		items := doc.GetItems()
		seen := make(map[string]bool)
		for i, item := range items {
			if item.ItemID == "" {
				t.Errorf("Item %d has empty ItemID", i)
			}
			if seen[item.ItemID] {
				t.Errorf("Duplicate ItemID %s at index %d", item.ItemID, i)
			}
			seen[item.ItemID] = true
			if item.Type == "" {
				t.Errorf("Item %d (%s) has empty type", i, item.ItemID)
			}
		}

		// Redo to top-of-stack for canonical state, then verify undo-all/redo-all cycle.
		// This tests that ID-based resolution actually produces the correct result, not just
		// that the structure is intact.
		for tracker.CanRedo() {
			tracker.Redo()
		}
		type idContentSnap struct{ id, content string }
		topItems := doc.GetItems()
		topSnap := make([]idContentSnap, len(topItems))
		for i, item := range topItems {
			topSnap[i] = idContentSnap{item.ItemID, item.Content}
		}

		for tracker.CanUndo() {
			tracker.Undo()
		}
		for tracker.CanRedo() {
			tracker.Redo()
		}

		redone := doc.GetItems()
		if len(redone) != len(topSnap) {
			t.Fatalf("After full undo/redo cycle: expected %d items, got %d", len(topSnap), len(redone))
		}
		for i, exp := range topSnap {
			if redone[i].ItemID != exp.id || redone[i].Content != exp.content {
				t.Errorf("Item %d: expected %s/%s, got %s/%s", i, exp.id, exp.content, redone[i].ItemID, redone[i].Content)
			}
		}
	})
}

// FuzzUndoRedoMultiDelete exercises multi-index delete operations where
// multiple items are deleted in a single call. Verifies undo restores all
// items and redo re-deletes the correct items by ID.
func FuzzUndoRedoMultiDelete(f *testing.F) {
	f.Add([]byte{5, 0x03, 0x80 | 3}) // 5 items, delete 3, multi-delete mask
	f.Add([]byte{8, 0x05, 0xFF})     // 8 items, delete 5
	f.Add([]byte{3, 0x02, 0x01})     // 3 items, delete 2

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) < 3 {
			return
		}

		numItems := int(data[0])%20 + 2 // 2..21 items
		numDelete := int(data[1])%numItems + 1
		if numDelete > numItems {
			numDelete = numItems
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		// Insert items (untracked, just populate)
		for i := 0; i < numItems; i++ {
			doc.AppendMessage(worker.ConversationItem{
				Type:    worker.ItemTypeUser,
				ItemID:  fmt.Sprintf("item-%d", i),
				Content: fmt.Sprintf("content-%d", i),
			})
		}

		// Pick indices to delete using remaining fuzz bytes
		allIndices := make([]int, numItems)
		for i := range allIndices {
			allIndices[i] = i
		}
		// Shuffle using fuzz data
		for i := range min(len(data)-2, numItems) {
			j := int(data[2+i]) % (numItems - i)
			allIndices[i], allIndices[i+j] = allIndices[i+j], allIndices[i]
		}
		deleteIndices := allIndices[:numDelete]
		sort.Sort(sort.Reverse(sort.IntSlice(deleteIndices)))

		// Capture pre-delete state
		preDeleteIDs := make([]string, numItems)
		for i, item := range doc.GetItems() {
			preDeleteIDs[i] = item.ItemID
		}

		// Multi-delete in one call
		tracker.DeleteMessages(deleteIndices)

		postDeleteItems := doc.GetItems()
		postDeleteIDs := make([]string, len(postDeleteItems))
		for i, item := range postDeleteItems {
			postDeleteIDs[i] = item.ItemID
		}

		// Undo — should restore all items
		tracker.Undo()
		items := doc.GetItems()
		if len(items) != numItems {
			t.Fatalf("After undo: expected %d items, got %d", numItems, len(items))
		}
		for i, item := range items {
			if item.ItemID != preDeleteIDs[i] {
				t.Errorf("After undo: item %d expected %s, got %s", i, preDeleteIDs[i], item.ItemID)
			}
		}

		// Redo — should re-delete the same items by ID
		tracker.Redo()
		items = doc.GetItems()
		if len(items) != len(postDeleteIDs) {
			t.Fatalf("After redo: expected %d items, got %d", len(postDeleteIDs), len(items))
		}
		for i, item := range items {
			if item.ItemID != postDeleteIDs[i] {
				t.Errorf("After redo: item %d expected %s, got %s", i, postDeleteIDs[i], item.ItemID)
			}
		}
	})
}

// FuzzUndoRedoBranchingHistory exercises partial undo followed by new operations
// (which truncates the redo stack), then more undo/redo. This tests the
// branching history path that the other fuzzers skip. All four mutation types
// (insert, delete, replace, move) are included so each can be tested as the
// operation that clears a pending redo stack.
func FuzzUndoRedoBranchingHistory(f *testing.F) {
	// Byte encoding:
	// 0x00..0x3F  insert
	// 0x40..0x5F  delete
	// 0x60..0x7F  replace
	// 0x80..0x9F  move
	// 0xA0..0xBF  undo
	// 0xC0..0xFF  redo
	f.Add([]byte{0x00, 0x01, 0x02, 0xA0, 0x00, 0xA0, 0xC0}) // insert*3, undo, insert, undo, redo
	f.Add([]byte{0x00, 0x01, 0xA0, 0xA0, 0x02, 0x03})       // insert*2, undo*2, insert*2 (branch)
	f.Add([]byte{0x00, 0x40, 0xA0, 0x00, 0xC0})             // insert, delete, undo, insert, redo
	f.Add([]byte{0x00, 0x01, 0xA0, 0x60, 0xC0})             // insert*2, undo, replace (clears redo), redo=noop
	f.Add([]byte{0x00, 0x01, 0xA0, 0x80, 0xA0})             // insert*2, undo, move (clears redo), undo

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 80 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		nextID := 0
		replSeq := 0

		for _, b := range data {
			length := doc.GetItemsLength()

			switch {
			case b < 0x40: // insert
				id := fmt.Sprintf("item-%d", nextID)
				nextID++
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  id,
					Content: id,
				})

			case b < 0x60: // delete
				if length == 0 {
					continue
				}
				idx := int(b-0x40) % length
				tracker.DeleteMessages([]int{idx})

			case b < 0x80: // replace
				if length == 0 {
					continue
				}
				idx := int(b-0x60) % length
				items := doc.GetItems()
				updated := items[idx]
				replSeq++
				updated.Content = fmt.Sprintf("%s-r%d", updated.Content, replSeq)
				_ = tracker.ReplaceMessage(idx, updated)

			case b < 0xA0: // move
				if length < 2 {
					continue
				}
				from := int(b-0x80) % length
				to := (from + 1) % length
				_ = tracker.MoveMessage(from, to)

			case b < 0xC0: // undo
				tracker.Undo()

			default: // redo
				tracker.Redo()
			}
		}

		// Redo to top-of-stack to get the canonical "fully applied" state
		for tracker.CanRedo() {
			tracker.Redo()
		}
		type idContentSnap struct{ id, content string }
		topItems := doc.GetItems()
		topSnap := make([]idContentSnap, len(topItems))
		for i, item := range topItems {
			topSnap[i] = idContentSnap{item.ItemID, item.Content}
		}

		// Undo all, then redo all — should reproduce the top state exactly
		for tracker.CanUndo() {
			tracker.Undo()
		}
		for tracker.CanRedo() {
			tracker.Redo()
		}

		redone := doc.GetItems()
		if len(redone) != len(topSnap) {
			t.Fatalf("After full undo/redo cycle: expected %d items, got %d", len(topSnap), len(redone))
		}
		for i, exp := range topSnap {
			if redone[i].ItemID != exp.id || redone[i].Content != exp.content {
				t.Errorf("Item %d: expected %s/%s, got %s/%s", i, exp.id, exp.content, redone[i].ItemID, redone[i].Content)
			}
		}

		// No panics, no duplicates
		seen := make(map[string]bool)
		for _, item := range redone {
			if item.ItemID != "" && seen[item.ItemID] {
				t.Errorf("Duplicate ItemID: %s", item.ItemID)
			}
			seen[item.ItemID] = true
		}
	})
}

// FuzzUndoRedoWithThreads exercises undo/redo of thread items containing nested
// sub-items. This is a regression test for the bug where redo recreated thread
// Y.Maps without a proper Y.Array for nested items, breaking thread columns.
//
// Byte encoding:
//
//	0x00..0x1F  insert flat user message at root
//	0x20..0x3F  insert thread (with 0-3 nested child messages)
//	0x40..0x5F  delete root item
//	0x60..0x7F  insert child message into an existing thread
//	0x80..0xBF  undo
//	0xC0..0xFF  redo
func FuzzUndoRedoWithThreads(f *testing.F) {
	f.Add([]byte{0x20, 0x60, 0x40, 0x80, 0xC0})       // thread, add child, delete, undo, redo
	f.Add([]byte{0x20, 0x60, 0x60, 0x40, 0x80})       // thread, 2 children, delete thread, undo
	f.Add([]byte{0x00, 0x20, 0x60, 0x80, 0x80, 0xC0}) // msg, thread, child, undo, undo, redo
	f.Add([]byte{0x20, 0x21, 0x60, 0x40, 0x41, 0x80}) // 2 threads, child, delete both, undo

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 80 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-conv", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		nextID := 0
		newID := func() string {
			id := fmt.Sprintf("item-%d", nextID)
			nextID++
			return id
		}

		// Track thread itemIds for child insertion
		var threadIDs []string

		for _, b := range data {
			length := doc.GetItemsLength()

			switch {
			case b < 0x20: // insert flat user message
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}
				tracker.InsertMessage(idx, worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  newID(),
					Content: "user msg",
				})

			case b < 0x40: // insert thread with 0-3 nested children
				numChildren := int(b-0x20) % 4
				idx := 0
				if length > 0 {
					idx = int(b) % (length + 1)
				}

				// Use doc.InsertThread to create proper Y.Array structure
				nestedArr := doc.InsertThread(idx, "thread-goal")

				// Read back the generated thread ID
				threadID := doc.GetItems()[idx].ItemID
				threadIDs = append(threadIDs, threadID)

				// Add nested children
				for range numChildren {
					doc.InsertMessageIntoArray(nestedArr, int(nestedArr.GetLength()), worker.ConversationItem{
						Type:    worker.ItemTypeUser,
						ItemID:  newID(),
						Content: "child msg",
					})
				}

			case b < 0x60: // delete root item
				if length == 0 {
					continue
				}
				idx := int(b-0x40) % length
				tracker.DeleteMessages([]int{idx})

			case b < 0x80: // insert child into existing thread
				if len(threadIDs) == 0 {
					continue
				}
				threadID := threadIDs[int(b-0x60)%len(threadIDs)]
				arr := doc.GetThreadItemsArray(threadID)
				if arr == nil {
					continue // Thread may have been deleted
				}
				childID := newID()
				doc.InsertMessageIntoArray(arr, int(arr.GetLength()), worker.ConversationItem{
					Type:    worker.ItemTypeUser,
					ItemID:  childID,
					Content: "child msg",
				})

			case b < 0xC0: // undo
				tracker.Undo()

			default: // redo
				tracker.Redo()
			}
		}

		// Invariant: all thread items must have a valid nested Y.Array
		items := doc.GetItems()
		for i, item := range items {
			if item.Type == worker.ItemTypeThread {
				arr := doc.GetThreadItemsArray(item.ItemID)
				if arr == nil {
					t.Errorf("REGRESSION: Thread %s at index %d has no nested items Y.Array after fuzz sequence", item.ItemID, i)
				}
			}
		}

		// Invariant: no panics, no duplicate IDs, no empty types
		seen := make(map[string]bool)
		for i, item := range items {
			if item.ItemID == "" {
				t.Errorf("Item %d has empty ItemID", i)
			}
			if seen[item.ItemID] {
				t.Errorf("Duplicate ItemID %s at index %d", item.ItemID, i)
			}
			seen[item.ItemID] = true
			if item.Type == "" {
				t.Errorf("Item %d (%s) has empty type", i, item.ItemID)
			}
		}

		// Redo to top-of-stack, then snapshot root order + thread children.
		// Undo-all → redo-all must reproduce the same state, including thread child order.
		for tracker.CanRedo() {
			tracker.Redo()
		}
		type threadChildSnap struct {
			childIDs []string
		}
		topRoot := doc.GetItems()
		topRootIDs := make([]string, len(topRoot))
		topThreadChildren := make(map[string]threadChildSnap)
		for i, item := range topRoot {
			topRootIDs[i] = item.ItemID
			if item.Type == worker.ItemTypeThread {
				arr := doc.GetThreadItemsArray(item.ItemID)
				if arr == nil {
					continue
				}
				children := doc.GetItemsFromArray(arr)
				ids := make([]string, len(children))
				for j, c := range children {
					ids[j] = c.ItemID
				}
				topThreadChildren[item.ItemID] = threadChildSnap{ids}
			}
		}

		for tracker.CanUndo() {
			tracker.Undo()
		}
		for tracker.CanRedo() {
			tracker.Redo()
		}

		afterRoot := doc.GetItems()
		if len(afterRoot) != len(topRootIDs) {
			t.Fatalf("After undo/redo cycle: expected %d root items, got %d", len(topRootIDs), len(afterRoot))
		}
		for i, expID := range topRootIDs {
			if afterRoot[i].ItemID != expID {
				t.Errorf("Root item %d: expected %s, got %s", i, expID, afterRoot[i].ItemID)
			}
		}
		for _, item := range afterRoot {
			snap, ok := topThreadChildren[item.ItemID]
			if !ok {
				continue
			}
			arr := doc.GetThreadItemsArray(item.ItemID)
			if arr == nil {
				t.Errorf("Thread %s lost Y.Array after undo/redo cycle", item.ItemID)
				continue
			}
			children := doc.GetItemsFromArray(arr)
			if len(children) != len(snap.childIDs) {
				t.Errorf("Thread %s: expected %d children, got %d after undo/redo cycle", item.ItemID, len(snap.childIDs), len(children))
				continue
			}
			for j, expID := range snap.childIDs {
				if children[j].ItemID != expID {
					t.Errorf("Thread %s child %d: expected %s, got %s", item.ItemID, j, expID, children[j].ItemID)
				}
			}
		}
	})
}

// FuzzUndoRedoSubThreadContextItems exercises the code path fixed by the duplicate-itemId bug
// and extends it to cover the full thread lifecycle: threads themselves can be added, deleted,
// and undone interleaved with tracked context item operations inside their sub-arrays.
//
// Byte encoding:
//
//	0x00..0x1F  insert context item into a tracked thread (thread by index % len)
//	0x20..0x3F  delete context item from a tracked thread (by index)
//	0x40..0x5F  insert a new thread at root
//	0x60..0x7F  delete a root item (by index % rootLen)
//	0x80..0xBF  undo
//	0xC0..0xFF  redo
func FuzzUndoRedoSubThreadContextItems(f *testing.F) {
	// Bug regression: add, delete, re-add, undo×2
	f.Add([]byte{0x40, 0x00, 0x20, 0x01, 0x80, 0x80})
	// Thread lifecycle: add thread, add item, delete thread, undo, undo
	f.Add([]byte{0x40, 0x00, 0x60, 0x80, 0x80})
	// Full round-trip: add thread+item, delete thread, undo, redo, undo
	f.Add([]byte{0x40, 0x00, 0x60, 0x80, 0xC0, 0x80})
	// Two threads, add items to each, delete one, undo
	f.Add([]byte{0x40, 0x41, 0x00, 0x01, 0x60, 0x80})
	// Item in sub-thread → delete item → delete thread → undo×2
	f.Add([]byte{0x40, 0x00, 0x20, 0x60, 0x80, 0x80})
	// Tracked subthread item delete → undo → redo (exercises allowTombstone for nested items)
	f.Add([]byte{0x40, 0x00, 0x20, 0x80, 0xC0})
	// Tracked delete first item → undo → redo
	f.Add([]byte{0x40, 0x00, 0x01, 0x20, 0x80, 0xC0})
	// Two items, delete last, undo, redo, delete first, undo, redo
	f.Add([]byte{0x40, 0x00, 0x01, 0x21, 0x80, 0xC0, 0x20, 0x80, 0xC0})

	f.Fuzz(func(t *testing.T, data []byte) {
		helpers.PerTestTimeout(t, 10*time.Second)
		if len(data) == 0 || len(data) > 80 {
			return
		}

		doc := worker.NewConversationDocument("fuzz-subthread", "user:fuzz")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		// threadIDs tracks all thread IDs ever created (including currently deleted ones).
		// Ops that target a thread handle the "thread currently deleted" case by checking arr != nil.
		var threadIDs []string
		nextCtxNum := 0
		newCtxID := func() string {
			id := fmt.Sprintf("ctx-%d", nextCtxNum)
			nextCtxNum++
			return id
		}
		nextThreadNum := 0
		_ = nextThreadNum

		assertInvariants := func(label string) {
			seen := make(map[string]bool)
			rootItems := doc.GetItems()
			for i, item := range rootItems {
				if item.ItemID == "" {
					t.Errorf("%s: root item %d has empty ItemID", label, i)
				}
				if seen[item.ItemID] {
					t.Errorf("%s: duplicate root itemID %q at index %d", label, item.ItemID, i)
				}
				seen[item.ItemID] = true
			}
			for _, tid := range threadIDs {
				arr := doc.GetThreadItemsArray(tid)
				if arr == nil {
					continue // thread currently deleted — ok
				}
				subItems := doc.GetItemsFromArray(arr)
				for i, item := range subItems {
					if item.ItemID == "" {
						t.Errorf("%s: sub-thread %s item %d has empty ItemID", label, tid, i)
					}
					if seen[item.ItemID] {
						t.Errorf("%s: duplicate itemID %q in sub-thread %s at index %d", label, item.ItemID, tid, i)
					}
					seen[item.ItemID] = true
				}
			}
		}

		for i, b := range data {
			rootLen := doc.GetItemsLength()

			switch {
			case b < 0x20: // insert context item into a tracked thread
				if len(threadIDs) == 0 {
					continue
				}
				threadID := threadIDs[int(b)%len(threadIDs)]
				arr := doc.GetThreadItemsArray(threadID)
				if arr == nil {
					continue // thread currently deleted
				}
				subLen := doc.GetItemsLengthFromArray(arr)
				idx := 0
				if subLen > 0 {
					idx = int(b) % (subLen + 1)
				}
				ctxID := newCtxID()
				doc.InsertMessageIntoArray(arr, idx, worker.ConversationItem{Type: "rule", ItemID: ctxID})

			case b < 0x40: // delete context item from a tracked thread (via tracker — uses authorID)
				if len(threadIDs) == 0 {
					continue
				}
				threadID := threadIDs[int(b-0x20)%len(threadIDs)]
				arr := doc.GetThreadItemsArray(threadID)
				if arr == nil {
					continue
				}
				subLen := doc.GetItemsLengthFromArray(arr)
				if subLen == 0 {
					continue
				}
				idx := int(b-0x20) % subLen
				tracker.DeleteThreadItem(arr, idx)

			case b < 0x60: // insert a new thread at root
				idx := 0
				if rootLen > 0 {
					idx = int(b-0x40) % (rootLen + 1)
				}
				doc.InsertThread(idx, "thread-goal")
				// Read back the generated thread ID at the insertion point
				newItems := doc.GetItems()
				if idx >= len(newItems) {
					continue
				}
				threadID := newItems[idx].ItemID
				if threadID == "" {
					continue
				}
				threadIDs = append(threadIDs, threadID)

			case b < 0x80: // delete a root item
				if rootLen == 0 {
					continue
				}
				idx := int(b-0x60) % rootLen
				tracker.DeleteMessages([]int{idx})

			case b < 0xC0: // undo
				tracker.Undo()

			default: // redo
				tracker.Redo()
			}

			assertInvariants(fmt.Sprintf("step %d (b=0x%02x)", i, b))
		}
	})
}
