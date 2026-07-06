//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
)

// sweepTransactions deletes any transaction blob whose id is no longer
// reachable from the live items tree or the undo/redo stacks.
//
// Items in the live tree are scanned directly. Items that were deleted but
// are kept alive by UndoManager (for potential undo restoration) are scanned
// via the tracker's undo/redo stacks.
//
// Run after every persisted save (and on shutdown).
func (w *ConversationWorker) sweepTransactions() error {
	if w.txnStore == nil {
		return nil
	}

	live := make(map[string]bool)
	collectTxnIDsFromItems(w.doc.GetItems(), live)

	for _, id := range w.tracker.undoableTransactionIDs() {
		if id != "" {
			live[id] = true
		}
	}

	return w.txnStore.Sweep(w.conversationID, live)
}

// sweepAssets reclaims content-addressed asset blobs (attached images, etc.)
// under <convDir>/assets/ that are no longer referenced by the live doc.
//
// Run after every persisted save, alongside sweepTransactions.
func (w *ConversationWorker) sweepAssets() error {
	if w.assetStore == nil {
		return nil
	}
	live, keepAll := w.collectLiveAssetIDs()
	if keepAll {
		return nil
	}
	return w.assetStore.Sweep(w.conversationID, live, AssetStagingGrace)
}

// collectLiveAssetIDs returns the set of asset shas referenced by the live doc,
// plus keepAll: when true the sweep is skipped entirely (nothing is deleted).
//
// Walks all items (root + nested threads) collecting every attachment id, folds
// in ids referenced by unsent drafts and by queued pending messages (root +
// thread containers), then folds in
// ids restorable via the undo/redo stacks — mirroring sweepTransactions
// (collectTxnIDsFromItems + undoableTransactionIDs) so a just-deleted-but-undoable
// attachment is not GC'd prematurely.
func (w *ConversationWorker) collectLiveAssetIDs() (live map[string]bool, keepAll bool) {
	live = make(map[string]bool)
	collectAssetIDsFromItems(w.doc.GetItems(), live)

	// Unsent drafts reference staged-but-uncommitted attachments (root + every
	// thread container). Keep their bytes alive so a persisted draft survives a
	// restart with its images intact.
	w.doc.CollectDraftAssetIDs(live)

	// Queued ("type while busy") messages live in a pendingItems sibling array,
	// not in items — keep their attachment bytes alive until the message is
	// promoted, or a queued image's bytes could be swept before it is sent.
	w.doc.CollectPendingAssetIDs(live)

	for _, id := range w.tracker.undoableAssetIDs() {
		if id != "" {
			live[id] = true
		}
	}

	return live, false
}

// collectTxnIDsFromItems walks items recursively (into nested thread items)
// adding every TransactionID it encounters to dst.
func collectTxnIDsFromItems(items []ConversationItem, dst map[string]bool) {
	for _, it := range items {
		if it.TransactionID != "" {
			dst[it.TransactionID] = true
		}
		// Threads carry their nested items in Items as JSON.
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err == nil {
				collectTxnIDsFromItems(nested, dst)
			}
		}
	}
}

// collectAssetIDsFromItems walks items recursively (into nested thread items)
// adding every attachment id it encounters to dst. Mirrors collectTxnIDsFromItems.
func collectAssetIDsFromItems(items []ConversationItem, dst map[string]bool) {
	for _, it := range items {
		for _, att := range it.Attachments {
			if att.ID != "" {
				dst[att.ID] = true
			}
		}
		// Threads carry their nested items in Items as JSON.
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err == nil {
				collectAssetIDsFromItems(nested, dst)
			}
		}
	}
}
