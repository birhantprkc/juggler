//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// TestToolCommandAck_NoAckLatchAndRetry is the behavioural guard for the
// fire-and-forget tool-command wedge: the worker must not treat "I dispatched a
// command" as "the engine executed it". Before the ack handshake, driveToolActions
// recorded commandedToolActions[id] the instant it sent execute-tool. If that one
// command was dropped or no-op'd by the engine (conversation not yet loaded, a
// lost claim, a throttled engine), the optimistic latch suppressed every retry —
// the tool sat non-terminal forever with nothing re-driving it ("approved a tool,
// it never executed, the item pulses but the tab isn't busy").
//
// The fix gates the dedup on a confirmed ack:
//   - dispatched-but-unacked commands dedup (no per-tick spam) but do NOT latch;
//   - a negative ack (engine could not act) un-latches and re-drives;
//   - a positive ack (engine handled it) latches so a running/terminal tool
//     isn't re-commanded.
func TestToolCommandAck_NoAckLatchAndRetry(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv", CurrentStrategyID: "default"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.handleInit(initPayload)

	var executeCmds atomic.Int64
	flushCh := make(chan struct{}, 1)
	w.SetCallback("engine", func(b []byte) {
		var m ToolCommand
		_ = json.Unmarshal(b, &m)
		switch {
		case m.Type == "flush-sentinel":
			select {
			case flushCh <- struct{}{}:
			default:
			}
		case m.Type == "execute-tool" && m.ToolUseID == "tu-1":
			executeCmds.Add(1)
		}
	})
	w.SetEngineClientID("engine")
	count := func() int { return int(executeCmds.Load()) }

	// The engine callback runs on its own per-client mailbox goroutine, so a
	// dispatch is async. flush() rides a sentinel through the SAME FIFO mailbox and
	// waits for the callback to observe it — once it does, every command enqueued
	// before it has already been delivered. Deterministic, no arbitrary sleeps.
	flush := func() {
		b, _ := json.Marshal(ToolCommand{Type: "flush-sentinel"})
		w.callbacks.sendToEngine(b)
		select {
		case <-flushCh:
		case <-time.After(2 * time.Second):
			t.Fatal("flush barrier timed out")
		}
	}

	// An approved tool-action the worker must drive the engine to execute.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	// First drive: the worker commands execute-tool exactly once.
	w.driveToolActions()
	flush()
	if got := count(); got != 1 {
		t.Fatalf("first drive: want 1 execute-tool, got %d", got)
	}

	// Re-drive while the command is still in flight (no ack yet): the in-flight
	// command must dedup the re-dispatch so the worker doesn't spam every tick.
	w.driveToolActions()
	flush()
	if got := count(); got != 1 {
		t.Fatalf("re-drive while in-flight: want 1 (deduped), got %d", got)
	}

	// The engine could not act and reports it via a negative ack. The worker must
	// NOT treat the command as done: it un-latches and the next drive re-commands.
	ackBad, _ := json.Marshal(map[string]any{"action": "execute-tool", "toolUseId": "tu-1", "ok": false})
	w.dispatchMessage(workerMessage{Type: "tool-command-ack", Payload: ackBad, OriginClient: "engine"})
	w.driveToolActions()
	flush()
	if got := count(); got != 2 {
		t.Fatalf("after negative ack: want 2 (re-driven), got %d", got)
	}

	// The engine confirms it handled the command. The worker latches the dedup so
	// steady-state re-drives don't re-command an executing/terminal tool.
	ackOK, _ := json.Marshal(map[string]any{"action": "execute-tool", "toolUseId": "tu-1", "ok": true})
	w.dispatchMessage(workerMessage{Type: "tool-command-ack", Payload: ackOK, OriginClient: "engine"})
	w.driveToolActions()
	flush()
	if got := count(); got != 2 {
		t.Fatalf("after positive ack: want 2 (latched, no re-command), got %d", got)
	}
}
