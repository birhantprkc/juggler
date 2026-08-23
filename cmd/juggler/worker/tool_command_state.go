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

	// firstDispatchedAt stamps when the CURRENT delivery phase began — the first
	// dispatch at this state. It is the reference point for "has the engine said
	// anything since we started asking", which is what separates an engine that
	// received the command and declined from one that was never there to receive
	// it (see engineSpokeSince).
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
	s.lastDispatchedAt = now
	return s.attempts
}

// phaseStartedAt returns when the current delivery phase for id began, or the
// zero time if id has never been dispatched.
func (t *toolCommandTracker) phaseStartedAt(id string) time.Time {
	if s := t.byID[id]; s != nil {
		return s.firstDispatchedAt
	}
	return time.Time{}
}
