//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// These tests guard the level-based tool-command delivery model (no ack, no
// in-flight latch, no watchdog timer). driveToolActions re-dispatches a tool's
// command only when the doc state still demands one AND the last dispatch at that
// state has aged past redriveInterval; doc-state progression (the engine claimed
// or evaluated the tool) suppresses re-drive immediately, and a command stuck at
// the same state past maxToolCommandAttempts escalates to a terminal error so the
// parked turn unblocks. Staleness is forced deterministically by shrinking the
// worker's redriveInterval (the clock seam) — no sleeps.

// TestToolCommandRedrive_AgeSuppressesThenRedrives exercises the three legs of the
// one rule on an approved tool: a re-drive WITHIN redriveInterval is deduped (no
// per-tick spam), a re-drive PAST it re-dispatches (recovers a silently-dropped
// command), and once the engine claims the tool (state→running) the doc-state
// guard stops all further commands (no double side effect).
func TestToolCommandRedrive_AgeSuppressesThenRedrives(t *testing.T) {
	h := newReattachHarness(t, "conv-redrive-age")
	w := h.w
	w.redriveInterval = time.Hour // suppress the age-based re-drive for the dedup leg

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	// First drive: the worker commands execute-tool exactly once.
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Re-drive within redriveInterval, same state: the age test dedups it.
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("re-drive within interval: want 1 (deduped), got %d", got)
	}

	// Shrink the interval so the dispatch is now stale: the re-drive re-dispatches.
	w.redriveInterval = 0
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("re-drive past interval: want 2 (re-driven), got %d", got)
	}

	// The engine claims the tool (CAS approved→running). driveToolActions no longer
	// selects a running tool, so even with a zero interval it is never re-commanded.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":            StateRunning,
		"runningStartedAt": time.Now().Format(time.RFC3339),
	})
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("after claim (state→running): want 2 (doc-state guard), got %d", got)
	}
}

// TestToolCommandRedrive_SilentDropRedrives: a dispatched execute-tool the engine
// silently drops (no claim, no result) must be re-dispatched once the dispatch
// goes stale, and once the engine finally claims it, the command must NOT fire
// again (no double side effect). This is the primary age-based recovery test.
func TestToolCommandRedrive_SilentDropRedrives(t *testing.T) {
	h := newReattachHarness(t, "conv-redrive-silent")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Engine stays silent (the command was dropped). Once the dispatch is stale the
	// next drive re-dispatches it — this is the ~31-min "popup fail" wedge fix.
	w.redriveInterval = 0
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("after staleness: want 2 (re-driven), got %d", got)
	}

	// The engine now claims the re-driven command (state→running). Steady-state
	// drives must not re-command it even with a zero interval.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":            StateRunning,
		"runningStartedAt": time.Now().Format(time.RFC3339),
	})
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 2 {
		t.Fatalf("after claim: want 2 (no double side effect), got %d", got)
	}
}

// TestToolCommandRedrive_RunningToolNotRedriven: a tool the engine has CLAIMED
// (state→running) but not yet completed must NOT be re-driven — the engine
// completes it in its own time and re-driving would double-fire the side effect.
// The doc-state guard (running is not a delivery state driveToolActions selects)
// enforces this even with a zero redriveInterval.
func TestToolCommandRedrive_RunningToolNotRedriven(t *testing.T) {
	h := newReattachHarness(t, "conv-redrive-running")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Engine claims the tool (CAS approved→running) but withholds completion.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"state":            StateRunning,
		"runningStartedAt": time.Now().Format(time.RFC3339),
	})

	// Even with staleness forced, a running tool is never re-driven or escalated.
	w.redriveInterval = 0
	w.driveToolActions()
	h.flush(t)
	if got := h.executeCount("tu-1"); got != 1 {
		t.Fatalf("running tool was re-driven: want 1 execute-tool, got %d (double exec)", got)
	}
	if it, ok := findToolItem(w.getTargetItems(), "tu-1"); !ok || it.State != StateRunning {
		t.Fatalf("running tool must be left running, not escalated: %+v (ok=%v)", it, ok)
	}
}

// TestToolCommandRedrive_PersistentSilenceEscalatesToError: an engine that never
// claims the tool at all must, past maxToolCommandAttempts dispatches at the same
// state, have the tool failed with a terminal error result so the parked turn
// unblocks (degrade to a recoverable error, never an infinite wait), leaving no
// residual command bookkeeping.
func TestToolCommandRedrive_PersistentSilenceEscalatesToError(t *testing.T) {
	h := newReattachHarness(t, "conv-redrive-escalate")
	w := h.w
	w.redriveInterval = 0 // every drive re-dispatches (and bumps the attempt count)

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	// Drive repeatedly with the engine perpetually silent: attempts 1..N dispatch,
	// the (N+1)th escalates the tool to a terminal error.
	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		w.driveToolActions()
		if it, ok := findToolItem(w.getTargetItems(), "tu-1"); ok && it.State == StateCompleted {
			break // escalated
		}
	}
	h.flush(t)

	it, ok := findToolItem(w.getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State != StateCompleted {
		t.Fatalf("persistent silence should terminate the tool: want state=completed, got %q", it.State)
	}
	if _, tracked := w.tools.byID["tu-1"]; tracked {
		t.Fatal("escalated tool must leave no residual command bookkeeping")
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
