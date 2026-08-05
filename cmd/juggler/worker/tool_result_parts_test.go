//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestBuildToolResultMapEmitsImageParts: a tool-action item carrying image
// attachments projects an image "parts" array on its tool-result wire message
// (same shape as a user message), so the server can resolve the bytes and the
// providers can emit the image alongside the tool_result.
func TestBuildToolResultMapEmitsImageParts(t *testing.T) {
	item := ConversationItem{
		ToolUseID:   "tool_1",
		Result:      json.RawMessage(`{"content":"Read image foo.png","isError":false}`),
		Attachments: []AssetRef{{ID: "abc123", Mime: "image/png", Width: 4, Height: 2, Bytes: 10}},
	}

	m := buildToolResultMap(item)
	if m == nil {
		t.Fatal("buildToolResultMap returned nil")
	}
	if m["content"] != "Read image foo.png" {
		t.Errorf("unexpected content: %v", m["content"])
	}
	parts, ok := m["parts"].([]map[string]any)
	if !ok || len(parts) != 1 {
		t.Fatalf("expected exactly one image part, got %#v", m["parts"])
	}
	p := parts[0]
	if p["type"] != "image" || p["assetId"] != "abc123" || p["mime"] != "image/png" {
		t.Errorf("unexpected image part: %#v", p)
	}
	if p["width"] != 4 || p["height"] != 2 {
		t.Errorf("expected 4x2 dims, got %v x %v", p["width"], p["height"])
	}
}

// TestBuildToolResultMapNoPartsWithoutAttachments: a text-only tool result
// carries no parts (wire message stays byte-identical to the pre-image form).
func TestBuildToolResultMapNoPartsWithoutAttachments(t *testing.T) {
	item := ConversationItem{
		ToolUseID: "tool_2",
		Result:    json.RawMessage(`{"content":"ok","isError":false}`),
	}
	m := buildToolResultMap(item)
	if m == nil {
		t.Fatal("buildToolResultMap returned nil")
	}
	if _, has := m["parts"]; has {
		t.Errorf("no attachments must mean no parts, got %#v", m["parts"])
	}
}
