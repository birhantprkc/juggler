//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// claimLLM atomically transitions the conversation into a claimed-for-LLM
// state against the given thread. The compare-and-set is done inside a
// single Yjs transaction: it reads processingState.activity and, if it
// is null/ActivityNone, writes the new claim. Returns true on success;
// false if another operation was already in flight.
//
// The claim is the doc-native source of truth for "is this conversation
// busy". The reducer calls it before dispatching an LLM turn
// (dispatchCallLLMOnThread): a failed claim means another turn is already
// running, so the reducer leaves the work for the next reconcile tick.
func (w *ConversationWorker) claimLLM(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var claimed bool
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if existing != nil {
			activity, _ := existing["activity"].(string)
			// Succeed from null or "awaiting_llm"; fail if already "calling_llm".
			if activity != ActivityNone && activity != ActivityAwaitingLLM {
				return // already claimed for an LLM call
			}
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		now := time.Now().UnixMilli()
		updated["activity"] = ActivityCallingLLM
		updated["claimedAt"] = now
		updated["threadItemId"] = threadItemID
		// Keep status/message/startedAt fields as-is so the UI doesn't
		// briefly flicker through an intermediate state; sendStatus will
		// shortly overwrite them with the first loop phase.
		if _, hasStatus := updated["status"]; !hasStatus {
			updated["status"] = "preparing"
		}
		if _, hasStarted := updated["startedAt"]; !hasStarted {
			updated["startedAt"] = now
		}
		w.doc.metadata.Set("processingState", toYcrdt(updated))
		claimed = true
	}, w.doc.authorID)
	return claimed
}

// releaseLLM clears the doc-native claim without touching any other
// processingState field. Symmetric with claimLLM. The normal end-of-loop
// path goes through sendStatus("idle", "") which ALSO clears the claim;
// releaseLLM is used by error paths and the init-time reconciliation.
func (w *ConversationWorker) releaseLLM() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if existing == nil {
			return
		}
		if _, has := existing["activity"]; !has {
			return
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		delete(updated, "activity")
		delete(updated, "claimedAt")
		w.doc.metadata.Set("processingState", toYcrdt(updated))
	}, w.doc.authorID)
}

// patchProcessingState applies mutate to a shallow copy of the doc's
// processingState map inside a single transaction and writes it back. No-op when
// processingState is absent. Shared write preamble (lock + read + clone + set)
// for the small field-level updates below, so the boilerplate lives in one place.
func (w *ConversationWorker) patchProcessingState(mutate func(map[string]any)) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if existing == nil {
			return
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		mutate(updated)
		w.doc.metadata.Set("processingState", toYcrdt(updated))
	}, w.doc.authorID)
}

// hideElapsedAnchor removes startedAt from the doc's processingState. Clients
// render the spinner's elapsed digit only when startedAt is present, so dropping
// it makes the timer disappear — used while a turn is parked on a human approval,
// so the deliberation is never shown as elapsed work. startedAt reappears (with
// the wait excluded) when work resumes, via advanceElapsedAnchor.
func (w *ConversationWorker) hideElapsedAnchor() {
	w.patchProcessingState(func(m map[string]any) {
		delete(m, "startedAt")
	})
}

// advanceElapsedAnchor pushes processingStartedAt forward by waitMs (the just-
// ended approval wait) and writes the new value back into the doc's startedAt, so
// the elapsed digit reappears counting active work with the deliberation excluded
// — never snapping to 0. The deduction is pure in-memory arithmetic; only the one
// derived startedAt field touches the doc, and that single write propagates to
// every connected client at once.
func (w *ConversationWorker) advanceElapsedAnchor(waitMs int64) {
	if waitMs > 0 {
		w.processingStartedAt += waitMs
	}
	anchor := w.processingStartedAt
	w.patchProcessingState(func(m map[string]any) {
		m["startedAt"] = anchor
	})
}

// readProcessingState returns the doc's processingState as a plain map (nil if
// absent), taking ycrdtMu. Shared read preamble for the field accessors below so
// the lock + Get + fromYcrdt + nil-guard lives in one place.
func (w *ConversationWorker) readProcessingState() map[string]any {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	raw := w.doc.metadata.Get("processingState")
	existing, _ := fromYcrdt(raw).(map[string]any)
	return existing
}

// statusHoldsClaim reports whether a processingState.status represents an
// active operation that holds the doc-native LLM claim (activity != none).
// "idle" and the terminal-error statuses ("error", "validation-error") are
// resting states: the operation has ended, so the claim must be released and a
// new send/continue allowed to start. Every other status (preparing, streaming,
// processing_tools, retrying, …) is an in-flight phase that holds the claim.
//
// Treating the terminal-error statuses as resting is essential: a no-model send
// surfaces via sendStatus("validation-error", …) and returns without running a
// turn, so it must release the claim — otherwise activity="calling_llm" wedges
// in the doc, parking every later message in the pending queue and dropping
// Continue.
func statusHoldsClaim(status string) bool {
	switch status {
	case "idle", "error", "validation-error":
		return false
	default:
		return true
	}
}

// getActivity reads the current processingState.activity from the doc.
func (w *ConversationWorker) getActivity() string {
	existing := w.readProcessingState()
	if existing == nil {
		return ActivityNone
	}
	activity, _ := existing["activity"].(string)
	return activity
}

// docTurnCounter reads the completed-turn counter currently stored in the doc's
// dedicated `completedTurns` metadata key (0 if absent). It lives outside the
// ephemeral processingState blob precisely because it is the one value read back
// across a load. Used to keep the in-memory turn counter monotonic across a
// worker restart on a reloaded conversation — a fresh worker's counter starts at
// 0 but the persisted doc may already hold a higher value, and the fence
// observing it must never see the count go backwards.
func (w *ConversationWorker) docTurnCounter() int64 {
	switch v := w.doc.GetMetadata("completedTurns").(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	default:
		return 0
	}
}

// isLLMClaimed reports whether an LLM call is currently in progress
// (activity == "calling_llm"). "awaiting_llm" is NOT claimed — it
// means "dispatch needed" and the reducer should act on it.
func (w *ConversationWorker) isLLMClaimed() bool {
	return w.getActivity() == ActivityCallingLLM
}

// isActivelyRunning reports whether a turn is genuinely doing work on this
// worker: the doc-native LLM claim is held (activity != none) AND the turn is
// not merely parked waiting for the user to approve a tool. A turn blocked
// solely on pending approvals is doing nothing — quitting and restarting leaves
// the approval intact — so it does not count as running. This is the "is it
// safe to quit / rebuild without interrupting work" signal (see AnyActive /
// ActiveConversationIDs); it is deliberately narrower than activity != none,
// which stays true for the whole turn including the approval-parked pause.
func (w *ConversationWorker) isActivelyRunning() bool {
	if w.getActivity() == ActivityNone {
		return false
	}
	return !w.blockedOnlyByApprovals()
}

// markExplicitContinuation records a one-shot continuation intent in
// processingState. The reducer consumes it when dispatching the requested LLM
// turn. This distinguishes a fresh Continue click after an assistant message
// from stale awaiting_llm activity left after deleted tools/threads.
func (w *ConversationWorker) markExplicitContinuation(threadItemID string) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		updated["explicitContinuation"] = true
		updated["threadItemId"] = threadItemID
		w.doc.metadata.Set("processingState", toYcrdt(updated))
	}, w.doc.authorID)
}

// isExplicitContinuation reports whether the one-shot continuation marker
// targets the given thread.
func (w *ConversationWorker) isExplicitContinuation(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	raw := w.doc.metadata.Get("processingState")
	existing, _ := fromYcrdt(raw).(map[string]any)
	if existing == nil {
		return false
	}
	flag, _ := existing["explicitContinuation"].(bool)
	target, _ := existing["threadItemId"].(string)
	return flag && target == threadItemID
}

// consumeExplicitContinuation returns and clears the one-shot continuation
// marker if it targets the thread currently being dispatched.
func (w *ConversationWorker) consumeExplicitContinuation(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var consumed bool
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if existing == nil {
			return
		}
		flag, _ := existing["explicitContinuation"].(bool)
		target, _ := existing["threadItemId"].(string)
		if !flag || target != threadItemID {
			return
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		delete(updated, "explicitContinuation")
		w.doc.metadata.Set("processingState", toYcrdt(updated))
		consumed = true
	}, w.doc.authorID)
	return consumed
}

// requestLLM atomically transitions activity to "awaiting_llm",
// signaling that an LLM call should be dispatched once all tools are
// terminal. The threadItemID identifies which thread needs dispatch
// ("" = root). Accepts transitions from null (new request) and
// calling_llm (child→parent handoff). Returns false if activity is
// already awaiting_llm (another request is pending).
func (w *ConversationWorker) requestLLM(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var requested bool
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		if existing != nil {
			activity, _ := existing["activity"].(string)
			if activity == ActivityAwaitingLLM || activity == ActivityCallingLLM {
				return // another request already pending or LLM already in progress
			}
		}
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		updated["activity"] = ActivityAwaitingLLM
		updated["threadItemId"] = threadItemID
		w.doc.metadata.Set("processingState", toYcrdt(updated))
		requested = true
	}, w.doc.authorID)
	return requested
}

// getProcessingThreadItemID reads the threadItemId from processingState.
// This is the doc-native record of which thread is the target of the
// current operation (written by requestLLM and claimLLM).
func (w *ConversationWorker) getProcessingThreadItemID() string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	raw := w.doc.metadata.Get("processingState")
	existing, _ := fromYcrdt(raw).(map[string]any)
	if existing == nil {
		return ""
	}
	threadItemID, _ := existing["threadItemId"].(string)
	return threadItemID
}

// transitionToAwaitingLLM transitions activity from "calling_llm" to
// "awaiting_llm" and sets the UI status to "processing_tools". Used
// when the strategy loop dispatches async tools and returns without
// blocking — the reducer will re-dispatch when tools complete.
func (w *ConversationWorker) transitionToAwaitingLLM() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := w.doc.metadata.Get("processingState")
		existing, _ := fromYcrdt(raw).(map[string]any)
		updated := map[string]any{}
		for k, v := range existing {
			updated[k] = v
		}
		updated["activity"] = ActivityAwaitingLLM
		updated["status"] = "processing_tools"
		w.doc.metadata.Set("processingState", toYcrdt(updated))
	}, w.doc.authorID)
}
