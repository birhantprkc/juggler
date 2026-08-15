//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestAppendThreadMessages_StableWireShapeAcrossCompletion is the guard for the
// claudecode cache-miss regression: a delegated-tool thread (e.g. query_code)
// must render the SAME wire shape — a tool_use + tool_result pair — whether its
// sub-thread result has landed yet or not.
//
// The old projection emitted ONLY the tool_use while pending and appended the
// tool_result later, so the message COUNT jumped 1→2 the moment the result
// arrived. That extra block slid every subsequent message down one slot, and a
// stateful provider (claudecode --resume) sees the committed prefix change and
// cold-starts the whole conversation — a full prompt-cache miss on every turn a
// thread completes. Stable count → the prefix stays byte-identical, cache warm.
func TestAppendThreadMessages_StableWireShapeAcrossCompletion(t *testing.T) {
	base := ConversationItem{
		Type:      ItemTypeThread,
		ItemID:    "thread_1",
		ToolUseID: "call_1",
		ToolName:  "query_code",
		ToolInput: json.RawMessage(`{"goal":"map the auth flow"}`),
		Goal:      "map the auth flow",
	}
	pending := base // Result unset → sub-thread still running
	completed := base
	completed.Result = json.RawMessage(`"the auth flow lives in auth.go"`)

	gotPending := appendThreadMessages(nil, pending)
	gotComplete := appendThreadMessages(nil, completed)

	if len(gotPending) != len(gotComplete) {
		t.Fatalf("thread wire shape must be stable across completion, but pending=%d and complete=%d messages — the count change shifts the prefix and busts the prompt cache",
			len(gotPending), len(gotComplete))
	}
	if len(gotPending) != 2 {
		t.Fatalf("a tool-bearing thread must render tool_use+tool_result (2 messages), got %d", len(gotPending))
	}
	if gotPending[0]["type"] != "tool-use" || gotPending[1]["type"] != "tool-result" {
		t.Fatalf("pending thread must render tool_use then tool_result, got %v + %v",
			gotPending[0]["type"], gotPending[1]["type"])
	}
	// No dangling tool_use: the pending tool_result must close the same call.
	if gotPending[1]["toolUseId"] != "call_1" {
		t.Fatalf("pending tool_result must reference toolUseId call_1, got %v", gotPending[1]["toolUseId"])
	}
	if gotComplete[0]["toolUseId"] != "call_1" || gotComplete[1]["toolUseId"] != "call_1" {
		t.Fatalf("completed pair must both reference call_1, got %v / %v",
			gotComplete[0]["toolUseId"], gotComplete[1]["toolUseId"])
	}

	// The tool_use block itself must be byte-identical across the transition (only
	// the tool_result content may flip pending→real), so the tool_use never
	// contributes a divergence of its own.
	if gotPending[0]["toolName"] != gotComplete[0]["toolName"] {
		t.Fatalf("tool_use block must be stable across completion")
	}
}
