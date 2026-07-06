//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestConvertBlockToSDKToolUseArgOrder pins the Anthropic SDK argument order for
// NewToolUseBlock(id, input, name). A regression passed (id, name, input), so the
// tool *input* JSON was placed in the `name` field and the short tool name in the
// `input` field. Any tool call whose input serialized past 200 characters was then
// rejected by the API with
// "messages.N.content.M.tool_use.name: String should have at most 200 characters",
// permanently wedging the conversation every time the history was replayed.
func TestConvertBlockToSDKToolUseArgOrder(t *testing.T) {
	longCmd := strings.Repeat("x", 500)
	block := APIContentBlock{
		Type:  "tool_use",
		ID:    "t1",
		Name:  "bash",
		Input: map[string]any{"command": longCmd},
	}

	sdk := convertBlockToSDK(block)
	if sdk == nil {
		t.Fatal("convertBlockToSDK returned nil for tool_use block")
	}
	data, err := json.Marshal(sdk)
	if err != nil {
		t.Fatalf("marshal SDK block: %v", err)
	}

	var m struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal SDK block: %v\n%s", err, data)
	}

	if m.Name != "bash" {
		t.Errorf("tool_use name = %d-char string, want %q (input JSON leaked into the name field)", len(m.Name), "bash")
	}
	if len(m.Name) > 200 {
		t.Errorf("tool_use name is %d chars (>200); the Anthropic API rejects this", len(m.Name))
	}
	if !strings.HasPrefix(strings.TrimSpace(string(m.Input)), "{") {
		t.Errorf("tool_use input is not a JSON object; got %s", string(m.Input))
	}
	if !strings.Contains(string(m.Input), longCmd) {
		t.Errorf("tool_use input.command not preserved in the input field")
	}
}

// TestConvertBlockToSDKToolUseEmptyInput guards the no-arg tool call: the SDK's
// Input field is `omitzero`+required, so a nil input map would be dropped and the
// API would reject with "tool_use.input: Field required". An empty (non-nil) map
// must survive as `{}`.
func TestConvertBlockToSDKToolUseEmptyInput(t *testing.T) {
	block := APIContentBlock{Type: "tool_use", ID: "t2", Name: "now", Input: nil}

	sdk := convertBlockToSDK(block)
	if sdk == nil {
		t.Fatal("convertBlockToSDK returned nil for no-arg tool_use block")
	}
	data, err := json.Marshal(sdk)
	if err != nil {
		t.Fatalf("marshal SDK block: %v", err)
	}
	if !strings.Contains(string(data), `"input":{}`) {
		t.Errorf("no-arg tool_use must emit input:{}; got %s", string(data))
	}
	if !strings.Contains(string(data), `"name":"now"`) {
		t.Errorf("no-arg tool_use name lost; got %s", string(data))
	}
}
