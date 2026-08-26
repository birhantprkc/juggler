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
// parked turn unblocks — provided the engine is answering at all
// (engine_liveness_test.go). Staleness is forced deterministically by shrinking
// the worker's redriveInterval (the clock seam) — no sleeps.

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
	if it, ok := findToolItem(w.currentRun().getTargetItems(), "tu-1"); !ok || it.State != StateRunning {
		t.Fatalf("running tool must be left running, not escalated: %+v (ok=%v)", it, ok)
	}
}

// Escalation past maxToolCommandAttempts is covered by
// TestEngineDeclining_ToolStillEscalates (engine_liveness_test.go), which pins
// the same contract plus the distinction the attempts cap alone cannot make:
// only an engine that is ANSWERING may have its tool failed. Silence with no
// engine activity at all is a broken link, not a broken tool.

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
