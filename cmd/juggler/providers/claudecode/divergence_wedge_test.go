//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestContinueSession_DeliversAcrossArgDivergence is the regression for the
// recurring "stuck bash in Running forever" wedge. It reproduces the exact
// production shape seen in the logs: the CLI has a tools/call PARKED for one
// command (A), but the provider's pendingTools recorded DIVERGENT args (B) for
// that same tool_use_id — the byte-level drift a resume/restart/re-drive
// introduces. The old content-keyed router hashed the result under B, never
// matched the parked A, stashed it under a dead key, and the call hung on
// stdin forever (the CLI has no transport timeout). Positional routing must
// deliver the result to the parked call regardless of the arg drift.
func TestContinueSession_DeliversAcrossArgDivergence(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	convID := "conv-diverge"

	// Pre-buffer the terminal event the continuation reads once we've fed the
	// tool result (no real subprocess/reader needed — same pattern as
	// TestContinueSession_CapturesSystemPromptInPrefixHash).
	content := make(chan string, 4)
	content <- `{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}`

	// Observable control protocol with a tools/call PARKED for command A.
	buf := &bytes.Buffer{}
	cp := newControlProtocol(buf)
	argsA := json.RawMessage(`{"command":"echo A"}`)
	paramsA, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: argsA})
	jrpcA, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`5`), Method: "tools/call", Params: paramsA})
	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-A",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpcA},
	}); err != nil {
		t.Fatalf("park tools/call: %v", err)
	}

	// pendingTools recorded a DIFFERENT command (B) for the same id t1.
	argsB, _ := json.Marshal(map[string]any{"command": "echo B-totally-different"})
	c.activeSession = &activeSession{
		sessionUUID:  "uuid-diverge",
		pendingTools: []pendingToolMeta{{ID: "t1", Name: "bash", Args: argsB}},
		live: &liveCLI{
			content:  content,
			scanDone: make(chan struct{}),
			scanErr:  make(chan error, 1),
			control:  cp,
		},
	}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()
	sentinel := mustStartSentinel(t)
	c.activeSession.live.cmd = sentinel
	t.Cleanup(func() { _ = sentinel.Process.Kill(); _ = sentinel.Wait() })

	msgs := []provider.Message{
		userMsg("run it"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "A output"),
	}
	cb := func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       msgs,
	}, cb); err != nil {
		t.Fatalf("StreamMessage (continuation): %v", err)
	}

	// The parked call A MUST have been answered — otherwise the CLI hangs in
	// "Running" forever. This is the whole bug.
	if !strings.Contains(buf.String(), `"request_id":"req-A"`) {
		t.Fatalf("parked tools/call req-A was never answered despite a delivered result — the tool would hang in Running forever. stdin=%q", buf.String())
	}
	if !strings.Contains(buf.String(), "A output") {
		t.Errorf("the answered response did not carry the tool result content; stdin=%q", buf.String())
	}
}

// TestContinueSession_DropsDuplicateReFeed is the regression for the
// delivery-desync GENESIS: when the worker/engine re-emits a tool result it
// already fed this turn (a re-drive after an engine reattach — see
// resetRunningToolsForReattach), the provider must DROP the duplicate, not feed
// it again. A re-fed result has no parked call left to answer, so feeding it
// would silently become a stash orphan that a later same-tool call drains via
// the name fallback — the "results are stale" corruption. Without the
// fedResultIDs guard the duplicate matches the parked call by exact key and its
// content is delivered (test red); with it the duplicate is dropped (green).
func TestContinueSession_DropsDuplicateReFeed(t *testing.T) {
	c := newTestClient(t, "claude-sonnet-4-6")
	convID := "conv-refeed"

	content := make(chan string, 4)
	content <- `{"type":"result","subtype":"success","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}`

	buf := &bytes.Buffer{}
	cp := newControlProtocol(buf)
	args := json.RawMessage(`{"command":"echo hi"}`)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: args})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`5`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type:      "control_request",
		RequestID: "req-dup",
		Request:   &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park tools/call: %v", err)
	}

	// The session has ALREADY fed t1's result earlier this turn; the worker now
	// re-emits it (the duplicate this test guards against).
	c.activeSession = &activeSession{
		sessionUUID:  "uuid-refeed",
		pendingTools: []pendingToolMeta{{ID: "t1", Name: "bash", Args: args}},
		fedResultIDs: map[string]bool{"t1": true},
		live: &liveCLI{
			content:  content,
			scanDone: make(chan struct{}),
			scanErr:  make(chan error, 1),
			control:  cp,
		},
	}
	cleanup := seedSession(t, c, c.activeSession)
	defer cleanup()
	sentinel := mustStartSentinel(t)
	c.activeSession.live.cmd = sentinel
	t.Cleanup(func() { _ = sentinel.Process.Kill(); _ = sentinel.Wait() })

	msgs := []provider.Message{
		userMsg("run it"),
		toolUseMsg("t1", "bash"),
		toolResultMsg("t1", "DUPLICATE OUTPUT"),
	}
	cb := func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       msgs,
	}, cb); err != nil {
		t.Fatalf("StreamMessage (continuation): %v", err)
	}

	// The duplicate must NOT reach the parked call — its content never crosses to
	// the CLI. (The parked call is instead error-released at end_turn by
	// discardStaleBuffers, so the CLI never hangs.)
	if strings.Contains(buf.String(), "DUPLICATE OUTPUT") {
		t.Fatalf("duplicate re-fed result was delivered to the parked call — it must be dropped; stdin=%q", buf.String())
	}
	if !strings.Contains(buf.String(), "req-dup") {
		t.Fatalf("parked call was never released — the CLI would hang; stdin=%q", buf.String())
	}
}
