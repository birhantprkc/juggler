//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestFormatMessagesCoalescesToSingleEnvelope guards the load-bearing
// invariant that one juggler StreamMessage turn writes exactly ONE
// stream-json user envelope to the persistent CLI's stdin. The CLI answers
// each '\n'-terminated envelope as its own turn, but readUntilPauseOrComplete
// reads exactly one terminal turn per call — so emitting more than one
// envelope leaves the surplus turns' responses buffered and mis-attributed
// to a later message (the "submitted-read gap" sync warning).
//
// A history of user/assistant/user/assistant/user (assistant turns split the
// users apart, so TransformToAPIMessages can't group them) must still produce
// a single envelope carrying every user content block.
func TestFormatMessagesCoalescesToSingleEnvelope(t *testing.T) {
	c := &Client{}
	msgs := []provider.Message{
		{Type: "user", Content: "first"},
		{Type: "assistant", Content: "answer one"},
		{Type: "user", Content: "second"},
		{Type: "assistant", Content: "answer two"},
		{Type: "user", Content: "third"},
	}

	lines, err := c.formatMessagesAsStreamJSONLines(msgs, "sess-1")
	if err != nil {
		t.Fatalf("formatMessagesAsStreamJSONLines: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d envelope line(s); want exactly 1 (one turn == one envelope). Lines: %v", len(lines), lines)
	}

	// The single envelope must carry every user content block, in order, and
	// must NOT carry the dropped assistant turns.
	var env struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Type != "user" || env.Message.Role != "user" {
		t.Fatalf("envelope role = %q/%q; want user/user", env.Type, env.Message.Role)
	}
	if env.SessionID != "sess-1" {
		t.Fatalf("session_id = %q; want sess-1", env.SessionID)
	}
	var texts []string
	for _, b := range env.Message.Content {
		if b.Type == "text" {
			texts = append(texts, b.Text)
		}
	}
	got := strings.Join(texts, "|")
	if got != "first|second|third" {
		t.Fatalf("coalesced user text = %q; want first|second|third (assistant turns dropped, user blocks preserved in order)", got)
	}
}

// TestFormatMessagesNoUserMessagesReturnsEmpty confirms a delta with no
// user-role content produces no envelope (callers treat empty as "nothing
// to send" and fall back).
func TestFormatMessagesNoUserMessagesReturnsEmpty(t *testing.T) {
	c := &Client{}
	lines, err := c.formatMessagesAsStreamJSONLines([]provider.Message{
		{Type: "assistant", Content: "only an assistant turn"},
	}, "sess-2")
	if err != nil {
		t.Fatalf("formatMessagesAsStreamJSONLines: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("got %d line(s); want 0 for an all-assistant delta", len(lines))
	}
}
