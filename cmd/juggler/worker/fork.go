//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// metaForkParked is a one-shot doc-metadata marker stamped on a conversation
// copied from a running source. It tells the clone's first init to load stopped
// (rest instead of auto-resuming an in-flight tool); reconcileProcessingStateOnLoad
// consumes it so a later reload behaves like any normal conversation.
const metaForkParked = "forkParked"

// SnapshotParkedState returns an independent, race-free doc-state snapshot of a
// conversation whose turn is actively running, marked so the clone that loads it
// rests instead of auto-resuming the in-flight turn. ok=true ONLY when a loaded
// worker has a turn owning the run loop (loadState != idle) — precisely the case
// where a flush would block. ok=false otherwise (no worker, or a settled/
// approval-parked source): the caller then flushes + copies the on-disk doc,
// whose persisted state is authoritative and whose clone must re-drive normally.
// Confining the marker to a running source is what keeps a clone of an
// approval-parked conversation re-establishing awaiting_llm on load rather than
// being wrongly parked.
func (m *Manager) SnapshotParkedState(conversationID string) ([]byte, bool) {
	w := m.Get(conversationID)
	if w == nil || w.anyRunState() == StateIdle {
		return nil, false
	}
	return w.snapshotParked(), true
}

// snapshotParked builds a standalone copy of the live doc and stamps the parked
// marker on the COPY — never the live source, whose running turn must not be
// perturbed. ToState is taken under ycrdtMu, so it interleaves at a transaction
// boundary: a complete, internally-consistent CRDT state even mid-turn, with no
// dependence on the (turn-blocked) run loop. Marking a throwaway doc keeps the
// source's in-flight state pristine.
func (w *ConversationWorker) snapshotParked() []byte {
	state := w.doc.ToState() // race-free snapshot of the running doc

	tmp := NewConversationDocument(w.doc.ConversationID(), w.doc.AuthorID())
	defer tmp.Destroy()
	_ = tmp.LoadFromState(state)
	tmp.SetMetadata(metaForkParked, true)
	return tmp.ToState()
}
