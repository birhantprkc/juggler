//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"fmt"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
)

// WaitForDocumentCondition polls the document until the condition returns true or timeout.
// Uses exponential backoff (10ms -> 100ms) for efficient polling.
func WaitForDocumentCondition(
	t *testing.T,
	w *worker.ConversationWorker,
	timeout time.Duration,
	condition func(*worker.ConversationDocument) bool,
) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		doc := w.Document()
		if doc != nil && condition(doc) {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for document condition after %v", timeout)
}

// WaitForItemCount waits for the items array to reach the specified length.
func WaitForItemCount(t *testing.T, w *worker.ConversationWorker, count int, timeout time.Duration) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		return len(items) == count
	})
}

// WaitForMinItemCount waits for the items array to have at least the specified length.
func WaitForMinItemCount(t *testing.T, w *worker.ConversationWorker, minCount int, timeout time.Duration) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		return len(items) >= minCount
	})
}

// WaitForApprovalState waits for a tool-action item to reach the specified approval state.
func WaitForApprovalState(
	t *testing.T,
	w *worker.ConversationWorker,
	toolUseID string,
	state string,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		item, _ := FindItemByToolUseID(doc, toolUseID)
		if item == nil {
			return false
		}
		return item.State == state
	})
}

// WaitForContextItemExists waits for a context item with the given ID to exist in the document.
// Context items are items with an itemId in the items array.
func WaitForContextItemExists(
	t *testing.T,
	w *worker.ConversationWorker,
	itemID string,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		for _, item := range items {
			if item.ItemID == itemID {
				return true
			}
		}
		return false
	})
}

// WaitForContextItemNotExists waits for a context item with the given ID to not exist in the document.
// Context items are items with an itemId in the items array.
func WaitForContextItemNotExists(
	t *testing.T,
	w *worker.ConversationWorker,
	itemID string,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		for _, item := range items {
			if item.ItemID == itemID {
				return false
			}
		}
		return true
	})
}

// WaitForContextItemCount waits for the context item count to reach the specified size.
// Context items are items with an itemId in the items array.
func WaitForContextItemCount(t *testing.T, w *worker.ConversationWorker, count int, timeout time.Duration) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		contextItemCount := 0
		for _, item := range items {
			if item.ItemID != "" {
				contextItemCount++
			}
		}
		return contextItemCount == count
	})
}

// WaitForMetadata waits for a metadata key to have the specified value.
func WaitForMetadata(
	t *testing.T,
	w *worker.ConversationWorker,
	key string,
	expectedValue any,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		actualValue := doc.GetMetadata(key)
		if actualValue == nil {
			return false
		}
		return fmt.Sprintf("%v", actualValue) == fmt.Sprintf("%v", expectedValue)
	})
}

// WaitForUndoAvailable waits for undo to become available or unavailable.
func WaitForUndoAvailable(t *testing.T, w *worker.ConversationWorker, available bool, timeout time.Duration) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		tracker := w.Tracker()
		if tracker != nil && tracker.CanUndo() == available {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for undo availability=%v after %v", available, timeout)
}

// WaitForRedoAvailable waits for redo to become available or unavailable.
func WaitForRedoAvailable(t *testing.T, w *worker.ConversationWorker, available bool, timeout time.Duration) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		tracker := w.Tracker()
		if tracker != nil && tracker.CanRedo() == available {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for redo availability=%v after %v", available, timeout)
}

// WaitForWorkerIdle waits for the worker to finish processing (no pending operations).
// This is useful when you need to ensure all async operations have completed.
func WaitForWorkerIdle(t *testing.T, w *worker.ConversationWorker, timeout time.Duration) error {
	t.Helper()

	// The worker doesn't expose an "idle" state directly, but we can check if
	// there are any pending items in the pipeline by observing the document state
	// stabilize (no changes for a brief period).

	deadline := time.Now().Add(timeout)
	var lastItemCount int
	stableCount := 0
	requiredStableChecks := 3 // Must be stable for 3 consecutive checks

	for time.Now().Before(deadline) {
		doc := w.Document()
		if doc == nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}

		items := doc.GetItems()
		currentItemCount := len(items)

		if currentItemCount == lastItemCount {
			stableCount++
			if stableCount >= requiredStableChecks {
				return nil
			}
		} else {
			stableCount = 0
		}

		lastItemCount = currentItemCount
		time.Sleep(50 * time.Millisecond)
	}

	return fmt.Errorf("timeout waiting for worker to be idle after %v", timeout)
}

// WaitForWorkerState waits for the worker to reach the specified state.
// Uses exponential backoff (10ms -> 100ms) for efficient polling.
func WaitForWorkerState(t *testing.T, w *worker.ConversationWorker, state worker.WorkerState, timeout time.Duration) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		if w.State() == state {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for worker state %q (current: %q) after %v", state, w.State(), timeout)
}

// WaitForItemType waits for an item at the given index to have the specified type.
func WaitForItemType(
	t *testing.T,
	w *worker.ConversationWorker,
	index int,
	itemType string,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		if index >= len(items) {
			return false
		}
		return items[index].Type == itemType
	})
}
