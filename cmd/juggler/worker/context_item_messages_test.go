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
