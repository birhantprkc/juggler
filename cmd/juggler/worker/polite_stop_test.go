//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// TestPoliteStop_ReducerRestsBeforeNextTurn is the core polite-stop (Pause)
// guarantee: with the latch set, a completed tool batch that would normally
// re-drive the model instead rests at idle before the next LLM turn. Nothing is
// cancelled — the tool keeps its real result — and any queued message is
// promoted into the conversation as an ordinary user item (D1, D3, D4). The
// scripted turn must NOT be consumed: the model is not re-invoked.
func TestPoliteStop_ReducerRestsBeforeNextTurn(t *testing.T) {
	w := NewConversationWorker("test-polite-rest", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Seed a completed tool batch awaiting the model's reaction: user asked,
	// assistant called a tool, the tool has completed with a real result.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "run bash",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll run that.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateCompleted, Result: resultJSON("ok"),
		TransactionID: "txn-0",
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// User typed a follow-up while the tool ran — parked in the pending queue.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// The user pressed Pause: latch set before the reducer would re-drive.
	w.politeStop.Store(true)

	// One scripted turn. If polite stop fails to suppress the re-dispatch this
	// turn is consumed and an assistant reply lands — the regression signal.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN"}}, StopReason: "end_turn"},
	})

	// Feed context/tools on demand so that IF a turn wrongly dispatches it
	// COMPLETES (leaving evidence) instead of hanging the test on the channel.
	stop := make(chan struct{})
	defer close(stop)
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			select {
			case <-stop:
				return
			case w.contextResultChan <- ctxResp:
			}
		}
	}()
	go func() {
		for {
			select {
			case <-stop:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	// Drive the reducer exactly as the event loop would after the tool completes.
	w.needsReconcile = true
	for i := 0; i < 10 && w.needsReconcile; i++ {
		w.tryReconcile()
	}

	// The model was NOT re-invoked: the scripted turn is still on the queue.
	if n := len(w.mock.responses); n != 1 {
		t.Fatalf("polite stop failed to suppress the next turn: %d scripted responses left, want 1", n)
	}

	// The latch was consumed exactly once (so the next user-initiated turn runs).
	if w.politeStop.Load() {
		t.Error("politeStop latch not consumed after resting at idle")
	}

	// The worker rested at ordinary idle.
	if st, _ := w.readProcessingState()["status"].(string); st != "idle" {
		t.Errorf("worker status = %q, want idle after polite stop", st)
	}

	// Nothing was cancelled: the tool keeps its completed result.
	items := w.doc.GetItems()
	if items[2].State != StateCompleted {
		t.Errorf("tool-action state = %q, want %q (polite stop must not cancel/interrupt)", items[2].State, StateCompleted)
	}

	// The queued message was promoted to an ordinary trailing user item, and no
	// assistant reply was appended after it (the model never reacted).
	last := items[len(items)-1]
	if last.Type != ItemTypeUser || last.Content != "queued follow-up" {
		t.Fatalf("trailing item = {%q,%q}, want a promoted user item %q", last.Type, last.Content, "queued follow-up")
	}
	if w.hasPendingItems("") {
		t.Error("pending queue should be drained (promoted) after polite stop settled to idle")
	}
}

// TestPoliteStop_IdlePauseIsNoOp pins V3: a pause that arrives while the worker
// is idle must NOT latch — otherwise it would strand the flag and suppress the
// next user-initiated turn.
func TestPoliteStop_IdlePauseIsNoOp(t *testing.T) {
	w := NewConversationWorker("test-polite-idle", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	w.handlePause()

	if w.politeStop.Load() {
		t.Error("handlePause latched on an idle worker; an idle pause must be a no-op (V3)")
	}
}

// TestPoliteStop_HandlePauseLatchesWhenBusy verifies the complementary case: a
// pause while a turn is parked (activity=awaiting_llm) latches the polite stop.
func TestPoliteStop_HandlePauseLatchesWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-polite-busy", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	w.handlePause()

	if !w.politeStop.Load() {
		t.Error("handlePause did not latch while the worker was busy (awaiting_llm)")
	}
}

// TestPoliteStop_SupersededByHardCancel pins D7: a hard cancel while a polite
// stop is pending drops the latch (escalation), so the turn after the cancel is
// never spuriously suppressed.
func TestPoliteStop_SupersededByHardCancel(t *testing.T) {
	w := NewConversationWorker("test-polite-escalate", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	w.politeStop.Store(true)
	w.handleCancel()

	if w.politeStop.Load() {
		t.Error("hard cancel did not supersede the pending polite stop (D7)")
	}
}

// TestPoliteStop_ClearedByExplicitSend pins D6: an explicit send on an idle
// worker is an unambiguous "resume now" that clears any pending latch, so the
// user-initiated turn is not suppressed. (No model config is set, so the send
// short-circuits at validation without driving a turn — the latch clear runs
// before that guard.)
func TestPoliteStop_ClearedByExplicitSend(t *testing.T) {
	w := NewConversationWorker("test-polite-resume", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	w.politeStop.Store(true)

	payload, _ := json.Marshal(map[string]any{"text": "resume with this"})
	w.handleSendMessage(payload)

	if w.politeStop.Load() {
		t.Error("explicit send did not clear the pending polite stop (D6 resume)")
	}
}

// TestPoliteStop_UnpauseClearsPendingLatch verifies the Pause-button toggle-off
// path: an "unpause" while a polite stop is pending drops the latch so the turn
// continues to its next boundary instead of resting at idle. This is the inverse
// of handlePause and, unlike a hard cancel, is non-destructive.
func TestPoliteStop_UnpauseClearsPendingLatch(t *testing.T) {
	w := NewConversationWorker("test-polite-unpause", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	w.politeStop.Store(true)
	w.handleUnpause()

	if w.politeStop.Load() {
		t.Error("handleUnpause did not clear the pending polite stop")
	}
}

// TestPoliteStop_UnpauseIsIdempotent pins that clearing an already-unset latch is
// a harmless no-op — an unpause that races past the consuming boundary must not
// wedge anything (the turn was going to continue regardless).
func TestPoliteStop_UnpauseIsIdempotent(t *testing.T) {
	w := NewConversationWorker("test-polite-unpause-noop", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)

	w.handleUnpause() // latch already false

	if w.politeStop.Load() {
		t.Error("handleUnpause spuriously set the latch")
	}
}

// TestPoliteStop_PublishesPendingToProcessingState verifies the pause-pending cue
// is server-authoritative rather than client-local: latching the polite stop
// mirrors politePending=true into the synced processingState (so a client that
// reloads mid-pause restores the "Pausing…" cue from the doc), and un-pausing
// drops it. Without this the whole feature rests on optimistic local state that a
// reload resets to false.
func TestPoliteStop_PublishesPendingToProcessingState(t *testing.T) {
	w := NewConversationWorker("test-polite-publish", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	w.handlePause()

	if !w.politeStop.Load() {
		t.Fatal("handlePause did not latch while the worker was busy")
	}
	if pending, _ := w.readProcessingState()["politePending"].(bool); !pending {
		t.Error("handlePause did not publish politePending=true into the synced processingState")
	}

	w.handleUnpause()

	if w.politeStop.Load() {
		t.Fatal("handleUnpause did not clear the latch")
	}
	if _, present := w.readProcessingState()["politePending"]; present {
		t.Error("handleUnpause left a stale politePending in processingState")
	}
}

// TestPoliteStop_ConsumeAndIdleDropPublishedPending verifies the published cue
// tracks the latch across a turn: a busy status frame re-emits it (stateMap is
// rebuilt from scratch each frame), consuming the latch at a boundary clears it,
// and a resting idle frame never carries it even if the latch somehow lingers —
// a pending pause is meaningless on an idle worker.
func TestPoliteStop_ConsumeAndIdleDropPublishedPending(t *testing.T) {
	w := NewConversationWorker("test-polite-consume-publish", "user:test")
	defer w.doc.Destroy()
	w.storeState(StateIdle)
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityCallingLLM, "threadItemId": "", "status": "streaming",
	})

	w.setPolitePending()
	if p, _ := w.readProcessingState()["politePending"].(bool); !p {
		t.Fatal("setPolitePending did not publish politePending")
	}

	// A busy status frame must re-emit the flag from the latch — the frame is
	// rebuilt from scratch, so without the re-emit the flag would flicker off.
	w.sendStatus("streaming", "")
	if p, _ := w.readProcessingState()["politePending"].(bool); !p {
		t.Error("busy sendStatus frame dropped politePending while the latch was set")
	}

	// Consuming at a turn boundary clears both the latch and the published flag.
	if !w.consumePolitePending() {
		t.Fatal("consumePolitePending reported the latch was already unset")
	}
	if _, present := w.readProcessingState()["politePending"]; present {
		t.Error("consumePolitePending left politePending in processingState")
	}

	// Defensive: even with the latch forced back on, a resting idle frame must
	// never publish a pending cue — there is nothing to pause at idle.
	w.politeStop.Store(true)
	w.sendStatus("idle", "")
	if _, present := w.readProcessingState()["politePending"]; present {
		t.Error("idle sendStatus frame published politePending on a resting worker")
	}
	w.politeStop.Store(false)
}
