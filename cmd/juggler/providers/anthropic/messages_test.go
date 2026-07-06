//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAPIContentBlockMarshalJSONToolUseInput guards against an Anthropic
// API regression: every tool_use block must serialize with an `input`
// field, even when the model called a no-arg tool. With plain
// `omitempty` Go's encoder strips both nil and empty maps, and the API
// then rejects with "messages.N.content.M.tool_use.input: Field required"
// — which the claudecode CLI buries in an assistant envelope, surfacing
// to juggler as a silent zero-token end_turn.
func TestAPIContentBlockMarshalJSONToolUseInput(t *testing.T) {
	cases := []struct {
		name  string
		block APIContentBlock
	}{
		{"nil input", APIContentBlock{Type: "tool_use", ID: "t1", Name: "TaskList", Input: nil}},
		{"empty input", APIContentBlock{Type: "tool_use", ID: "t2", Name: "Foo", Input: map[string]any{}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := json.Marshal(tc.block)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if !strings.Contains(string(data), `"input":{}`) {
				t.Errorf("tool_use missing required input field; got %s", string(data))
			}
		})
	}
}

// TestAPIContentBlockMarshalJSONNonToolUsePreservesShape ensures the
// `input` override is gated to tool_use blocks — text / tool_result /
// thinking blocks should never grow a spurious input field.
func TestAPIContentBlockMarshalJSONNonToolUsePreservesShape(t *testing.T) {
	cases := []APIContentBlock{
		{Type: "text", Text: "hello"},
		{Type: "tool_result", ToolUseID: "t1", Content: "ok"},
		{Type: "thinking", Thinking: "...", Signature: "abc"},
	}
	for _, b := range cases {
		t.Run(b.Type, func(t *testing.T) {
			data, err := json.Marshal(b)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if strings.Contains(string(data), `"input"`) {
				t.Errorf("%s block should not carry input field; got %s", b.Type, string(data))
			}
		})
	}
}

// TestAPIContentBlockMarshalJSONPreservesNonEmptyInput is the
// regression guard that the override doesn't clobber real tool inputs.
func TestAPIContentBlockMarshalJSONPreservesNonEmptyInput(t *testing.T) {
	block := APIContentBlock{
		Type:  "tool_use",
		ID:    "t1",
		Name:  "Bash",
		Input: map[string]any{"command": "ls", "timeout": 10},
	}
	data, err := json.Marshal(block)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"command":"ls"`) {
		t.Errorf("real input lost; got %s", string(data))
	}
}
