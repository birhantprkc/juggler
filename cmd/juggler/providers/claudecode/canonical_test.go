//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Tests for canonicalToolName, the single helper both the live-stream parser
// and the SDK tools/call control path call to turn a CLI-emitted tool name
// into the Juggler tool key. Adding the prefix/alias logic in one place lets
// every entry point share the same rules without duplicating string surgery.

package claudecode

import (
	"strings"
	"testing"
)

func TestCanonicalToolName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"strips juggler prefix from registered tool", "mcp__juggler__batch_grep", "batch_grep"},
		{"strips juggler prefix from bash", "mcp__juggler__bash", "bash"},
		{"strips juggler prefix from read_file", "mcp__juggler__read_file", "read_file"},
		{"already-canonical name is unchanged", "batch_grep", "batch_grep"},
		{"unknown unprefixed name passes through", "some_unknown_tool", "some_unknown_tool"},
		{"bare server name without subtool is left alone", "mcp__juggler", "mcp__juggler"},
		{"doubly-prefixed name strips both", "mcp__juggler__mcp__juggler__bash", "bash"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := canonicalToolName(tc.in); got != tc.want {
				t.Errorf("canonicalToolName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestParser_ToolUsePrefixStripped_BatchGrep: a tool_use stream for
// `batch_grep` must reach the frontend with the prefix removed, so the
// registry lookup in response-handler.js doesn't fall into the unknown-tool
// branch.
func TestParser_ToolUsePrefixStripped_BatchGrep(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "mcp__juggler__batch_grep"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"searches":[{"pattern":"foo"}]}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}},
		}),
	}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(res.Blocks))
	}
	if res.Blocks[0].ToolName != "batch_grep" {
		t.Errorf("ToolName=%q, want batch_grep", res.Blocks[0].ToolName)
	}
}

// TestParser_BareNativeToolName_FailsTurn: a tool_use whose name arrived
// WITHOUT the mcp__juggler__ prefix belongs to the CLI, which answers it
// itself and never sends a tools/call. Monitor is the case that hung a
// conversation in the wild: it is both a CLI built-in and a juggler tool, so
// stripping an absent prefix made the parser dispatch it as juggler's own,
// and the result it produced stashed forever waiting for a park that could
// never come while the CLI blocked on its next real call. The turn must fail
// loudly instead, naming the tool so the stale deny list is obvious.
func TestParser_BareNativeToolName_FailsTurn(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "Monitor"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"command":"tail -f log"}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
	}
	_, _, _, _, err := feedLines(t, c, lines)
	if err == nil {
		t.Fatal("a bare CLI-native tool_use must fail the turn, not dispatch as juggler's own")
	}
	if !strings.Contains(err.Error(), "Monitor") {
		t.Errorf("error must name the offending tool, got: %v", err)
	}
	// A hard failure, not a retryable one: retrying re-runs the same stale
	// deny list and hits the same block.
	if isTransientCLIError(err) {
		t.Errorf("want a hard failure, got a transient error: %v", err)
	}
}

// TestParser_LegacyNativeConversion_StillDispatches: the guard above must not
// break claudeToJugglerTools, the deliberate conversion of Claude's own
// file/shell built-ins to juggler equivalents.
func TestParser_LegacyNativeConversion_StillDispatches(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "Read"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"file_path":"/tmp/x"}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}},
		}),
	}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Blocks) != 1 || res.Blocks[0].ToolName != "read_file" {
		t.Fatalf("want one read_file block, got %+v", res.Blocks)
	}
}
