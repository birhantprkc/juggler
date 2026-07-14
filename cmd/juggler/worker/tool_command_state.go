//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "time"

// toolCommandState is the per-toolUseId bookkeeping for the command-driven tool
// lifecycle. It consolidates what used to be five parallel map[string]... fields
// (commandedToolActions / inFlightToolCommands / inFlightDispatchedAt /
// toolCommandRetries / toolCommandTimeouts) that had to be kept in lockstep by
// hand — a partial update at any full-reset site (silent-timeout escalation,
// user-triggered retry, per-tool reattach reset) wedged the re-drive: a stale
// in-flight latch made the staleness sweep think a command was still outstanding,
// and a stale retry/timeout count prematurely tripped the escalation caps. Holding
// every field in one struct makes those inconsistencies impossible — clear(id)
// drops them all at once.
type toolCommandState struct {
	// commanded is the last state the engine positively acked (handleToolCommandAck
	// with ok=true). hasCommanded distinguishes an acked "" (StateUnevaluated) from
	// "never commanded" — the drive-side dedup depends on that distinction, so a
	// never-commanded tool still gets its first evaluate-tool.
	commanded    string
	hasCommanded bool

	// inFlight is the state a dispatched-but-unacked command was sent at; isInFlight
	// gates it ("" is a valid state). dispatchedAt stamps the dispatch so the ack
	// watchdog can test staleness. An in-flight entry is NOT "done": only a positive
	// ack promotes it into commanded.
	inFlight     string
	isInFlight   bool
	dispatchedAt time.Time

	// retries bounds the negative-ack re-drive loop; timeouts bounds the silent-ack
	// (watchdog) re-drive loop. Both are per-id escalation caps.
	retries  int
	timeouts int
}

// toolCommandTracker owns the tool-command bookkeeping. Every access happens on the
// worker's run goroutine (driveToolActions, the ack handler, and sweepStaleTool-
// Commands all run there), so it carries no lock of its own — exactly like the raw
// maps it replaced.
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

// pruneIfEmpty drops an entry that carries no bookkeeping at all, so a cleared id
// leaves no residue — matching the absence semantics of the old separate maps.
func (t *toolCommandTracker) pruneIfEmpty(id string, s *toolCommandState) {
	if !s.hasCommanded && !s.isInFlight && s.retries == 0 && s.timeouts == 0 {
		delete(t.byID, id)
	}
}

// resetAll drops bookkeeping for every tool. Used on engine reattach: a command
// awaiting an ack from the previous engine will never be answered, so it must not
// block re-driving against the new one.
func (t *toolCommandTracker) resetAll() {
	t.byID = map[string]*toolCommandState{}
}

// clear drops every field for id at once (the full-reset sites: silent-timeout
// escalation, user-triggered retry, per-tool reattach reset). Leaving any field
// populated would wedge the subsequent re-drive.
func (t *toolCommandTracker) clear(id string) { delete(t.byID, id) }

// commandedAt reports the state the engine last acked for id, and whether it acked
// at all (comma-ok, because "" is a real state).
func (t *toolCommandTracker) commandedAt(id string) (string, bool) {
	if s := t.byID[id]; s != nil && s.hasCommanded {
		return s.commanded, true
	}
	return "", false
}

// markCommanded latches a positive ack for id at state.
func (t *toolCommandTracker) markCommanded(id, state string) {
	s := t.entry(id)
	s.commanded, s.hasCommanded = state, true
}

// clearCommanded drops only the dedup latch (a strategy-switch re-evaluate resets a
// pending tool to "" and re-commands it), leaving any in-flight/retry/timeout state.
func (t *toolCommandTracker) clearCommanded(id string) {
	if s := t.byID[id]; s != nil {
		s.commanded, s.hasCommanded = "", false
		t.pruneIfEmpty(id, s)
	}
}

// inFlightAt reports the state a command for id is awaiting an ack at, and whether
// one is in flight.
func (t *toolCommandTracker) inFlightAt(id string) (string, bool) {
	if s := t.byID[id]; s != nil && s.isInFlight {
		return s.inFlight, true
	}
	return "", false
}

// dispatchedAt reports when the in-flight command for id was sent, and whether one
// is in flight.
func (t *toolCommandTracker) dispatchedAt(id string) (time.Time, bool) {
	if s := t.byID[id]; s != nil && s.isInFlight {
		return s.dispatchedAt, true
	}
	return time.Time{}, false
}

// markInFlight records a just-dispatched command for id at state, stamped now.
func (t *toolCommandTracker) markInFlight(id, state string, now time.Time) {
	s := t.entry(id)
	s.inFlight, s.isInFlight, s.dispatchedAt = state, true, now
}

// restamp updates the dispatch time of an existing entry without changing its
// in-flight state (the sweep's defensive re-stamp of a missing timestamp; tests
// backdate through it to force staleness deterministically).
func (t *toolCommandTracker) restamp(id string, at time.Time) {
	if s := t.byID[id]; s != nil {
		s.dispatchedAt = at
	}
}

// clearInFlight drops only the in-flight latch and its dispatch stamp, leaving
// commanded/retry/timeout state intact. Used when an ack arrives, or when the sweep
// re-drives or observes the engine already acted.
func (t *toolCommandTracker) clearInFlight(id string) {
	s := t.byID[id]
	if s == nil {
		return
	}
	s.inFlight, s.isInFlight, s.dispatchedAt = "", false, time.Time{}
	t.pruneIfEmpty(id, s)
}

// bumpRetries increments and returns the negative-ack re-drive count for id.
func (t *toolCommandTracker) bumpRetries(id string) int {
	s := t.entry(id)
	s.retries++
	return s.retries
}

// bumpTimeouts increments and returns the silent-ack re-drive count for id.
func (t *toolCommandTracker) bumpTimeouts(id string) int {
	s := t.entry(id)
	s.timeouts++
	return s.timeouts
}

// timeoutCount reports the silent-ack re-drive count for id (0 if untracked).
func (t *toolCommandTracker) timeoutCount(id string) int {
	if s := t.byID[id]; s != nil {
		return s.timeouts
	}
	return 0
}

// clearCounts zeroes both escalation counts for id (a positive ack cancels both the
// negative-ack and silent-ack recovery loops), leaving commanded/in-flight state.
func (t *toolCommandTracker) clearCounts(id string) {
	if s := t.byID[id]; s != nil {
		s.retries, s.timeouts = 0, 0
	}
}

// inFlightCount reports how many commands are awaiting an ack — the drain check the
// watchdog arms/disarms on.
func (t *toolCommandTracker) inFlightCount() int {
	n := 0
	for _, s := range t.byID {
		if s.isInFlight {
			n++
		}
	}
	return n
}

// inFlightCmd is one in-flight command, snapshotted for the staleness sweep so it
// can classify and mutate entries without ranging the live map.
type inFlightCmd struct {
	id           string
	state        string
	dispatchedAt time.Time
}

// inFlightSnapshot returns every currently in-flight command.
func (t *toolCommandTracker) inFlightSnapshot() []inFlightCmd {
	out := make([]inFlightCmd, 0, len(t.byID))
	for id, s := range t.byID {
		if s.isInFlight {
			out = append(out, inFlightCmd{id: id, state: s.inFlight, dispatchedAt: s.dispatchedAt})
		}
	}
	return out
}
