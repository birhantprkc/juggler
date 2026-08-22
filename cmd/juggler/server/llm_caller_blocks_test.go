//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestAppendStreamedBlockKeepsTrailingMetadata is the guard for the join that
// carries a block's provider data. Providers learn a thinking block's signature
// (Anthropic, claudecode) or its reasoning item id and encrypted content
// (OpenAI Responses) only at the block's end, so they emit it on a trailing
// contentless thinking chunk. That chunk coalesces into the block above it, and
// a merge that copied only Content would silently drop the sole copy — leaving
// the item unable to be replayed on the next turn.
func TestAppendStreamedBlockKeepsTrailingMetadata(t *testing.T) {
	var blocks []provider.ContentBlock
	for _, chunk := range []provider.StreamChunk{
		{Type: provider.ContentBlockTypeThinking, Content: "Weighing "},
		{Type: provider.ContentBlockTypeThinking, Content: "the options."},
		{Type: provider.ContentBlockTypeThinking, Metadata: map[string]any{"signature": "sig-abc"}},
	} {
		blocks = appendStreamedBlock(blocks, chunk)
	}

	if len(blocks) != 1 {
		t.Fatalf("got %d blocks, want the deltas coalesced into 1: %+v", len(blocks), blocks)
	}
	if got := blocks[0].Content; got != "Weighing the options." {
		t.Fatalf("content = %q, want the deltas joined", got)
	}
	if got, _ := blocks[0].Metadata["signature"].(string); got != "sig-abc" {
		t.Fatalf("signature = %q, want sig-abc — the trailing metadata chunk was dropped by the merge", got)
	}
}

// TestAppendStreamedBlockMergesOntoExistingMetadata covers a block whose
// metadata arrives in more than one piece: later keys must add to the block
// rather than replace the map wholesale.
func TestAppendStreamedBlockMergesOntoExistingMetadata(t *testing.T) {
	blocks := []provider.ContentBlock{{
		Type:     provider.ContentBlockTypeThinking,
		Content:  "Reasoning.",
		Metadata: map[string]any{"reasoningItemId": "rs_1"},
	}}
	blocks = appendStreamedBlock(blocks, provider.StreamChunk{
		Type:     provider.ContentBlockTypeThinking,
		Metadata: map[string]any{"encryptedContent": "gAAAAA"},
	})

	if len(blocks) != 1 {
		t.Fatalf("got %d blocks, want 1", len(blocks))
	}
	if got, _ := blocks[0].Metadata["reasoningItemId"].(string); got != "rs_1" {
		t.Fatalf("reasoningItemId = %q, want rs_1 — existing metadata was replaced", got)
	}
	if got, _ := blocks[0].Metadata["encryptedContent"].(string); got != "gAAAAA" {
		t.Fatalf("encryptedContent = %q, want gAAAAA", got)
	}
}

// TestAppendStreamedBlockStartsFreshBlockForDiscreteChunks pins that only
// text/thinking deltas coalesce: a tool_use chunk between two thinking chunks
// must not absorb them, or the transaction JSON would misreport the turn.
func TestAppendStreamedBlockStartsFreshBlockForDiscreteChunks(t *testing.T) {
	var blocks []provider.ContentBlock
	for _, chunk := range []provider.StreamChunk{
		{Type: provider.ContentBlockTypeThinking, Content: "Think."},
		{Type: provider.ContentBlockTypeToolUse, ToolName: "bash"},
		{Type: provider.ContentBlockTypeThinking, Content: "Think again."},
	} {
		blocks = appendStreamedBlock(blocks, chunk)
	}

	if len(blocks) != 3 {
		t.Fatalf("got %d blocks, want 3 distinct blocks: %+v", len(blocks), blocks)
	}
	if blocks[2].Content != "Think again." {
		t.Fatalf("third block = %q, want the post-tool thinking kept separate", blocks[2].Content)
	}
}
