//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestBuildToolUseMap_NormalisesSupersededToolNames guards the claudecode
// resume path. A conversation persists the tool name its action ran under, so a
// reloaded conversation replays names the current tools array no longer offers.
// claudecode's prefixJugglerToolUses only re-prefixes historical tool_use names
// it finds in that array; anything else goes bare into the synthetic session
// file, the model copies the bare name, and the CLI rejects it as unavailable —
// re-running a tool whose side effects already landed.
//
// The document is never rewritten; only the wire carries the current name.
func TestBuildToolUseMap_NormalisesSupersededToolNames(t *testing.T) {
	item := ConversationItem{
		Type:      ItemTypeToolAction,
		ToolUseID: "call_1",
		ToolName:  "explore_code",
		ToolInput: json.RawMessage(`{"code":"return 1"}`),
	}

	got := buildToolUseMap(item)
	if got["toolName"] != "query_code" {
		t.Fatalf("a superseded recorded name must reach the wire as the currently-advertised name, got %v", got["toolName"])
	}
	if item.ToolName != "explore_code" {
		t.Fatalf("the item must not be mutated: history records what actually ran, got %q", item.ToolName)
	}
}

// TestWireToolName_PassesThroughUnknownNames pins that the mapping is additive:
// a name with no entry — every current tool, and every MCP tool — is untouched.
func TestWireToolName_PassesThroughUnknownNames(t *testing.T) {
	for _, name := range []string{"query_code", "bash", "read", "mcp__acme__deploy", ""} {
		if got := wireToolName(name); got != name {
			t.Fatalf("wireToolName(%q) must pass through unchanged, got %q", name, got)
		}
	}
}
