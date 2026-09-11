//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestMessageDeltaUsageAppliedOnToolUsePause pins the one event that carries an
// API call's final token counts.
//
// Anthropic puts stop_reason and the call's final usage on the SAME message_delta
// event, so a pause that acts on the stop reason without first reading the usage
// discards the only authoritative count the call ever emits — leaving turnResult
// holding the message_start seed. Agentic turns end at a pause far more often
// than at end_turn, so that is most round-trips: the counts reaching the
// transaction blob, the [turn tokens] line and the conversation's spend ceiling
// all come from here.
func TestMessageDeltaUsageAppliedOnToolUsePause(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")

	// The state a real pausing call is in: message_start has seeded the counts,
	// one dispatchable tool_use block has been parsed, and the terminal
	// message_delta is about to arrive with the real figures.
	result := &turnResult{
		InputTokens:          4,
		OutputTokens:         2,
		dispatchableThisCall: 1,
		Blocks: []provider.ContentBlock{{
			Type:      provider.ContentBlockTypeToolUse,
			ToolUseID: "t1",
			ToolName:  "bash",
			ToolInput: map[string]any{"command": "echo hi"},
		}},
	}

	pause, count, err := c.handleStreamEvent(&StreamEventDetail{
		Type:  "message_delta",
		Delta: &StreamEventDelta{StopReason: "tool_use"},
		Usage: &UsageInfo{
			InputTokens:              1200,
			OutputTokens:             880,
			CacheReadInputTokens:     190000,
			CacheCreationInputTokens: 3000,
		},
	}, result, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("handleStreamEvent: %v", err)
	}
	if !pause || count != 1 {
		t.Fatalf("pause=%v count=%d, want true/1 — the tool_use stop must still park the turn", pause, count)
	}
	if result.StopReason != provider.StopReasonToolUse {
		t.Fatalf("StopReason = %q, want tool_use", result.StopReason)
	}

	if result.OutputTokens != 880 {
		t.Fatalf("OutputTokens = %d, want 880 — the pausing call's output is final on this event, not still growing", result.OutputTokens)
	}
	if result.InputTokens != 1200 {
		t.Fatalf("InputTokens = %d, want 1200 — message_delta usage is the per-call authority, not the message_start seed", result.InputTokens)
	}
	if result.CacheReadTokens != 190000 || result.CacheWriteTokens != 3000 {
		t.Fatalf("cache read/write = %d/%d, want 190000/3000", result.CacheReadTokens, result.CacheWriteTokens)
	}
}
