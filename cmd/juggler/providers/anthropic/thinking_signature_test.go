//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// findThinkingBlock returns the first thinking content block across all
// transformed messages, or nil if none was emitted.
func findThinkingBlock(msgs []APIMessage) *APIContentBlock {
	for mi := range msgs {
		for bi := range msgs[mi].Content {
			if msgs[mi].Content[bi].Type == "thinking" {
				return &msgs[mi].Content[bi]
			}
		}
	}
	return nil
}

// TestTransformDropsSignaturelessThinking is the guard for the cross-provider
// thinking regression. Now that buildMessages emits thinking messages (so
// DeepSeek can echo its reasoning), a signatureless thinking block can reach the
// Anthropic transform — either because the worker doesn't persist thinking
// signatures, or because a conversation switched from a non-Anthropic provider
// mid-stream. Anthropic rejects a signatureless thinking block with a 400, so
// the transform must drop it rather than emit it.
func TestTransformDropsSignaturelessThinking(t *testing.T) {
	msgs := TransformToAPIMessages([]provider.Message{
		{Type: "user", Content: "What's the weather?"},
		{Type: "thinking", Content: "reasoning with no anthropic signature"},
		{Type: "assistant", Content: "It's sunny."},
	})

	if b := findThinkingBlock(msgs); b != nil {
		t.Fatalf("signatureless thinking block must be dropped (Anthropic 400s on it); got %+v", *b)
	}
	// The surrounding turn must still transform normally.
	if len(msgs) == 0 {
		t.Fatal("expected user + assistant messages to survive")
	}
}

// TestTransformKeepsSignedThinking is the complementary guard: a genuine signed
// Claude thinking block still round-trips, with its signature reconstructed from
// providerData.
func TestTransformKeepsSignedThinking(t *testing.T) {
	msgs := TransformToAPIMessages([]provider.Message{
		{Type: "user", Content: "hi"},
		{
			Type:         "thinking",
			Content:      "signed reasoning",
			ProviderData: map[string]any{"signature": "sig-abc"},
		},
		{Type: "assistant", Content: "hello"},
	})

	b := findThinkingBlock(msgs)
	if b == nil {
		t.Fatal("signed thinking block must be preserved for round-tripping")
	}
	if b.Thinking != "signed reasoning" {
		t.Errorf("thinking text = %q, want %q", b.Thinking, "signed reasoning")
	}
	if b.Signature != "sig-abc" {
		t.Errorf("signature = %q, want %q", b.Signature, "sig-abc")
	}
}
