//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestActivitySnapshotLivesOnlyInProcessingState(t *testing.T) {
	w := NewConversationWorker("conv-activity", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("processingState", map[string]any{"status": "streaming"})

	w.currentRun().processStreamChunk(StreamChunk{
		Type:    provider.ContentBlockTypeActivity,
		Content: "Complete snapshot",
		Metadata: map[string]any{
			"summaryIndex": int64(1),
		},
	})

	if items := w.doc.GetItems(); len(items) != 0 {
		t.Fatalf("activity created %d conversation items: %+v", len(items), items)
	}
	state := w.readProcessingState()
	if got, _ := state["description"].(string); got != "Complete snapshot" {
		t.Fatalf("processingState.description = %q, want complete snapshot", got)
	}

	w.currentRun().processStreamChunk(StreamChunk{
		Type:     provider.ContentBlockTypeProviderState,
		Metadata: map[string]any{"reasoningItemId": "rs_1"},
	})
	if got, _ := w.readProcessingState()["description"].(string); got != "Complete snapshot" {
		t.Fatalf("provider state replaced description with %q", got)
	}

	w.currentRun().processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeText, Content: "answer"})
	if got, _ := w.readProcessingState()["description"].(string); got != "Complete snapshot" {
		t.Fatalf("answer text replaced description with %q", got)
	}

	w.currentRun().processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeToolUse})
	if _, ok := w.readProcessingState()["description"]; ok {
		t.Fatal("processingState.description survived tool transition")
	}
}

func TestProviderStatePersistsAndReplaysInOrder(t *testing.T) {
	w := NewConversationWorker("conv-provider-state", "user:test")
	defer w.doc.Destroy()
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})

	w.currentRun().processStreamChunk(StreamChunk{
		Type: provider.ContentBlockTypeProviderState,
		Metadata: map[string]any{
			"reasoningItemId":  "rs_1",
			"encryptedContent": "blob",
		},
	})
	w.currentRun().processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeText, Content: "answer"})

	items := w.doc.GetItems()
	if len(items) != 3 || items[1].Type != ItemTypeProviderState || items[2].Type != ItemTypeAssistant {
		t.Fatalf("ordered items = %+v, want user, provider-state, assistant", items)
	}
	messages := w.currentRun().buildMessages(nil)
	if len(messages) != 3 || messages[1]["type"] != "provider-state" || messages[2]["type"] != "assistant" {
		t.Fatalf("ordered wire messages = %+v", messages)
	}
	data, _ := messages[1]["providerData"].(map[string]any)
	if got, _ := data["reasoningItemId"].(string); got != "rs_1" {
		t.Fatalf("provider-state reasoningItemId = %q, want rs_1", got)
	}
}
