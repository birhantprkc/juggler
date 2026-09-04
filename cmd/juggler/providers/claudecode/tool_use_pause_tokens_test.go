//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestFinalizeTurn_ToolUsePauseReportsWholePrompt pins the provider boundary at
// a mid-turn pause: a tool_use round-trip reports the SAME thing every other
// round-trip does — the whole prompt it sent (fresh + cache read + cache write),
// with the cache read and cache write as their subsets.
//
// Every consumer of these numbers describes one round-trip: the transaction blob
// the footer reads, the admission anchor, the [turn tokens] line. None sums
// InputTokens across the round-trips of a turn, so there is nothing here for a
// per-pause count to inflate — the cumulative blow-up that shaped this path is
// the result-envelope's session totals, and turnResult.usageFromStream is what
// holds that back. A pause that reports less than it sent makes the footer state
// a few thousand tokens for a prompt of a quarter million.
func TestFinalizeTurn_ToolUsePauseReportsWholePrompt(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	c.activeSession = &activeSession{sessionUUID: "uuid-pause"}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()

	turn := &turnResult{
		StopReason:       "tool_use",
		InputTokens:      1234,   // fresh
		CacheReadTokens:  200000, // warm re-read
		CacheWriteTokens: 45000,  // cold ingest
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
	if res.InputTokens != 246234 {
		t.Fatalf("InputTokens = %d, want 246234 (1234 fresh + 200000 read + 45000 write) — the prompt this call actually sent", res.InputTokens)
	}
	if provider.TokenCount(res.CachedTokens) != 200000 {
		t.Fatalf("CachedTokens = %v, want the 200000 this call read from cache", res.CachedTokens)
	}
	if provider.TokenCount(res.CacheWriteTokens) != 45000 {
		t.Fatalf("CacheWriteTokens = %d, want 45000 — the cold ingest must stay visible", provider.TokenCount(res.CacheWriteTokens))
	}
	if res.OutputTokens != 0 {
		t.Fatalf("pause must NOT report partial output: OutputTokens=%d, want 0", res.OutputTokens)
	}
}

// TestFinalizeTurn_WarmToolUsePauseReportsWarmPrompt is the complement: a fully
// warm pause ingested nothing new, and says so — cache write zero against a
// prompt that is almost entirely cache read. The prompt size is reported all the
// same, because "what is in the context" is true of a warm call too.
func TestFinalizeTurn_WarmToolUsePauseReportsWarmPrompt(t *testing.T) {
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
	if res.InputTokens != 200050 {
		t.Fatalf("InputTokens = %d, want 200050 — a warm prompt is still a prompt", res.InputTokens)
	}
	if provider.TokenCount(res.CachedTokens) != 200000 {
		t.Fatalf("CachedTokens = %v, want 200000 — a warm pause is where the hit ratio is worth reading", res.CachedTokens)
	}
	if provider.TokenCount(res.CacheWriteTokens) != 0 {
		t.Fatalf("CacheWriteTokens = %d, want 0 — nothing was ingested", provider.TokenCount(res.CacheWriteTokens))
	}
}
