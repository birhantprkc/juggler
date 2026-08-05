//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"bytes"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// toolResultWithImage is a tool-result whose id has no matching tool-use, so it
// takes the functionResponse path (not the unsigned-narration path).
func toolResultWithImage(data []byte) []provider.Message {
	return []provider.Message{
		{Type: "tool-result", ToolUseID: "read_1", ToolName: "read", Content: `{"ok":true}`, Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}
}

// TestGeminiToolResultCarriesInlineImage: with a multimodal model the tool
// result's image rides as an inline-data part in the same user turn as the
// functionResponse.
func TestGeminiToolResultCarriesInlineImage(t *testing.T) {
	data := []byte{9, 8, 7, 6}
	contents, err := convertMessagesToGeminiContents(toolResultWithImage(data), true)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	var foundResp, foundImg bool
	for _, c := range contents {
		for _, p := range c.Parts {
			if p.FunctionResponse != nil {
				foundResp = true
			}
			if p.InlineData != nil && p.InlineData.MIMEType == "image/png" && bytes.Equal(p.InlineData.Data, data) {
				foundImg = true
			}
		}
	}
	if !foundResp || !foundImg {
		t.Fatalf("expected functionResponse and inline image; foundResp=%v foundImg=%v", foundResp, foundImg)
	}
}

// TestGeminiToolResultImageDroppedForTextOnlyModel: a text-only model
// (allowImages=false) drops the inline image, mirroring user-attachment gating.
func TestGeminiToolResultImageDroppedForTextOnlyModel(t *testing.T) {
	contents, err := convertMessagesToGeminiContents(toolResultWithImage([]byte{1, 2, 3}), false)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	for _, c := range contents {
		for _, p := range c.Parts {
			if p.InlineData != nil {
				t.Fatalf("text-only model must not carry inline image data")
			}
		}
	}
}
