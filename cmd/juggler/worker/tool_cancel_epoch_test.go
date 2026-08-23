//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// cancelEpochHarness wires a worker with an attached engine that records every
// cancel-tool command (with its runningEpoch) the worker dispatches. A sentinel
// on the same ordered mailbox makes flush() a deterministic barrier — no sleeps.
type cancelEpochHarness struct {
	w       *ConversationWorker
	cancels chan ToolCommand
	flushCh chan struct{}
}

func newCancelEpochHarness(t *testing.T, convID string) *cancelEpochHarness {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.handleInit(initPayload)

	h := &cancelEpochHarness{
		w:       w,
		cancels: make(chan ToolCommand, 64),
		flushCh: make(chan struct{}, 1),
	}
	w.SetCallback("engine", func(b []byte) {
		var m ToolCommand
		_ = json.Unmarshal(b, &m)
		switch m.Type {
		case "flush-sentinel":
			select {
			case h.flushCh <- struct{}{}:
			default:
			}
		case "cancel-tool":
			h.cancels <- m
		}
	})
	w.SetEngineClientID("engine")
	return h
}

func (h *cancelEpochHarness) flush(t *testing.T) {
	t.Helper()
	b, _ := json.Marshal(ToolCommand{Type: "flush-sentinel"})
	h.w.callbacks.sendToEngine(b)
	select {
	case <-h.flushCh:
	case <-time.After(2 * time.Second):
		t.Fatal("flush barrier timed out")
	}
}

// drainCancels collects every cancel-tool command delivered so far (the flush
// barrier guarantees all prior callback sends have completed).
func (h *cancelEpochHarness) drainCancels() []ToolCommand {
	var out []ToolCommand
	for {
		select {
		case c := <-h.cancels:
			out = append(out, c)
		default:
			return out
		}
	}
}

// readToolActionField reads one field of a tool-action from the live doc under
// ycrdtMu, for asserting post-conditions.
func readToolActionField(w *ConversationWorker, toolUseID, field string) any {
	var v any
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if id, _ := m.Get("toolUseId").(string); id != toolUseID {
			return false
		}
		v = m.Get(field)
		return true
	})
	ycrdtMu.Unlock()
	return v
}

// TestCancelToolDispatchCarriesRunningEpoch is the Phase-1 wire guard: a cancel
// of a running tool-action dispatches a cancel-tool command carrying the exact
// runningEpoch the doc held — captured under the same ycrdtMu hold that writes
// 'cancelled', so the engine can scope its abort to that generation and never
// kill a fresh re-run of the same toolUseId.
func TestCancelToolDispatchCarriesRunningEpoch(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-cancel-epoch")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateRunning,
	})
	// Stamp the execution generation the engine's claimRunning would have written.
	// Use an int literal: convertToYcrdt (the doc write path) accepts Number(=int)
	// and narrows float64, matching how a synced JS number lands — but NOT int64.
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{"runningEpoch": 7})

	w.CancelInFlightToolActions()
	h.flush(t)

	cancels := h.drainCancels()
	if len(cancels) != 1 {
		t.Fatalf("want exactly one cancel-tool command, got %d: %+v", len(cancels), cancels)
	}
	if cancels[0].ToolUseID != "tu-1" {
		t.Fatalf("cancel targeted the wrong tool: got %q", cancels[0].ToolUseID)
	}
	if cancels[0].RunningEpoch != 7 {
		t.Fatalf("cancel-tool must carry the doc's runningEpoch: want 7, got %d", cancels[0].RunningEpoch)
	}
	// And the tool-action itself is now terminal.
	if state, _ := readToolActionField(w, "tu-1", "state").(string); state != StateCancelled {
		t.Fatalf("cancelled tool should be StateCancelled, got %q", state)
	}
}

// TestCancelApprovedTool_UnscopedEpoch verifies that a tool cancelled while still
// StateApproved (never claimed → no runningEpoch stamped) dispatches an UNSCOPED
// cancel (epoch 0), preserving the gap-closing behaviour: the command is still
// harmless-and-idempotent if the engine claims approved→running just after.
func TestCancelApprovedTool_UnscopedEpoch(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-cancel-approved")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2",
		ToolName: "bash", State: StateApproved,
	})

	w.CancelInFlightToolActions() // includeApproved=true
	h.flush(t)

	cancels := h.drainCancels()
	if len(cancels) != 1 {
		t.Fatalf("want exactly one cancel-tool command, got %d: %+v", len(cancels), cancels)
	}
	if cancels[0].RunningEpoch != 0 {
		t.Fatalf("an approved (never-claimed) tool must cancel unscoped: want epoch 0, got %d", cancels[0].RunningEpoch)
	}
}

// TestReattachReset_PreservesRunningEpoch is the Phase-1 invariant that makes the
// epoch a monotonic per-incarnation identity: the reattach reset moves a stranded
// running tool back to approved and clears runningStartedAt, but must NOT clear
// runningEpoch — so the next claim increments strictly past it and a stale cancel
// can never match the re-run.
func TestReattachReset_PreservesRunningEpoch(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-reset-epoch")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-3", ToolUseID: "tu-3",
		ToolName: "bash", State: StateRunning,
	})
	w.doc.UpdateToolActionFieldsRecursive("tu-3", map[string]any{
		"runningEpoch":     3,
		"runningStartedAt": 1_700_000_000_000,
	})

	w.resetRunningToolsForReattach()

	if state, _ := readToolActionField(w, "tu-3", "state").(string); state != StateApproved {
		t.Fatalf("reset should return the tool to StateApproved, got %q", state)
	}
	if rs := readToolActionField(w, "tu-3", "runningStartedAt"); rs != nil {
		t.Fatalf("reset should clear runningStartedAt, got %v", rs)
	}
	epoch, ok := docNumberToInt64(readToolActionField(w, "tu-3", "runningEpoch"))
	if !ok || epoch != 3 {
		t.Fatalf("reset must preserve runningEpoch: want 3, got %v (ok=%v)", epoch, ok)
	}
}
