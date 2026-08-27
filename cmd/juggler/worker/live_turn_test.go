//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A turn dispatched under a live run loop executes on a goroutine of its own,
// which is what lets the loop keep serving the mailbox while the turn streams.
// These tests drive that path — the one the rest of the package's turn tests
// deliberately do not, because they call the strategy loop directly with no loop
// behind it at all.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// startTurningWorker returns a running, initialized worker with a model
// configured and one scripted response that pauses before returning, so a test
// can act at a known point inside a live turn.
func startTurningWorker(t *testing.T, mc *msgChan) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("conv-live-turn", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-live-turn"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.setMockResponses([]MockResponse{{
		Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "an answer"}},
		StopReason:        "end_turn",
		PauseBeforeReturn: true,
	}})

	// A turn asks the engine for its context and tools before it calls the model,
	// so it needs something on the other end or it simply waits out the timeout.
	// Answered from the callback registry's goroutine, exactly as a real client's
	// reply arrives.
	w.SetCallback("engine", func(b []byte) {
		var head struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &head) != nil {
			return
		}
		switch head.Type {
		case "request-tools":
			payload, _ := json.Marshal(ToolsResultMessage{
				Type: "tools-result", RequestID: head.RequestID,
			})
			w.handleToolsResult(payload)
		case "render-context-items-request":
			payload, _ := json.Marshal(RenderContextItemsResponse{
				Type: "render-context-items-response", RequestID: head.RequestID,
			})
			w.handleRenderContextItemsResponse(payload)
		}
	})
	w.SetEngineClientID("engine")

	w.SetCallback("client", mc.callback)
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)
	return w
}

// sendUserMessage posts an ordinary root-thread send through the mailbox.
func sendUserMessage(t *testing.T, w *ConversationWorker, text string) {
	t.Helper()
	payload, err := json.Marshal(SendMessageMessage{Type: "send-message", Text: text})
	if err != nil {
		t.Fatalf("marshalling send-message: %v", err)
	}
	w.Send("send-message", payload)
}

// awaitLiveRun waits for the dispatched turn to be published in the registry.
func awaitLiveRun(t *testing.T, w *ConversationWorker) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !w.hasLiveRun() {
		select {
		case <-deadline:
			t.Fatal("no turn was ever published as live")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// awaitNoLiveRun waits for the registry to empty again.
func awaitNoLiveRun(t *testing.T, w *ConversationWorker) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for w.hasLiveRun() {
		select {
		case <-deadline:
			t.Fatal("the finished turn was never retired from the live-run registry")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestDispatchedTurnRunsOffTheRunLoop pins the arrangement everything else in
// this phase rests on: the turn is somewhere other than the loop, the loop is
// still going, and the conversation reads as busy throughout — because a gate
// that read it as idle would dispatch a second turn on top of this one.
func TestDispatchedTurnRunsOffTheRunLoop(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	sendUserMessage(t, w, "hello")
	awaitLiveRun(t, w)

	if got := w.anyRunState(); got != StateProcessing {
		t.Fatalf("conversation state during a live turn = %v, want %v", got, StateProcessing)
	}
	// The ambient turn is NOT the one running: it holds the turn's boundary
	// state between dispatches and nothing more.
	if got := w.currentRun().loadState(); got != StateIdle {
		t.Fatalf("ambient turn state during a live turn = %v, want %v", got, StateIdle)
	}
	// The loop is still serving the mailbox — that is the whole point of moving
	// the turn off it — so a request that goes through it is answered mid-turn.
	if err := w.SendAndWait(context.Background(), "unpause", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("the run loop stopped serving the mailbox during a turn: %v", err)
	}

	w.mock.release()
	awaitNoLiveRun(t, w)

	if got := w.anyRunState(); got != StateIdle {
		t.Fatalf("conversation state after the turn = %v, want %v", got, StateIdle)
	}
}

// TestCancelDuringADispatchedTurnUnblocksIt is the behaviour the wait loops used
// to get by reading the mailbox themselves. They no longer do: the loop handles
// the cancel, resolves the run it applies to, and wakes it.
func TestCancelDuringADispatchedTurnUnblocksIt(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	sendUserMessage(t, w, "hello")
	awaitLiveRun(t, w)

	w.Send("cancel", json.RawMessage(`{"reason":"test"}`))

	// The turn is released by the cancel, not by the mock — nothing releases the
	// paused response, so a turn still waiting on it never retires.
	awaitNoLiveRun(t, w)

	if got := w.anyRunState(); got != StateIdle {
		t.Fatalf("conversation state after a cancelled turn = %v, want %v", got, StateIdle)
	}
	if w.hasActiveRun() {
		t.Fatal("a cancelled turn left a claim behind")
	}
}
