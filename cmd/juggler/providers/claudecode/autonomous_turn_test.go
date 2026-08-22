//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// textTurnLines returns the stream-json lines the CLI emits for one complete
// text-only turn (content_block_start → delta → stop → message_delta end_turn).
// Mirrors the fake CLI's emitTextTurn but as a []string so tests can pre-buffer
// a turn directly into s.content without a live subprocess.
func textTurnLines(text string) []string {
	mk := func(v map[string]any) string { b, _ := json.Marshal(v); return string(b) }
	return []string{
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_stop", "index": 0}}),
		mk(map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"input_tokens": 100, "output_tokens": 50}}}),
	}
}

// turnText returns the concatenated text of a turn's text blocks — enough to
// identify which fake-CLI turn surfaced.
func turnText(tr *turnResult) string {
	if tr == nil {
		return ""
	}
	out := ""
	for _, b := range tr.Blocks {
		if b.Type == provider.ContentBlockTypeText {
			out += b.Content
		}
	}
	return out
}

// TestAutonomousTurn_SurfacedBetweenSends is the core step-3 invariant: a turn
// the persistent CLI emits with NO Submit in flight (a scheduled wake /
// monitor firing) is surfaced via the autonomous-turn sink — in arrival
// order, between two user sends — rather than buffered unread and
// mis-attributed to the next user message (the reported bug).
//
// The fake CLI (fakeModeAutonomous) emits the solicited reply for turn 1 and
// then, unprompted, one extra "autonomous wake" turn. With the foreground
// turn finished, nobody is reading stdout — yet the background drain must
// pick up that autonomous turn and hand it to onAutonomousTurn. Turn 2 must
// then proceed normally and receive its own (correct) reply, proving the
// autonomous turn was not mis-attributed to it.
func TestAutonomousTurn_SurfacedBetweenSends(t *testing.T) {
	installFakeClaude(t, fakeModeAutonomous, "uuid-autonomous")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-autonomous"
	ctx := context.Background()

	autoTurns := make(chan *turnResult, 4)
	c.onAutonomousTurn = func(tr *turnResult) { autoTurns <- tr }

	// Turn 1 (solicited).
	res1, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("turn 1 user")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 1 streamMessage: %v", err)
	}
	if res1.StopReason != "end_turn" {
		t.Fatalf("turn 1 StopReason = %q, want end_turn", res1.StopReason)
	}

	// The fake emitted an unsolicited turn right after turn 1's reply. It
	// must surface via the autonomous-turn sink with no Submit in flight.
	select {
	case tr := <-autoTurns:
		if got := turnText(tr); got != "autonomous wake" {
			t.Fatalf("autonomous turn text = %q, want %q", got, "autonomous wake")
		}
		if tr.StopReason != "end_turn" {
			t.Fatalf("autonomous turn StopReason = %q, want end_turn", tr.StopReason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("autonomous turn was not surfaced within 3s (drain not draining between sends)")
	}

	// Turn 2 (solicited) still works and is not mis-attributed.
	res2, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{
			userMsg("turn 1 user"), assistantMsg("solicited 1"), userMsg("turn 2 user"),
		},
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 2 streamMessage: %v", err)
	}
	if res2.StopReason != "end_turn" {
		t.Fatalf("turn 2 StopReason = %q, want end_turn", res2.StopReason)
	}

	// No further autonomous turn is expected; turn 2 produced only its
	// solicited reply.
	select {
	case tr := <-autoTurns:
		t.Fatalf("unexpected second autonomous turn: %q", turnText(tr))
	case <-time.After(200 * time.Millisecond):
	}

	c.dropSession(convID)
}

// TestSendSiteFlush_SurfacesBufferedTurnsInOrderBeforeForeground is the step-4
// invariant: at Submit time, any already-complete autonomous turns sitting in
// s.content (e.g. one that arrived in the cancel-race window just as the user
// pressed send) must be surfaced to the sink — in arrival order — BEFORE the
// foreground read consumes them. Otherwise the foreground turn mis-reads the
// oldest buffered turn as the user message's reply (the reported bug).
//
// Deterministic by construction: we pre-buffer two complete turns into
// s.content with no live drain or subprocess, then call flushBufferedTurns
// directly and assert both surface in order and the channel is fully drained
// (so a subsequent foreground read would see none of them).
func TestSendSiteFlush_SurfacesBufferedTurnsInOrderBeforeForeground(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	var surfaced []string
	c.onAutonomousTurn = func(tr *turnResult) { surfaced = append(surfaced, turnText(tr)) }

	content := make(chan string, 32)
	for _, l := range textTurnLines("wake 1") {
		content <- l
	}
	for _, l := range textTurnLines("wake 2") {
		content <- l
	}
	c.activeSession = &activeSession{
		sessionUUID: "uuid-flush",
		live: &liveCLI{
			content: content,
			scanErr: make(chan error, 1),
		},
	}

	c.flushBufferedTurns()

	want := []string{"wake 1", "wake 2"}
	if !reflect.DeepEqual(surfaced, want) {
		t.Fatalf("surfaced = %v, want %v (buffered turns must surface in arrival order before the foreground read)", surfaced, want)
	}
	if len(content) != 0 {
		t.Errorf("content not fully drained: %d line(s) remain — the foreground read would mis-attribute them", len(content))
	}
}

// TestSendSiteFlush_NoBufferedTurnsIsCheap asserts the common case (nothing
// buffered) does nothing and surfaces nothing — the flush must not block or
// fabricate turns when the CLI has been quiet.
func TestSendSiteFlush_NoBufferedTurnsIsCheap(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	called := false
	c.onAutonomousTurn = func(*turnResult) { called = true }
	c.activeSession = &activeSession{
		sessionUUID: "uuid-quiet",
		live: &liveCLI{
			content: make(chan string, 4),
			scanErr: make(chan error, 1),
		},
	}

	done := make(chan struct{})
	go func() { c.flushBufferedTurns(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("flushBufferedTurns blocked on an empty content channel")
	}
	if called {
		t.Error("flushBufferedTurns surfaced a turn when nothing was buffered")
	}
}
