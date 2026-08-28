//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/osactivity"

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
	readOnly     bool
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

// liveThreadSet returns the thread ids whose state is owned by live run
// goroutines. Actor-side reconciliation uses the snapshot to leave those
// subtrees alone while continuing to settle idle siblings.
func (w *ConversationWorker) liveThreadSet() map[string]bool {
	owned := make(map[string]bool)
	for _, live := range w.liveRuns() {
		owned[live.threadItemID] = true
	}
	return owned
}

// liveRunForThread returns the live run on threadItemID, or nil when that
// thread is not running.
func (w *ConversationWorker) liveRunForThread(threadItemID string) *liveRunEntry {
	runs := w.liveRuns()
	for i := range runs {
		if runs[i].threadItemID == threadItemID {
			return &runs[i]
		}
	}
	return nil
}

// liveRunOwns reports whether t belongs to a published live run. Status paths
// use it to distinguish a turn goroutine handing finalization to retirement
// from actor-side reducer cleanup that must finalize immediately.
func (w *ConversationWorker) liveRunOwns(t *turnState) bool {
	for _, live := range w.liveRuns() {
		if live.t == t {
			return true
		}
	}
	return false
}

// canAdmitThread reports whether threadItemID can join the current live set.
// The durable thread stamp is the admission input: root and unstamped children
// are write-capable, while stamped read-only children may share the writer slot.
func (w *ConversationWorker) canAdmitThread(threadItemID string) bool {
	readOnly := w.threadIsReadOnly(threadItemID)
	for _, live := range w.liveRuns() {
		if live.threadItemID == threadItemID {
			return false
		}
		if !readOnly && !live.readOnly {
			return false
		}
	}
	return true
}

// exclusivelyOwnsConversation reports whether this run is the only live owner.
// Compaction rewrites shared ancestry and therefore cannot use read-only sibling
// admission: it retains conversation-wide exclusion.
func (r *run) exclusivelyOwnsConversation() bool {
	if !r.actorStarted.Load() {
		return true
	}
	runs := r.liveRuns()
	return len(runs) == 1 && runs[0].t == r.t
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

// registerLiveRun publishes a turn as running. Actor goroutine only.
func (w *ConversationWorker) registerLiveRun(threadItemID string, t *turnState) {
	cur := w.liveRuns()
	if len(cur) == 0 && !w.activityAsserted {
		osactivity.Begin()
		w.activityAsserted = true
	}
	next := make([]liveRunEntry, len(cur), len(cur)+1)
	copy(next, cur)
	next = append(next, liveRunEntry{
		threadItemID: threadItemID,
		readOnly:     w.threadIsReadOnly(threadItemID),
		t:            t,
	})
	w.liveRunsPtr.Store(&next)
}

// retireLiveRun drops a finished turn from the registry. Actor goroutine only.
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
		r.seedThreadBoundary(threadItemID, t)
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
		defer r.retireTurn(tr.t)
		defer close(tr.t.finished)
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
	r.turnBoundaries[t.thread.itemID] = boundaryFromTurn(t)
	if t.completedIdle {
		r.bumpTurnCounterAtIdle()
	}
	if !r.hasLiveRun() {
		if r.activityAsserted {
			osactivity.End()
			r.activityAsserted = false
		}
		r.finishIdleTransition()
	} else {
		// Publish this sibling's terminal frame promptly without closing the shared
		// undo capture window still used by live runs.
		r.batcher.Flush()
	}
	r.needsReconcile.Store(true)
}

// turnBoundary is the state one logical turn carries between its LLM runs.
type turnBoundary struct {
	processingStartedAt   int64
	approvalWaitStartedAt int64
	wasBlockedOnApprovals bool
	lastProgressWriteMs   int64
	lastCacheMissNotice   string
	lastProviderNotice    string
}

func boundaryFromTurn(t *turnState) turnBoundary {
	return turnBoundary{
		processingStartedAt:   t.processingStartedAt.Load(),
		approvalWaitStartedAt: t.approvalWaitStartedAt.Load(),
		wasBlockedOnApprovals: t.wasBlockedOnApprovals,
		lastProgressWriteMs:   t.lastProgressWriteMs,
		lastCacheMissNotice:   t.lastCacheMissNotice,
		lastProviderNotice:    t.lastProviderNotice,
	}
}

// seedThreadBoundary gives a fresh run only the boundary owned by its thread.
// The actor owns this map, so siblings retiring in either order cannot overwrite
// one another's continuation state.
func (r *run) seedThreadBoundary(threadItemID string, t *turnState) {
	boundary, ok := r.turnBoundaries[threadItemID]
	if !ok {
		return
	}
	t.processingStartedAt.Store(boundary.processingStartedAt)
	t.approvalWaitStartedAt.Store(boundary.approvalWaitStartedAt)
	t.wasBlockedOnApprovals = boundary.wasBlockedOnApprovals
	t.lastProgressWriteMs = boundary.lastProgressWriteMs
	t.lastCacheMissNotice = boundary.lastCacheMissNotice
	t.lastProviderNotice = boundary.lastProviderNotice
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
