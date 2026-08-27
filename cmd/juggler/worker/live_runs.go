//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The live-run registry.
//
// A dispatched turn runs on a goroutine of its own with a turnState of its own,
// which is what lets the run loop keep pumping the mailbox — and so handle a
// cancel, a pause or a sync update — while the turn streams. The consequence is
// that the worker's ambient turn is no longer the one running, so every question
// of the form "what is in flight in this conversation" needs somewhere else to
// look. This is that somewhere: one entry per turn goroutine.
//
// Published as an immutable slice behind an atomic.Pointer and rewritten
// copy-on-write. Only the run loop writes it — registering at dispatch, retiring
// when the turn hands itself back — so the rewrite races with nothing; readers
// take a snapshot and are free to be on any goroutine, which Stop, the wake
// interrupt and the manager's activity scan all are.

// liveRunEntry names one turn goroutine.
type liveRunEntry struct {
	// threadItemID is the thread the run was dispatched on, fixed for the run's
	// lifetime. The run's own thread field is plain memory it owns, so this is
	// the copy anyone off that goroutine may read.
	threadItemID string
	t            *turnState
}

// liveRuns returns the current registry snapshot. Never mutated in place, so the
// caller may hold it across anything.
func (w *ConversationWorker) liveRuns() []liveRunEntry {
	if p := w.liveRunsPtr.Load(); p != nil {
		return *p
	}
	return nil
}

// hasLiveRun reports whether any turn is on its own goroutine right now.
func (w *ConversationWorker) hasLiveRun() bool {
	return len(w.liveRuns()) > 0
}

// liveRun returns the turn currently running, or nil when none is. Singular
// because the dispatch gates admit exactly one at a time; Phase G, which lifts
// them, is where callers have to say which run they mean.
func (w *ConversationWorker) liveRun() *liveRunEntry {
	runs := w.liveRuns()
	if len(runs) == 0 {
		return nil
	}
	return &runs[0]
}

// allTurnStates returns every turn this worker owns: the live ones and the
// ambient one. What a teardown or a system-wake interrupt has to sweep, since
// either can arrive with a turn on its own goroutine or with none at all.
func (w *ConversationWorker) allTurnStates() []*turnState {
	runs := w.liveRuns()
	out := make([]*turnState, 0, len(runs)+1)
	for _, e := range runs {
		out = append(out, e.t)
	}
	return append(out, w.turn)
}

// registerLiveRun publishes a turn as running. Run goroutine only.
func (w *ConversationWorker) registerLiveRun(threadItemID string, t *turnState) {
	cur := w.liveRuns()
	next := make([]liveRunEntry, len(cur), len(cur)+1)
	copy(next, cur)
	next = append(next, liveRunEntry{threadItemID: threadItemID, t: t})
	w.liveRunsPtr.Store(&next)
}

// retireLiveRun drops a finished turn from the registry. Run goroutine only.
func (w *ConversationWorker) retireLiveRun(t *turnState) {
	cur := w.liveRuns()
	next := make([]liveRunEntry, 0, len(cur))
	for _, e := range cur {
		if e.t != t {
			next = append(next, e)
		}
	}
	w.liveRunsPtr.Store(&next)
}

// beginTurn prepares the run a dispatch is about to start on threadItemID.
//
// Under a live run loop that is a fresh turnState, seeded with the state a TURN
// owns across its dispatches and published to the registry before the caller
// marks it busy — so the conversation is never readable as idle between the two.
// With no loop behind it — the tests that drive the strategy loop directly — it
// is the ambient turn itself, which is where those call sites have always run.
func (r *run) beginTurn(threadItemID string) *run {
	tr := r
	if r.actorStarted.Load() {
		t := newTurnState()
		r.seedTurnBoundary(t)
		tr = r.runFor(t)
	}
	tr.t.thread.itemID = threadItemID
	if threadItemID != "" {
		tr.t.thread.itemsArray = r.doc.GetThreadItemsArray(threadItemID)
	} else {
		tr.t.thread.itemsArray = nil
	}
	if tr != r {
		r.registerLiveRun(threadItemID, tr.t)
	}
	return tr
}

// runTurn starts a prepared run's strategy loop: on its own goroutine when there
// is a run loop to keep pumping the mailbox while it streams, inline otherwise.
//
// The ambient turn's busy state was the conversation's while this dispatch was
// being decided; the run that owns it now carries it, so it is handed back to
// idle here — after the registry entry is published, so no reader passing
// through sees an idle conversation whose turn has already started.
func (r *run) runTurn(tr *run, body func(*run)) {
	if tr == r {
		body(tr)
		return
	}
	r.storeState(StateIdle)
	go func() {
		defer close(tr.t.finished)
		defer r.retireTurn(tr.t)
		body(tr)
	}()
}

// retireTurn hands a finished turn back to the run loop. Called from the turn's
// own goroutine as it unwinds; falls through on shutdown, where there is no loop
// left to hand anything to.
func (w *ConversationWorker) retireTurn(t *turnState) {
	select {
	case w.turnRetired <- t:
	case <-w.done:
	}
}

// finishRetiredTurn folds a finished turn goroutine back into the worker. Run
// goroutine only. The reducer stays out of the way for as long as a turn is live
// (see drainReconcile), so this is also the moment it is asked for the pass that
// settles whatever the turn left behind.
func (r *run) finishRetiredTurn(t *turnState) {
	r.retireLiveRun(t)
	r.adoptTurnBoundary(t)
	r.needsReconcile.Store(true)
}

// adoptTurnBoundary copies the state a TURN owns — its destination thread, the
// spinner's elapsed anchor, and the notices and throttles that dedupe within a
// turn — out of a finished run and into the ambient turn.
//
// A turn is longer than a run: it spans one dispatch per LLM round-trip, and
// only the last of them ends it. Between two of them there is no run to hold
// that state, so the ambient turn holds it and seedTurnBoundary hands it to the
// next dispatch. Without the hand-back the elapsed digit would restart at zero
// every time a tool completed.
func (r *run) adoptTurnBoundary(t *turnState) {
	r.t.thread = t.thread
	r.t.processingStartedAt.Store(t.processingStartedAt.Load())
	r.t.approvalWaitStartedAt.Store(t.approvalWaitStartedAt.Load())
	r.t.wasBlockedOnApprovals = t.wasBlockedOnApprovals
	r.t.lastProgressWriteMs = t.lastProgressWriteMs
	r.t.lastCacheMissNotice = t.lastCacheMissNotice
	r.t.lastProviderNotice = t.lastProviderNotice
}

// seedTurnBoundary is adoptTurnBoundary's inverse: it hands the ambient turn's
// boundary state to the fresh run continuing the same turn. The destination
// thread is not copied — a dispatch names its own.
func (r *run) seedTurnBoundary(t *turnState) {
	t.processingStartedAt.Store(r.t.processingStartedAt.Load())
	t.approvalWaitStartedAt.Store(r.t.approvalWaitStartedAt.Load())
	t.wasBlockedOnApprovals = r.t.wasBlockedOnApprovals
	t.lastProgressWriteMs = r.t.lastProgressWriteMs
	t.lastCacheMissNotice = r.t.lastCacheMissNotice
	t.lastProviderNotice = r.t.lastProviderNotice
}

// nudgeRetryWait tells a run parked in a retry backoff on this thread that a
// fresh user message is queued for it. The wait loops no longer read the
// mailbox, so this is the explicit signal that carries an intake through to a
// turn that has no boundary coming.
func (w *ConversationWorker) nudgeRetryWait(threadItemID string) {
	for _, e := range w.liveRuns() {
		if e.threadItemID == threadItemID {
			e.t.signalInterject()
		}
	}
}
