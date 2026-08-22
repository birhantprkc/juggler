//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Regression coverage for a stop_reason=tool_use that carries no usable tool
// call: the model streams some prose, starts a tool block, and never produces a
// valid one. The CLI discards that message and re-prompts itself ("The previous
// response failed to produce a valid tool call. Please retry the tool call
// now."), so the turn is NOT over and nothing is parked on our side.
//
// Observed in the wild as a conversation that printed one sentence, ran no
// tool, and went idle with no error: the parser reported a pause with zero
// blocks, finalizeTurn returned the bare tool_use stop reason, and the worker —
// seeing streamed text and no tool to run — treated it as a finished turn.

package claudecode

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// messageStartLine opens a new API call within the turn, resetting the parser's
// per-call tool tallies exactly as the CLI's passthrough does.
func messageStartLine(t *testing.T) string {
	t.Helper()
	return mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}})
}

// toolUsePauseLine closes an API call with stop_reason=tool_use — the pause the
// parser must only honour when the call actually parked something.
func toolUsePauseLine(t *testing.T) string {
	t.Helper()
	return mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
	}})
}

// proseLines builds one complete text block — the prose the model streams before
// its tool call, and the reason a failed round can pass for a finished turn.
func proseLines(t *testing.T, text string) []string {
	t.Helper()
	return []string{
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"},
		}}),
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": text},
		}}),
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_stop", "index": 0,
		}}),
	}
}

// TestParser_ToolUseStopWithNoToolCallDoesNotPause is the core regression: a
// round that ends in stop_reason=tool_use having emitted no tool_use block at
// all must not pause the turn. Pausing hands the worker a round with nothing to
// execute — and because the round streamed text, the worker's barren-turn retry
// doesn't engage either, so the conversation stops dead with no explanation.
func TestParser_ToolUseStopWithNoToolCallDoesNotPause(t *testing.T) {
	c := newParserClient()
	lines := []string{messageStartLine(t)}
	lines = append(lines, proseLines(t, "Now implementing the generic scoped store.")...)
	lines = append(lines, toolUsePauseLine(t))

	res, _, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("a tool_use stop with no tool call must not fail the turn (the CLI recovers from it), got %v", err)
	}
	if pause || count != 0 {
		t.Fatalf("a round that parked nothing must not pause, got pause=%v count=%d", pause, count)
	}
	if res.StopReason == "tool_use" {
		t.Error("the turn must not be marked as a tool_use pause — finalizeTurn reads that as a parked round and the worker as a finished one")
	}
	if len(res.Blocks) != 1 || res.Blocks[0].Type != provider.ContentBlockTypeText {
		t.Fatalf("the streamed prose must survive into the turn, got blocks=%+v", res.Blocks)
	}
}

// TestParser_ToolUseStopWithNoToolCallReadsOnForRecovery covers the other half:
// staying in the read loop is what lets the CLI's self-issued retry land. The
// recovery round's tool call is the one that pauses the turn, and it carries the
// prose from the failed round with it.
func TestParser_ToolUseStopWithNoToolCallReadsOnForRecovery(t *testing.T) {
	c := newParserClient()
	lines := []string{messageStartLine(t)}
	lines = append(lines, proseLines(t, "Now implementing the generic scoped store.")...)
	lines = append(lines, toolUsePauseLine(t))
	// The CLI feeds itself the retry prompt and the model calls the tool properly.
	lines = append(lines, messageStartLine(t))
	lines = append(lines, streamToolUseLines(t, 0, "t-retry", "mcp__juggler__read",
		map[string]any{"file_path": "session.js"})...)
	lines = append(lines, toolUsePauseLine(t))

	res, chunks, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pause || count != 1 {
		t.Fatalf("the recovery round's tool call must pause the turn exactly once, got pause=%v count=%d", pause, count)
	}
	tools := 0
	for _, ch := range filterNonProgress(chunks) {
		if ch.Type != provider.ContentBlockTypeToolUse {
			continue
		}
		tools++
		if ch.ToolUseID != "t-retry" {
			t.Errorf("emitted the wrong tool_use: %q", ch.ToolUseID)
		}
	}
	if tools != 1 {
		t.Errorf("expected exactly the recovery tool_use, got %d", tools)
	}
	if len(res.Blocks) != 2 {
		t.Fatalf("expected the prose block plus the recovery tool_use, got %+v", res.Blocks)
	}
}

// TestFinalizeTurn_ToolUseWithNoPendingCallsFails pins the dispatch-side
// backstop. The parser suppresses this pause now, so the branch is defensive —
// but it must fail loudly rather than return the bare stop reason: a StreamResult
// carrying stop_reason=tool_use and no tool is indistinguishable from a finished
// turn to the worker, which is exactly how the conversation ended in silence.
func TestFinalizeTurn_ToolUseWithNoPendingCallsFails(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	c.activeSession = &activeSession{sessionUUID: "uuid-no-call"}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()

	turn := &turnResult{
		StopReason:       "tool_use",
		CacheWriteTokens: 3621,
		Blocks: []provider.ContentBlock{{
			Type:    provider.ContentBlockTypeText,
			Content: "Now implementing the generic scoped store.",
		}},
	}

	res, err := c.finalizeTurn(provider.MessageRequest{
		ConversationID: "conv-no-call",
		Messages:       []provider.Message{userMsg("do a thing")},
	}, turn, nil)

	if err == nil {
		t.Fatal("a tool_use stop that parked no call must surface as a turn error, not a stop reason")
	}
	if !isTransientCLIError(err) {
		t.Errorf("the failure must be transient so an attempt that streamed nothing is retried: %v", err)
	}
	if res == nil || res.StopReason == "tool_use" {
		t.Fatalf("must not report a tool_use pause, got %+v", res)
	}
	if c.activeSession != nil {
		t.Error("the unanswerable session must be released so the next turn starts fresh")
	}
}
