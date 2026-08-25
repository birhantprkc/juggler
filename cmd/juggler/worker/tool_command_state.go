//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// toolCommandState is the per-toolUseId bookkeeping for the level-based
// command-driven tool lifecycle. driveToolActions re-dispatches a tool's command
// (evaluate-tool for "", execute-tool for approved) whenever the doc state still
// demands one and it has not been dispatched at that state within redriveInterval.
//
// Doc-state progression is the "engine acted" signal — the idempotent engine
// handlers (handleNewToolAction's ifState CAS, claimRunning's compare-and-set)
// make a redundant command a harmless no-op — so there is no ack, in-flight latch,
// or watchdog timer. The age test is BOTH the per-tick anti-spam dedup and the
// recovery for a silently-dropped command, and one attempts cap escalates a
// permanently-unhandled command to a terminal error instead of waiting forever.
type toolCommandState struct {
	// dispatchedState is the state the last command for this id was sent at.
	// dispatchedStateSet distinguishes a real "" (StateUnevaluated) dispatch from
	// "never dispatched", so a never-dispatched tool still gets its first command.
	dispatchedState    string
	dispatchedStateSet bool

	// lastDispatchedAt stamps the last dispatch so shouldRedrive can suppress a
	// re-dispatch at the same state until redriveInterval has elapsed. Tests force
	// staleness by shrinking the worker's redriveInterval, not by poking this.
	lastDispatchedAt time.Time

	// prevDispatchedAt stamps the dispatch BEFORE lastDispatchedAt, and is the
	// reference point for "did the engine answer for this tool". It has to be the
	// previous one: driveToolActions calls recordDispatch before deciding whether
	// to escalate, so at the decision point lastDispatchedAt is the dispatch just
	// sent, which nothing could have answered yet. The previous dispatch is the
	// most recent one the engine has had a full redriveInterval to answer.
	prevDispatchedAt time.Time

	// lastTracedAt stamps when an engine-trace naming THIS toolUseId last arrived
	// (recordTrace, from handleEngineTrace). Every engine-side handler traces with
	// the toolUseId it acted on — the acting paths (execute-claim/start/done) and
	// the declining ones (evaluate-noact/execute-noact) alike — so a trace here is
	// the only evidence that a command for this tool reached a handler at all.
	// Zero until the first trace for the id.
	lastTracedAt time.Time

	// firstDispatchedAt stamps when the CURRENT delivery phase began — the first
	// dispatch at this state. It bounds how long an unproven engine is waited out
	// (engineUnprovenHold), so a tool is never held indefinitely no matter how
	// long the engine stays unreachable.
	firstDispatchedAt time.Time

	// attempts counts consecutive dispatches at the current dispatchedState; past
	// maxToolCommandAttempts the tool is escalated to a terminal error. Reset to 1
	// whenever the demanded state changes (a fresh delivery phase).
	attempts int
}

// toolCommandTracker owns the tool-command bookkeeping. Every access happens on
// the worker's run goroutine (driveToolActions and the reattach/reset paths all
// run there), so it carries no lock of its own.
type toolCommandTracker struct {
	byID map[string]*toolCommandState
}

func newToolCommandTracker() *toolCommandTracker {
	return &toolCommandTracker{byID: map[string]*toolCommandState{}}
}

// entry returns the mutable state for id, creating a zero entry if absent.
func (t *toolCommandTracker) entry(id string) *toolCommandState {
	s := t.byID[id]
	if s == nil {
		s = &toolCommandState{}
		t.byID[id] = s
	}
	return s
}

// resetAll drops bookkeeping for every tool. Used on engine reattach: the new
// engine has observed none of this conversation's commands, so every non-terminal
// tool-action must be dispatched afresh against it.
func (t *toolCommandTracker) resetAll() {
	t.byID = map[string]*toolCommandState{}
}

// clear drops all bookkeeping for id (the full-reset sites: escalation-to-failed,
// user-triggered retry, per-tool reattach reset). The next drive treats the id as
// never-dispatched.
func (t *toolCommandTracker) clear(id string) { delete(t.byID, id) }

// shouldRedrive reports whether id needs a command dispatched for state now. A
// never-dispatched id — or one whose demanded state changed since its last
// dispatch — is dispatched immediately; a re-dispatch at the SAME state is
// suppressed until interval has elapsed since the last dispatch (the anti-spam
// dedup that also recovers a silently-dropped command once it goes stale).
func (t *toolCommandTracker) shouldRedrive(id, state string, now time.Time, interval time.Duration) bool {
	s := t.byID[id]
	if s == nil || !s.dispatchedStateSet || s.dispatchedState != state {
		return true
	}
	return now.Sub(s.lastDispatchedAt) >= interval
}

// recordDispatch records a just-sent command for id at state, stamped now, and
// returns the resulting attempt count at that state. Attempts reset to 1 when the
// state differs from the last dispatch (a new delivery phase), else increment.
func (t *toolCommandTracker) recordDispatch(id, state string, now time.Time) int {
	s := t.entry(id)
	if !s.dispatchedStateSet || s.dispatchedState != state {
		s.dispatchedState, s.dispatchedStateSet, s.attempts = state, true, 1
		s.firstDispatchedAt = now
	} else {
		s.attempts++
	}
	s.prevDispatchedAt, s.lastDispatchedAt = s.lastDispatchedAt, now
	return s.attempts
}

// recordTrace stamps the arrival of an engine-trace naming id. Only ids already
// under command are stamped: a trace for anything else is diagnostic-only, and
// creating an entry for it would leak one map entry per tool ever traced.
func (t *toolCommandTracker) recordTrace(id string, now time.Time) {
	if s := t.byID[id]; s != nil {
		s.lastTracedAt = now
	}
}

// answeredSincePrevDispatch reports whether the engine traced about THIS tool
// since the dispatch before the most recent one — i.e. whether the engine is
// still answering for this tool right now, rather than having answered once
// early in the phase and gone silent since.
//
// This is the whole difference between the two escalation verdicts, so it is
// deliberately per-tool and deliberately recent. A conversation-wide "has the
// engine said anything" test is satisfied by a sibling tool in the same parallel
// batch, and by this tool's own declining trace; an "anything since the phase
// began" test is satisfied by one trace in the first millisecond of a 30-second
// phase, which is exactly what a suspended engine leaves behind.
func (t *toolCommandTracker) answeredSincePrevDispatch(id string) bool {
	s := t.byID[id]
	if s == nil || s.lastTracedAt.IsZero() {
		return false
	}
	return s.lastTracedAt.After(s.prevDispatchedAt)
}

// lastTracedAt returns when an engine-trace naming id last arrived, or the zero
// time if none ever has. Diagnostic only — the escalation verdict uses
// answeredSincePrevDispatch, which also weighs recency.
func (t *toolCommandTracker) lastTracedAt(id string) time.Time {
	if s := t.byID[id]; s != nil {
		return s.lastTracedAt
	}
	return time.Time{}
}

// phaseStartedAt returns when the current delivery phase for id began, or the
// zero time if id has never been dispatched.
func (t *toolCommandTracker) phaseStartedAt(id string) time.Time {
	if s := t.byID[id]; s != nil {
		return s.firstDispatchedAt
	}
	return time.Time{}
}
