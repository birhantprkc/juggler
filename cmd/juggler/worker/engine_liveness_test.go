//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
	"time"
)

// Who gets blamed when a tool never advances. The worker cannot see the engine
// directly — it dispatches commands into a mailbox and watches the doc for
// progress — so a command that goes unanswered has two very different causes:
//
//   - the engine received it and DECLINED to act (an unknown tool, a
//     worker-managed manifest, a conversation it can't load). It says so, in an
//     evaluate-noact/execute-noact trace. The tool really is stuck and failing it
//     is the right recovery: the parked turn unblocks and the model sees why.
//   - the engine is GONE — its realm suspended or wedged behind a socket that
//     still looks healthy. Nothing was ever delivered. Failing the tool here
//     blames a tool that was never tried, and does it again for every tool in
//     every conversation until the app is restarted.
//
// lastEngineTraceAt is what separates them: it is stamped whenever the engine
// speaks about this conversation. These tests pin that a mute engine and a
// declining engine are not treated alike.

// driveToEscalation drives the worker enough times to exhaust
// maxToolCommandAttempts, stopping early once the tool has been terminated.
// Staleness is forced through the redriveInterval clock seam — no sleeps.
func driveToEscalation(h *reattachHarness, keepEngineTracing bool) {
	h.w.redriveInterval = 0
	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		if keepEngineTracing {
			// The engine is alive and answering about this conversation: it is
			// declining the command, not missing it. Stamped directly rather than
			// through a dispatched engine-trace message so the test is coupled to
			// the liveness signal, not to the trace payload shape.
			h.w.lastEngineTraceAt = time.Now()
		}
		h.w.driveToolActions()
		if it, ok := findToolItem(h.w.getTargetItems(), "tu-1"); ok && it.State == StateCompleted {
			return
		}
	}
}

// insertApprovedTool puts one approved tool-action in the doc, ready to be
// commanded.
func insertApprovedTool(h *reattachHarness) {
	h.w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})
}

// TestEngineMute_ToolIsNotBlamed is the worker half of the reproduction. With an
// engine registered that has never once spoken about this conversation, the
// commands provably never landed — so the tool must be left alone for the turn's
// own timeout to resolve honestly, not failed with a message that blames the
// engine for "never handling" a command it never received.
func TestEngineMute_ToolIsNotBlamed(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-mute")
	insertApprovedTool(h)

	// The engine registered (SetEngineClientID in the harness) and never traced.
	if !h.w.lastEngineTraceAt.IsZero() {
		t.Fatal("harness precondition: engine must not have traced")
	}

	driveToEscalation(h, false)
	h.flush(t)

	it, ok := findToolItem(h.w.getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State == StateCompleted {
		t.Fatalf("a tool was failed on behalf of an engine that has never spoken: "+
			"state=%q. Nothing was delivered, so the tool is not what is broken — "+
			"the engine link is, and every later tool will be failed the same way "+
			"until the app restarts", it.State)
	}
}

// TestEngineDeclining_ToolStillEscalates is the other half, and the guard
// against over-fixing. An engine that IS reaching its handlers and declining the
// command must still have the tool failed past maxToolCommandAttempts: the tool
// genuinely is stuck, and doc.go's rule stands — degrade to a recoverable error,
// never an infinite wait.
func TestEngineDeclining_ToolStillEscalates(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-declining")
	insertApprovedTool(h)

	driveToEscalation(h, true)
	h.flush(t)

	it, ok := findToolItem(h.w.getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State != StateCompleted {
		t.Fatalf("a live engine declining the command must still terminate the tool "+
			"so the parked turn unblocks: got state=%q", it.State)
	}

	// The provider must see an isError tool-result, or a parked CLI hangs.
	found, isErr := toolResultIsError(h.w.buildMessages(nil), "tu-1")
	if !found || !isErr {
		t.Fatalf("escalated tool must feed an isError tool-result (found=%v isError=%v)", found, isErr)
	}
}

// TestEngineMute_FailureNamesTheEngine: whatever eventually fails a tool held
// behind a mute engine must say the engine is unavailable. The current wording
// reads as a tool-level fault and sends every report chasing the tool.
func TestEngineMute_FailureNamesTheEngine(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-mute-wording")
	insertApprovedTool(h)

	driveToEscalation(h, false)
	h.flush(t)

	it, ok := findToolItem(h.w.getTargetItems(), "tu-1")
	if !ok || it.State != StateCompleted {
		return // not failed at all — TestEngineMute_ToolIsNotBlamed covers that
	}
	text := toolResultText(h.w.buildMessages(nil), "tu-1")
	if !strings.Contains(strings.ToLower(text), "engine") ||
		strings.Contains(text, "never handled this command") {
		t.Fatalf("a mute-engine failure must name the engine as unavailable, not "+
			"read as the tool's own fault: %q", text)
	}
}

// toolResultText returns the text content of a tool-result the worker built for
// the provider.
func toolResultText(messages []map[string]any, toolUseID string) string {
	for _, m := range messages {
		if m["type"] != "tool-result" {
			continue
		}
		if id, _ := m["toolUseId"].(string); id == toolUseID {
			s, _ := m["content"].(string)
			return s
		}
	}
	return ""
}
