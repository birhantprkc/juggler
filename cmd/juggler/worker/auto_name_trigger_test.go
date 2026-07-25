//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

type autoNameCall struct {
	convID, firstMessage, provider, model, thinking string
}

// newAutoNameWorker builds an idle worker with a resolvable default model and a
// recording auto-namer installed.
func newAutoNameWorker(t *testing.T, id string, calls *[]autoNameCall) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(id, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A", "thinking": "high"})
	w.SetAutoNamer(func(convID, firstMessage, provider, model, thinking string) {
		*calls = append(*calls, autoNameCall{convID, firstMessage, provider, model, thinking})
	})
	return w
}

func sendMsg(t *testing.T, w *ConversationWorker, msg SendMessageMessage) {
	t.Helper()
	payload, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	w.handleSendMessage(payload)
}

// TestAutoNameFiresOnFirstRootMessage pins the fire guard: the first user
// message on the root thread signals the auto-namer exactly once, with the
// message text and the resolved primary model.
func TestAutoNameFiresOnFirstRootMessage(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-first", &calls)

	sendMsg(t, w, SendMessageMessage{Text: "Add a dark mode toggle"})

	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 auto-name call, got %d", len(calls))
	}
	got := calls[0]
	want := autoNameCall{"conv-first", "Add a dark mode toggle", "prov-A", "model-A", "high"}
	if got != want {
		t.Fatalf("auto-name call = %+v, want %+v", got, want)
	}
}

// TestAutoNameDoesNotFireWhenUserMessageExists pins the once-only guard: a
// conversation that already holds a user message (a reconnect, or a second
// send) does not re-trigger naming.
func TestAutoNameDoesNotFireWhenUserMessageExists(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-existing", &calls)

	// Seed a prior root user message directly, then send another while idle.
	w.addUserMessage(UserMessageInput{Text: "an earlier message"})

	sendMsg(t, w, SendMessageMessage{Text: "another message"})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call when a user message already exists, got %+v", calls)
	}
}

// TestAutoNameDoesNotFireOnContinuation verifies an explicit Continue (no new
// user text) never triggers naming.
func TestAutoNameDoesNotFireOnContinuation(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-continue", &calls)

	sendMsg(t, w, SendMessageMessage{IsContinuation: true})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call on continuation, got %+v", calls)
	}
}

// TestAutoNameDoesNotFireOnEmptyText verifies a text-less first message does not
// trigger naming — there is nothing to summarise.
func TestAutoNameDoesNotFireOnEmptyText(t *testing.T) {
	var calls []autoNameCall
	w := newAutoNameWorker(t, "conv-empty", &calls)

	// Whitespace-only text with an attachment: not "empty" (so it reaches the
	// add-message block), but there is no text to name from.
	sendMsg(t, w, SendMessageMessage{Text: "   ", Attachments: []AssetRef{{ID: "sha", Mime: "image/png"}}})

	if len(calls) != 0 {
		t.Fatalf("expected no auto-name call on text-less message, got %+v", calls)
	}
}
