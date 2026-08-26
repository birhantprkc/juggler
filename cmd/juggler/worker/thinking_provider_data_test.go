//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// A thinking block's provider data — an Anthropic signature, an OpenAI
// reasoning item's id and encrypted content — is only known once the block
// ends, so providers emit it on a trailing contentless thinking chunk. These
// tests cover the write half of that round trip: the read half (buildMessages
// putting providerData on the wire) is covered in thinking_replay_test.go.

// TestStreamedThinkingKeepsProviderData is the guard for the gap that made
// Anthropic's thinking round-trip dead code: the streamed item was created from
// content deltas and the trailing signature chunk was discarded, so every
// thinking block reached the next turn unsigned and was dropped rather than
// replayed.
func TestStreamedThinkingKeepsProviderData(t *testing.T) {
	w := NewConversationWorker("conv-thinking-metadata", "user:test")
	defer w.doc.Destroy()

	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Content: "Weighing "})
	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Content: "the options."})
	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Metadata: map[string]any{"signature": "sig-abc"}})

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("got %d items, want a single thinking item: %+v", len(items), items)
	}
	if items[0].Content != "Weighing the options." {
		t.Fatalf("content = %q, want the deltas accumulated", items[0].Content)
	}
	if got, _ := items[0].ProviderData["signature"].(string); got != "sig-abc" {
		t.Fatalf("providerData signature = %q, want sig-abc — the trailing metadata chunk was dropped", got)
	}
}

// TestStreamedThinkingProviderDataReachesTheWire closes the loop: metadata
// captured mid-stream must survive into the request the next turn builds, or
// persisting it bought nothing.
func TestStreamedThinkingProviderDataReachesTheWire(t *testing.T) {
	w := NewConversationWorker("conv-thinking-metadata-wire", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})
	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Content: "Reasoning."})
	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Metadata: map[string]any{
		"reasoningItemId":  "rs_1",
		"encryptedContent": "gAAAAA",
	}})

	var found map[string]any
	for _, m := range w.currentRun().buildMessages(nil) {
		if m["type"] == "thinking" {
			found, _ = m["providerData"].(map[string]any)
		}
	}
	if found == nil {
		t.Fatalf("thinking message reached the wire without providerData; messages=%+v", w.currentRun().buildMessages(nil))
	}
	if got, _ := found["reasoningItemId"].(string); got != "rs_1" {
		t.Fatalf("reasoningItemId = %q, want rs_1", got)
	}
	if got, _ := found["encryptedContent"].(string); got != "gAAAAA" {
		t.Fatalf("encryptedContent = %q, want gAAAAA", got)
	}
}

// TestOrphanThinkingMetadataCreatesNoItem covers a reasoning turn that produced
// no summary text: the provider still reports the block's id and encrypted
// content, but with no thinking on screen there is nothing to attach it to. An
// item created for it would be a blank tile in the transcript, and contentless
// thinking is dropped from the wire anyway — so it must be ignored, not stored.
func TestOrphanThinkingMetadataCreatesNoItem(t *testing.T) {
	w := NewConversationWorker("conv-thinking-orphan", "user:test")
	defer w.doc.Destroy()

	w.currentRun().processStreamChunk(StreamChunk{Type: "thinking", Metadata: map[string]any{"signature": "sig-orphan"}})

	if items := w.doc.GetItems(); len(items) != 0 {
		t.Fatalf("got %d items, want none — a contentless thinking item is a blank tile: %+v", len(items), items)
	}
}

// TestAutonomousTurnThinkingKeepsProviderData covers the non-streamed path
// (handleProviderTurn), where the whole turn arrives as finished blocks rather
// than chunks. It has the same obligation to keep the block's provider data.
func TestAutonomousTurnThinkingKeepsProviderData(t *testing.T) {
	w := NewConversationWorker("conv-thinking-autonomous", "user:test")
	defer w.doc.Destroy()

	payload := mustJSON(t, ProviderTurnMessage{
		Blocks: []LLMResponseBlock{{
			Type:     "thinking",
			Content:  "Reasoning offline.",
			Metadata: map[string]any{"signature": "sig-auto"},
		}},
	})
	w.currentRun().handleProviderTurn(json.RawMessage(payload))

	items := w.doc.GetItems()
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1 thinking item: %+v", len(items), items)
	}
	if got, _ := items[0].ProviderData["signature"].(string); got != "sig-auto" {
		t.Fatalf("providerData signature = %q, want sig-auto", got)
	}
}
