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
// Per-tool trace receipt is what separates them: an engine-trace names the
// toolUseId it acted on, and answeredSincePrevDispatch asks whether one arrived
// for THIS tool since the dispatch before last. Both halves matter. A
// conversation-wide test is satisfied by a sibling tool in the same parallel
// batch, and an "ever, during this phase" test is satisfied by a single trace in
// the first millisecond of a 30-second phase — which is precisely the residue a
// laptop that slept leaves behind. These tests pin that a mute engine and a
// declining engine are not treated alike, and that neither of those two weaker
// signals can pass for a live one.

// driveToEscalation drives the worker enough times to exhaust
// maxToolCommandAttempts, stopping early once the tool has been terminated.
// Staleness is forced through the redriveInterval clock seam — no sleeps.
func driveToEscalation(h *reattachHarness, keepEngineTracing bool) {
	h.w.redriveInterval = 0
	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		if keepEngineTracing {
			// The engine is alive and answering FOR THIS TOOL: it is declining the
			// command, not missing it. Stamped through the tracker rather than by
			// dispatching an engine-trace message, so the test is coupled to the
			// liveness signal rather than to the trace payload shape —
			// TestEngineTrace_StampsThePerToolReceipt covers the payload.
			h.w.tools.recordTrace("tu-1", time.Now())
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

// TestEngineWentSilentMidPhase_ToolIsNotBlamed is the sleep/wake reproduction.
// The engine answers the first command and then stops — its realm suspended with
// the laptop, while the WebSocket stays open in the network process below it, so
// the engine remains registered and the worker keeps dispatching into something
// that cannot run a handler.
//
// A single early trace must not license failing the tool for the whole rest of
// the phase. If it does, escalation (~30s) beats the server's own recovery
// (engineLivenessWindow + engineReconnectGrace, ~50s) every time, and the user
// sees a tool blamed for an engine that was about to be fetched back.
func TestEngineWentSilentMidPhase_ToolIsNotBlamed(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-silent-mid-phase")
	insertApprovedTool(h)
	h.w.redriveInterval = 0

	// One trace, answering the first command, then silence for good. A sibling
	// tool still executing would keep the conversation-wide signal just as warm.
	h.w.driveToolActions()
	h.w.tools.recordTrace("tu-1", time.Now())
	h.w.lastEngineTraceAt = time.Now()

	for i := 0; i <= maxToolCommandAttempts+1; i++ {
		h.w.driveToolActions()
	}
	h.flush(t)

	it, ok := findToolItem(h.w.getTargetItems(), "tu-1")
	if !ok {
		t.Fatal("tu-1 disappeared")
	}
	if it.State == StateCompleted {
		t.Fatalf("a tool was failed on the strength of one trace at the head of the "+
			"phase: state=%q. The engine has answered nothing since, so the commands "+
			"are landing nowhere — holding is what gives eviction, reconnect and "+
			"engine reload time to put an engine back", it.State)
	}
}

// TestEngineTrace_StampsThePerToolReceipt pins the wire contract the verdict now
// rests on: an engine-trace carries the toolUseId it acted on, and the worker
// records it against that tool. Nothing else in the worker decodes the payload,
// so a rename on the engine side would otherwise silently downgrade every
// escalation to "the engine never answered".
func TestEngineTrace_StampsThePerToolReceipt(t *testing.T) {
	h := newReattachHarness(t, "conv-engine-trace-receipt")
	insertApprovedTool(h)
	h.w.redriveInterval = 0
	h.w.driveToolActions() // create the bookkeeping entry the trace stamps

	h.w.handleEngineTrace([]byte(`{"event":"execute-noact","toolUseId":"tu-1","reason":"no-thread"}`))

	if h.w.tools.lastTracedAt("tu-1").IsZero() {
		t.Fatal("an engine-trace naming tu-1 did not stamp tu-1's receipt — check " +
			"the toolUseId field name against sendEngineTrace in the engine")
	}
	if h.w.lastEngineTraceAt.IsZero() {
		t.Fatal("engine-trace must still stamp the conversation-wide receipt")
	}
	if !h.w.tools.lastTracedAt("tu-other").IsZero() {
		t.Fatal("a trace for tu-1 stamped an unrelated tool's receipt")
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
