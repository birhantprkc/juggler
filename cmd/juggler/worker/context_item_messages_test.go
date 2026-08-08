//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
)

// TestAppendContextItemMessages: standing context items are appended AFTER
// history as user-role context-item messages (never folded into the system
// prompt), and empty ones are skipped. This is the property that keeps the
// tools+system prefix stable across a todo update or a pinned-file edit.
func TestAppendContextItemMessages(t *testing.T) {
	base := []map[string]any{
		{"type": "user", "content": "hello"},
		{"type": "assistant", "content": "hi"},
	}
	out := appendContextItemMessages(base, []ItemContext{
		{ItemID: "TODO_1", Content: "# Todo list\n1. [\u25B6] do it"},
		{ItemID: "EMPTY_1", Content: ""}, // skipped
		{ItemID: "FILE_1", Content: "package main"},
	})

	// Two non-empty context items appended after the two history messages.
	if len(out) != 4 {
		t.Fatalf("expected 4 messages (2 history + 2 context), got %d: %+v", len(out), out)
	}

	// History is untouched and stays first.
	if out[0]["type"] != "user" || out[1]["type"] != "assistant" {
		t.Fatalf("history messages must stay at the front, got %+v", out[:2])
	}

	// The appended messages are context-item-typed, in order, carrying the header.
	for i, wantID := range []string{"TODO_1", "FILE_1"} {
		msg := out[2+i]
		if msg["type"] != messageTypeContextItem {
			t.Errorf("message[%d] type = %v, want %q", 2+i, msg["type"], messageTypeContextItem)
		}
		content, _ := msg["content"].(string)
		if !strings.HasPrefix(content, "=== Context: "+wantID+" ===\n") {
			t.Errorf("message[%d] content missing %q header; got %q", 2+i, wantID, content)
		}
	}
}

// TestAppendContextItemMessagesNilIsNoOp: a turn with no standing context items
// (the common case, and how most tests call buildMessages(nil)) leaves the
// history messages exactly as they were.
func TestAppendContextItemMessagesNilIsNoOp(t *testing.T) {
	base := []map[string]any{{"type": "user", "content": "hello"}}
	out := appendContextItemMessages(base, nil)
	if len(out) != 1 || out[0]["content"] != "hello" {
		t.Fatalf("nil contexts must be a no-op; got %+v", out)
	}
}

// TestSplitContextsByPosition: "prefix" items bucket into the leading run and
// everything else (explicit "user" and the empty default) into the trailing run,
// each preserving its relative order.
func TestSplitContextsByPosition(t *testing.T) {
	prefix, tail := splitContextsByPosition([]ItemContext{
		{ItemID: "FILE_1", Content: "a", Position: "prefix"},
		{ItemID: "TAIL_1", Content: "b", Position: "user"},
		{ItemID: "FILE_2", Content: "c", Position: "prefix"},
		{ItemID: "DEFAULT_1", Content: "d"}, // empty position ⇒ tail
	})
	if len(prefix) != 2 || prefix[0].ItemID != "FILE_1" || prefix[1].ItemID != "FILE_2" {
		t.Fatalf("prefix run wrong: %+v", prefix)
	}
	if len(tail) != 2 || tail[0].ItemID != "TAIL_1" || tail[1].ItemID != "DEFAULT_1" {
		t.Fatalf("tail run wrong: %+v", tail)
	}
}

// TestPrependContextItemMessages: prefix contexts render as leading context-item
// messages, in order, ahead of the messages they are prepended to; empty ones
// are skipped.
func TestPrependContextItemMessages(t *testing.T) {
	history := []map[string]any{{"type": "user", "content": "hello"}}
	out := prependContextItemMessages(nil, []ItemContext{
		{ItemID: "FILE_1", Content: "package main", Position: "prefix"},
		{ItemID: "EMPTY_1", Content: ""}, // skipped
	})
	out = append(out, history...)
	if len(out) != 2 {
		t.Fatalf("expected 1 prefix + 1 history, got %d: %+v", len(out), out)
	}
	if out[0]["type"] != messageTypeContextItem {
		t.Fatalf("prefix context must lead; got %+v", out[0])
	}
	if c, _ := out[0]["content"].(string); !strings.HasPrefix(c, "=== Context: FILE_1 ===\n") {
		t.Fatalf("prefix content missing header; got %q", c)
	}
	if out[1]["content"] != "hello" {
		t.Fatalf("history must follow the prefix run; got %+v", out[1])
	}
}

// TestBuildMessages_PrefixLeadsUserTrails: buildMessages places "prefix" context
// items BEFORE the conversation history and "user" context items AFTER it, so a
// frozen (prefix) item rides the cached prefix while a live (user) item stays at
// the uncached tail.
func TestBuildMessages_PrefixLeadsUserTrails(t *testing.T) {
	w := NewConversationWorker("conv-ctx-split", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "hello"})

	msgs := w.buildMessages([]ItemContext{
		{ItemID: "FILE_1", Content: "package main", Position: "prefix"},
		{ItemID: "LIVE_1", Content: "live state", Position: "user"},
	})

	// Expected order: [prefix ctx][u-1][a-1][user ctx].
	prefixIdx, userMsgIdx, asstIdx, tailIdx := -1, -1, -1, -1
	for i, m := range msgs {
		c, _ := m["content"].(string)
		switch {
		case m["type"] == messageTypeContextItem && strings.Contains(c, "FILE_1"):
			prefixIdx = i
		case m["type"] == messageTypeContextItem && strings.Contains(c, "LIVE_1"):
			tailIdx = i
		case m["type"] == "user" && c == "hi":
			userMsgIdx = i
		case m["type"] == "assistant" && c == "hello":
			asstIdx = i
		}
	}
	if prefixIdx != 0 {
		t.Fatalf("prefix context must be the FIRST message; got index %d in %+v", prefixIdx, msgs)
	}
	if prefixIdx >= userMsgIdx || userMsgIdx >= asstIdx || asstIdx >= tailIdx {
		t.Fatalf("want prefix < history < tail; got prefix=%d user=%d asst=%d tail=%d", prefixIdx, userMsgIdx, asstIdx, tailIdx)
	}
}

// TestBuildMessages_PrefixByteStableAcrossAppendedTurn is the anti-re-bill guard:
// a "prefix" context item stays the FIRST message and byte-identical across a
// later turn that only appended history, so it remains inside the cached prefix
// rather than being re-read as the conversation grows.
func TestBuildMessages_PrefixByteStableAcrossAppendedTurn(t *testing.T) {
	w := NewConversationWorker("conv-ctx-stable", "user:test")
	defer w.doc.Destroy()

	prefixCtx := []ItemContext{{ItemID: "FILE_1", Content: "package main", Position: "prefix"}}

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "one"})
	turn1 := w.buildMessages(prefixCtx)

	// Next turn: history grew (assistant reply + a new user message), same pin.
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "reply"})
	w.doc.InsertMessage(2, ConversationItem{Type: ItemTypeUser, ItemID: "u-2", Content: "two"})
	turn2 := w.buildMessages(prefixCtx)

	if turn1[0]["type"] != messageTypeContextItem || turn2[0]["type"] != messageTypeContextItem {
		t.Fatalf("prefix must lead both turns; got %v / %v", turn1[0]["type"], turn2[0]["type"])
	}
	if turn1[0]["content"] != turn2[0]["content"] {
		t.Fatalf("prefix message diverged across an append-only turn:\n  turn1=%q\n  turn2=%q", turn1[0]["content"], turn2[0]["content"])
	}
	// And history genuinely grew beneath it (sanity: the pin didn't just pin an
	// empty conversation).
	if len(turn2) <= len(turn1) {
		t.Fatalf("expected turn2 to have more messages than turn1; got %d vs %d", len(turn2), len(turn1))
	}
}
