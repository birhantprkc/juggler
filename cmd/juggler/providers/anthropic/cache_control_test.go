//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"
)

// sampleTools is a stable two-tool set used across the cache tests.
func sampleTools() []provider.ToolDefinition {
	return []provider.ToolDefinition{
		{Name: "read_file", Description: "Read a file", InputSchema: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`)},
		{Name: "grep", Description: "Search", InputSchema: json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string"}}}`)},
	}
}

// cachePrefixJSON serializes the cacheable prompt prefix (tools + system, in
// Anthropic's cache order) so two turns' prefixes can be compared byte-for-byte.
// Identical prefix ⇒ the prompt cache would hit; divergent ⇒ cold start.
func cachePrefixJSON(t *testing.T, p anthropicsdk.MessageNewParams) string {
	t.Helper()
	prefix := struct {
		Tools  any `json:"tools"`
		System any `json:"system"`
	}{Tools: p.Tools, System: p.System}
	data, err := json.Marshal(prefix)
	if err != nil {
		t.Fatalf("marshal cache prefix: %v", err)
	}
	return string(data)
}

// TestSystemBlockCarriesCacheControl: the system prompt is a single cached
// block. This prefix is stable across a strategy change, so the breakpoint hits
// rather than cold-starting each phase.
func TestSystemBlockCarriesCacheControl(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "IDENTITY\n\n<env>\n</env>\n\nEXTENSION GUIDANCE",
		Tools:        sampleTools(),
		Messages:     []provider.Message{{Type: "user", Content: "hello"}},
	})

	if len(params.System) != 1 {
		t.Fatalf("expected 1 system block, got %d", len(params.System))
	}
	if got := string(params.System[0].CacheControl.Type); got != "ephemeral" {
		t.Errorf("system block missing ephemeral cache_control; got %q", got)
	}
}

// TestRollingCacheBreakpointOnLastMessageOnly: the rolling history breakpoint
// sits on the final block of the final message and nowhere else, so each turn
// writes an incrementally longer prefix that the next turn reads.
func TestRollingCacheBreakpointOnLastMessageOnly(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: "SYS",
		Messages: []provider.Message{
			{Type: "user", Content: "first"},
			{Type: "assistant", Content: "reply"},
			{Type: "user", Content: "second"},
		},
	})

	n := len(params.Messages)
	if n == 0 {
		t.Fatal("expected messages")
	}

	// Last message's last block carries the breakpoint.
	lastMsg := params.Messages[n-1]
	if len(lastMsg.Content) == 0 {
		t.Fatal("last message has no content blocks")
	}
	lastCC := lastMsg.Content[len(lastMsg.Content)-1].GetCacheControl()
	if lastCC == nil || string(lastCC.Type) != "ephemeral" {
		t.Errorf("last message's final block must carry an ephemeral breakpoint; got %+v", lastCC)
	}

	// Every earlier message carries NO breakpoint (only the tail rolls).
	for i := 0; i < n-1; i++ {
		for j, blk := range params.Messages[i].Content {
			if cc := blk.GetCacheControl(); cc != nil && string(cc.Type) == "ephemeral" {
				t.Errorf("message[%d].block[%d] unexpectedly carries a cache breakpoint", i, j)
			}
		}
	}
}

// TestNoBreakpointWhenNoSystemPrompt: an empty system prompt yields no system
// block (and so no system breakpoint); the rolling message breakpoint still
// applies.
func TestNoBreakpointWhenNoSystemPrompt(t *testing.T) {
	c := &Client{model: "claude-test"}
	params := c.buildMessageParams(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	})
	if len(params.System) != 0 {
		t.Errorf("expected no system block for empty system prompt, got %d", len(params.System))
	}
	last := params.Messages[len(params.Messages)-1]
	if cc := last.Content[len(last.Content)-1].GetCacheControl(); cc == nil || string(cc.Type) != "ephemeral" {
		t.Errorf("rolling breakpoint should still apply with no system prompt")
	}
}

// TestCachePrefixStableAcrossStrategyChange pins the two designs it contrasts.
//
// Current design: strategies contribute NOTHING to the system prompt (they
// inject messages instead), so when the active strategy changes mid-conversation
// the cacheable prefix (tools + system) is byte-identical turn-to-turn. The
// prompt cache therefore hits — exactly the property the breakpoints exploit.
//
// Contrast (the embed-strategy-text-in-system design): the system prompt carries
// phase-dependent strategy text, so a strategy/phase change mutates the cached
// prefix and cold-starts the 30k+ token anchor every transition. The contrast
// case pins that this design WOULD diverge, documenting why message-injection is
// what makes caching effective.
func TestCachePrefixStableAcrossStrategyChange(t *testing.T) {
	c := &Client{model: "claude-test"}
	const base = "IDENTITY\n\n<env>\n</env>\n\nPROJECT RULES\n\nEXTENSION GUIDANCE"
	tools := sampleTools()

	// Current: system is `base` regardless of strategy; only messages grow.
	turn1 := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base, Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	turn2 := c.buildMessageParams(provider.MessageRequest{ // strategy switched here
		SystemPrompt: base, Tools: tools,
		Messages: []provider.Message{
			{Type: "user", Content: "u1"},
			{Type: "assistant", Content: "a1"},
			{Type: "user", Content: "u2"},
		},
	})
	if cachePrefixJSON(t, turn1) != cachePrefixJSON(t, turn2) {
		t.Errorf("cacheable prefix diverged across a strategy change — the prompt cache would cold-start.\nturn1=%s\nturn2=%s",
			cachePrefixJSON(t, turn1), cachePrefixJSON(t, turn2))
	}

	// Contrast: had strategy phase text lived in the system prompt, the two
	// turns' prefixes would differ and bust the cache. Pin that contrast.
	oldPlan := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base + "\n\nYou are in Plan mode. Explore read-only.", Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	oldExec := c.buildMessageParams(provider.MessageRequest{
		SystemPrompt: base + "\n\nYou are in Plan Execution mode. Each step runs in a sub-thread.", Tools: tools,
		Messages: []provider.Message{{Type: "user", Content: "u1"}},
	})
	if cachePrefixJSON(t, oldPlan) == cachePrefixJSON(t, oldExec) {
		t.Errorf("expected the old embed-strategy-in-system design to diverge across a phase change (benchmark contrast invalid)")
	}
}
