//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/base64"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestToolResultCarriesImageBlock: a tool-result with image parts emits an
// image content block in the same user turn, right after its tool_result block.
func TestToolResultCarriesImageBlock(t *testing.T) {
	data := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a}
	msgs := []provider.Message{
		{Type: "assistant", Content: "let me look"},
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{"file_path": "a.png"}},
		{Type: "tool-result", ToolUseID: "t1", Content: "Read image a.png", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}

	out := TransformToAPIMessages(msgs)

	wantB64 := base64.StdEncoding.EncodeToString(data)
	found := false
	for _, m := range out {
		hasToolResult, hasImage := false, false
		for _, b := range m.Content {
			if b.Type == "tool_result" && b.ToolUseID == "t1" {
				hasToolResult = true
			}
			if b.Type == "image" && b.Source != nil && b.Source.MediaType == "image/png" && b.Source.Data == wantB64 {
				hasImage = true
			}
		}
		if hasToolResult && hasImage {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a user message carrying tool_result + matching image block; got %+v", out)
	}
}

// TestToolResultWithoutImageHasNoImageBlock: a text-only tool result emits no
// image blocks (behaviour unchanged for non-image tools).
func TestToolResultWithoutImageHasNoImageBlock(t *testing.T) {
	msgs := []provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "plain text"},
	}
	for _, m := range TransformToAPIMessages(msgs) {
		for _, b := range m.Content {
			if b.Type == "image" {
				t.Fatalf("unexpected image block for a text-only tool result")
			}
		}
	}
}
