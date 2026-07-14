//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// These tests guard the silent-ack watchdog: the recovery path for a
// tool-command the engine acknowledges NEITHER with execution NOR with a
// negative ack. handleToolCommandAck only fires when an ack arrives, so a
// dropped command (engine wasn't a loaded peer of the conversation, pre-claim
// drop, etc.) left inFlightToolCommands latched forever with nothing re-driving
// it — the ~31-minute "popup fail" wedge. driveToolActions now stamps a dispatch
// time and arms a watchdog; sweepStaleToolCommands re-drives genuinely-unstarted
// commands and, past a cap, escalates to a terminal tool error so the turn
// unblocks.
//
// ackTimeout is set to a large value so the real timer never fires mid-test;
// staleness is forced deterministically by backdating inFlightDispatchedAt and
// calling sweepStaleToolCommands directly (no sleeps).

// TestToolCommandAckTimeout_SilentDropRedrives: a dispatched execute-tool the
// engine never acks must be re-dispatched once the watchdog trips, and once the
// engine finally acks, the command must NOT be re-dispatched again (no double
// side effect).
func TestToolCommandAckTimeout_SilentDropRedrives(t *testing.T) {
	h := newReattachHarness(t, "conv-ack-timeout-silent")
	w := h.w
	w.ackTimeout = time.Hour

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Engine stays silent (no ack). The command goes stale.
	if _, ok := w.tools.dispatchedAt("tu-1"); !ok {
		t.Fatal("expected an in-flight dispatch timestamp after driveToolActions")
	}
	w.tools.restamp("tu-1", time.Now().Add(-2*w.ackTimeout))
	w.sweepStaleToolCommands()

	// The sweep cleared the in-flight latch and flagged a reconcile; the run loop
	// drains that into driveToolActions. Emulate the drain.
	if !w.needsReconcile {
		t.Fatal("sweep of a silently-dropped command should request a reconcile")
	}
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("after silent-timeout sweep: want 2 (re-driven), got %d", got)
	}

	// The engine now acks the re-driven command. Steady-state re-drives must not
	// re-command it.
	ackOK, _ := json.Marshal(map[string]any{"action": "execute-tool", "toolUseId": "tu-1", "ok": true})
	w.dispatchMessage(workerMessage{Type: "tool-command-ack", Payload: ackOK, OriginClient: "engine"})
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("after positive ack: want 2 (latched, no double side effect), got %d", got)
	}
}

// TestToolCommandAckTimeout_RunningToolNotRedriven: a tool the engine has
// CLAIMED (state→running) but not yet completed must NOT be re-driven by the
// watchdog even though no ack has arrived — the engine acks execute-tool only
// after the side effect runs to a terminal result, so a long-running tool
// legitimately has no ack for a while. Re-driving it would double-fire.
func TestToolCommandAckTimeout_RunningToolNotRedriven(t *testing.T) {
	h := newReattachHarness(t, "conv-ack-timeout-running")
	w := h.w
	w.ackTimeout = time.Hour

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Engine claims the tool (CAS approved→running, stamps runningStartedAt) but
	// withholds the completion ack past the timeout.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":            StateRunning,
		"runningStartedAt": time.Now().Format(time.RFC3339),
	})
	w.tools.restamp("tu-1", time.Now().Add(-2*w.ackTimeout))
	w.sweepStaleToolCommands()

	// Branch 2: the doc state advanced past the dispatched state, so the sweep
	// just drops stale bookkeeping — no re-drive, no escalation.
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("running tool was re-driven by the watchdog: want 1 execute-tool, got %d (double exec)", got)
	}
	if n := w.tools.timeoutCount("tu-1"); n != 0 {
		t.Fatalf("running tool wrongly counted as a silent timeout: want 0, got %d", n)
	}
	if it, ok := findToolItem(w.getTargetItems(), "tu-1"); !ok || it.State != StateRunning {
		t.Fatalf("running tool must be left running, not escalated: %+v (ok=%v)", it, ok)
	}
}

// TestToolCommandAckTimeout_PersistentSilenceEscalatesToError: an engine that
// never acks at all must, past maxToolCommandTimeouts, have the tool failed with
// a terminal error result so the parked turn unblocks (degrade to a recoverable
// error, never an infinite wait).
func TestToolCommandAckTimeout_PersistentSilenceEscalatesToError(t *testing.T) {
	h := newReattachHarness(t, "conv-ack-timeout-escalate")
	w := h.w
	w.ackTimeout = time.Hour

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	// Engine perpetually silent: drive + stale-sweep until the tool either stops
	// being in-flight (escalated) or we exceed the cap's worth of iterations.
	for i := 0; i <= maxToolCommandTimeouts+1; i++ {
		w.driveToolActions()
		if _, ok := w.tools.inFlightAt("tu-1"); !ok {
			break // escalated — no longer in-flight
		}
		w.tools.restamp("tu-1", time.Now().Add(-2*w.ackTimeout))
		w.sweepStaleToolCommands()
	}
	h.flush(t)

	it, ok := findToolItem(w.getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State != StateCompleted {
		t.Fatalf("persistent silence should terminate the tool: want state=completed, got %q", it.State)
	}
	if _, stillInFlight := w.tools.inFlightAt("tu-1"); stillInFlight {
		t.Fatal("escalated tool must not remain in-flight")
	}

	// The terminal result must reach the provider as an isError tool-result so a
	// parked CLI unblocks.
	found, isErr := toolResultIsError(w.buildMessages(nil), "tu-1")
	if !found {
		t.Fatal("escalated tool produced no tool-result for the provider — turn would still hang")
	}
	if !isErr {
		t.Fatal("escalated tool-result must be flagged isError")
	}
}

// TestToolCommandAckTimeout_WatchdogDisarmsWhenDrained: the watchdog must be
// armed while a command is in flight and disarm once in-flight drains, and a
// sweep with nothing in flight must not re-arm — no idle wakeups.
func TestToolCommandAckTimeout_WatchdogDisarmsWhenDrained(t *testing.T) {
	h := newReattachHarness(t, "conv-ack-timeout-disarm")
	w := h.w
	w.ackTimeout = time.Hour

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActions()
	h.flush(t)
	if w.ackWatchdog == nil {
		t.Fatal("watchdog should be armed while a tool-command is in flight")
	}

	ackOK, _ := json.Marshal(map[string]any{"action": "execute-tool", "toolUseId": "tu-1", "ok": true})
	w.dispatchMessage(workerMessage{Type: "tool-command-ack", Payload: ackOK, OriginClient: "engine"})
	if n := w.tools.inFlightCount(); n != 0 {
		t.Fatalf("positive ack should drain in-flight, got %d", n)
	}
	if w.ackWatchdog != nil {
		t.Fatal("watchdog should disarm once in-flight drains")
	}

	// A sweep with nothing in flight must not re-arm.
	w.sweepStaleToolCommands()
	if w.ackWatchdog != nil {
		t.Fatal("sweep re-armed the watchdog with no in-flight commands")
	}
}

func findToolItem(items []ConversationItem, toolUseID string) (ConversationItem, bool) {
	for _, it := range items {
		if it.Type == ItemTypeToolAction && it.ToolUseID == toolUseID {
			return it, true
		}
	}
	return ConversationItem{}, false
}

func toolResultIsError(messages []map[string]any, toolUseID string) (found, isError bool) {
	for _, m := range messages {
		if m["type"] != "tool-result" {
			continue
		}
		if id, _ := m["toolUseId"].(string); id == toolUseID {
			e, _ := m["isError"].(bool)
			return true, e
		}
	}
	return false, false
}
