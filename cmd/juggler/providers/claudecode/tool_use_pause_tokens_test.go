//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestFinalizeTurn_ToolUsePauseSurfacesColdIngest guards the token-visibility
// fix: a tool_use pause must surface its fresh cache-CREATION (a cold-start
// re-ingest) so the burn shows up in the per-conversation [turn tokens] line,
// while still suppressing fresh-input and cache-READ (which repeat the warm
// prefix on every chained call and would inflate the turn 10-40×).
func TestFinalizeTurn_ToolUsePauseSurfacesColdIngest(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	c.activeSession = &activeSession{sessionUUID: "uuid-pause"}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()

	turn := &turnResult{
		StopReason:       "tool_use",
		InputTokens:      1234,   // fresh input — must NOT surface (inflation trap)
		CacheReadTokens:  200000, // warm re-read — must NOT surface (inflation trap)
		CacheWriteTokens: 45000,  // cold ingest — MUST surface (billed once/turn)
		OutputTokens:     10,     // partial — counted at end_turn, not here
		Blocks: []provider.ContentBlock{{
			Type:      provider.ContentBlockTypeToolUse,
			ToolUseID: "t1",
			ToolName:  "bash",
			ToolInput: map[string]any{"command": "echo hi"},
		}},
	}

	res, err := c.finalizeTurn(provider.MessageRequest{
		ConversationID: "conv-pause",
		Messages:       []provider.Message{userMsg("do a thing")},
	}, turn, nil)
	if err != nil {
		t.Fatalf("finalizeTurn: %v", err)
	}

	if res.StopReason != "tool_use" {
		t.Fatalf("StopReason = %q, want tool_use", res.StopReason)
	}
	if res.CacheWriteTokens != 45000 || res.InputTokens != 45000 {
		t.Fatalf("pause must surface cache-creation as the ingest cost: InputTokens=%d CacheWriteTokens=%d, want 45000/45000",
			res.InputTokens, res.CacheWriteTokens)
	}
	if res.CachedTokens != 0 {
		t.Fatalf("pause must NOT report cache-read (double-count/inflation trap): CachedTokens=%d, want 0", res.CachedTokens)
	}
	if res.OutputTokens != 0 {
		t.Fatalf("pause must NOT report partial output: OutputTokens=%d, want 0", res.OutputTokens)
	}
}

// TestFinalizeTurn_WarmToolUsePauseStaysQuiet is the complement: a fully warm
// pause (everything cache-read, nothing newly ingested) writes ~nothing, so it
// reports zero and does not spam the log with a phantom cost.
func TestFinalizeTurn_WarmToolUsePauseStaysQuiet(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	c.activeSession = &activeSession{sessionUUID: "uuid-warmpause"}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()

	turn := &turnResult{
		StopReason:       "tool_use",
		InputTokens:      50,
		CacheReadTokens:  200000, // all warm read
		CacheWriteTokens: 0,      // nothing newly cached
		OutputTokens:     8,
		Blocks: []provider.ContentBlock{{
			Type:      provider.ContentBlockTypeToolUse,
			ToolUseID: "t1",
			ToolName:  "bash",
			ToolInput: map[string]any{"command": "ls"},
		}},
	}

	res, err := c.finalizeTurn(provider.MessageRequest{
		ConversationID: "conv-warmpause",
		Messages:       []provider.Message{userMsg("do a thing")},
	}, turn, nil)
	if err != nil {
		t.Fatalf("finalizeTurn: %v", err)
	}
	if res.InputTokens != 0 || res.CacheWriteTokens != 0 || res.CachedTokens != 0 {
		t.Fatalf("warm pause must stay quiet: input=%d cacheWrite=%d cached=%d, want all 0",
			res.InputTokens, res.CacheWriteTokens, res.CachedTokens)
	}
}
