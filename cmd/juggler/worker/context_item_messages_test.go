//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
)

// TestPrependContextItemMessages: standing context items render as LEADING
// context-item messages, in order, ahead of the messages they are prepended to;
// empty ones are skipped. This is the placement that keeps them inside the
// cached tools+system+history prefix.
func TestPrependContextItemMessages(t *testing.T) {
	history := []map[string]any{
		{"type": "user", "content": "hello"},
		{"type": "assistant", "content": "hi"},
	}
	out := prependContextItemMessages(nil, []ItemContext{
		{ItemID: "FILE_1", Content: "package main"},
		{ItemID: "EMPTY_1", Content: ""}, // skipped
		{ItemID: "FILE_2", Content: "more"},
	})
	out = append(out, history...)

	// Two non-empty context items lead, then the two history messages.
	if len(out) != 4 {
		t.Fatalf("expected 4 messages (2 context + 2 history), got %d: %+v", len(out), out)
	}
	for i, wantID := range []string{"FILE_1", "FILE_2"} {
		msg := out[i]
		if msg["type"] != messageTypeContextItem {
			t.Errorf("message[%d] type = %v, want %q", i, msg["type"], messageTypeContextItem)
		}
		content, _ := msg["content"].(string)
		if !strings.HasPrefix(content, "=== Context: "+wantID+" ===\n") {
			t.Errorf("message[%d] content missing %q header; got %q", i, wantID, content)
		}
	}
	// History follows the context run, untouched.
	if out[2]["content"] != "hello" || out[3]["content"] != "hi" {
		t.Fatalf("history must follow the context run; got %+v", out[2:])
	}
}

// TestPrependContextItemMessagesNilIsNoOp: a turn with no standing context items
// (the common case, and how most tests call buildMessages(nil)) prepends nothing.
func TestPrependContextItemMessagesNilIsNoOp(t *testing.T) {
	out := prependContextItemMessages(nil, nil)
	if len(out) != 0 {
		t.Fatalf("nil contexts must prepend nothing; got %+v", out)
	}
}

// TestBuildMessages_ContextLeadsHistory: buildMessages places standing context
// items BEFORE the conversation history, so they sit inside the cached prefix.
func TestBuildMessages_ContextLeadsHistory(t *testing.T) {
	w := NewConversationWorker("conv-ctx-lead", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "hello"})

	msgs := w.currentRun().buildMessages([]ItemContext{
		{ItemID: "FILE_1", Content: "package main"},
	})

	ctxIdx, userIdx, asstIdx := -1, -1, -1
	for i, m := range msgs {
		c, _ := m["content"].(string)
		switch {
		case m["type"] == messageTypeContextItem && strings.Contains(c, "FILE_1"):
			ctxIdx = i
		case m["type"] == "user" && c == "hi":
			userIdx = i
		case m["type"] == "assistant" && c == "hello":
			asstIdx = i
		}
	}
	if ctxIdx != 0 {
		t.Fatalf("context item must be the FIRST message; got index %d in %+v", ctxIdx, msgs)
	}
	if ctxIdx >= userIdx || userIdx >= asstIdx {
		t.Fatalf("want context < history; got ctx=%d user=%d asst=%d", ctxIdx, userIdx, asstIdx)
	}
}

// TestBuildMessages_ContextByteStableAcrossAppendedTurn is the anti-re-bill
// guard: a standing context item stays the FIRST message and byte-identical
// across a later turn that only appended history, so it remains inside the
// cached prefix rather than being re-read as the conversation grows.
func TestBuildMessages_ContextByteStableAcrossAppendedTurn(t *testing.T) {
	w := NewConversationWorker("conv-ctx-stable", "user:test")
	defer w.doc.Destroy()

	ctx := []ItemContext{{ItemID: "FILE_1", Content: "package main"}}

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "one"})
	turn1 := w.currentRun().buildMessages(ctx)

	// Next turn: history grew (assistant reply + a new user message), same context.
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "reply"})
	w.doc.InsertMessage(2, ConversationItem{Type: ItemTypeUser, ItemID: "u-2", Content: "two"})
	turn2 := w.currentRun().buildMessages(ctx)

	if turn1[0]["type"] != messageTypeContextItem || turn2[0]["type"] != messageTypeContextItem {
		t.Fatalf("context must lead both turns; got %v / %v", turn1[0]["type"], turn2[0]["type"])
	}
	if turn1[0]["content"] != turn2[0]["content"] {
		t.Fatalf("context message diverged across an append-only turn:\n  turn1=%q\n  turn2=%q", turn1[0]["content"], turn2[0]["content"])
	}
	if len(turn2) <= len(turn1) {
		t.Fatalf("expected turn2 to have more messages than turn1; got %d vs %d", len(turn2), len(turn1))
	}
}
