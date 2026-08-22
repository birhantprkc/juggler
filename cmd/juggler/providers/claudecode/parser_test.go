//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// recordingCallback returns a StructuredStreamCallback that appends every
// chunk to *out so tests can assert what the parser emits to the frontend.
func recordingCallback(out *[]provider.StreamChunk) provider.StructuredStreamCallback {
	return func(c provider.StreamChunk) (*provider.ToolResult, error) {
		*out = append(*out, c)
		return nil, nil
	}
}

// filterNonProgress drops transient progress, usage, and status chunks so
// tests asserting on content-bearing chunks don't have to thread the running
// token estimate, the mid-stream input-token anchor, or the phase/liveness
// labels (e.g. message_start's "Generating response") through every fixture.
// Those chunks are covered by their own tests.
func filterNonProgress(chunks []provider.StreamChunk) []provider.StreamChunk {
	out := make([]provider.StreamChunk, 0, len(chunks))
	for _, c := range chunks {
		if c.Type == provider.ContentBlockTypeProgress || c.Type == provider.ContentBlockTypeUsage || c.Type == provider.ContentBlockTypeStatus {
			continue
		}
		out = append(out, c)
	}
	return out
}

// feedLines drives processStreamLineWithEarlyReturn over a JSONL script the
// way readUntilPauseOrComplete would, returning the accumulated turnResult,
// the chunks emitted, and the first non-nil error / first pause-true return.
// Lines that are empty are skipped to mirror the scanner.
func feedLines(t *testing.T, c *Client, lines []string) (*turnResult, []provider.StreamChunk, bool, int, error) {
	t.Helper()
	var chunks []provider.StreamChunk
	cb := recordingCallback(&chunks)
	result := &turnResult{progress: provider.NewProgressEmitter(cb)}
	totalToolUse := 0
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		pause, count, err := c.processStreamLineWithEarlyReturn(line, result, cb)
		totalToolUse += count
		if err != nil {
			return result, chunks, pause, totalToolUse, err
		}
		if pause {
			return result, chunks, true, totalToolUse, nil
		}
	}
	return result, chunks, false, totalToolUse, nil
}

// mustJSON marshals v into a single JSONL line; t.Fatal on failure so test
// setup never silently hides a malformed fixture.
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return string(b)
}

// newParserClient builds a Client with only the fields the parser actually
// reads. Model is non-empty so updateCachedModelInfo calls don't no-op.
func newParserClient() *Client {
	return &Client{model: "sonnet"}
}

func TestParser_MalformedLineSkipped(t *testing.T) {
	c := newParserClient()
	res, chunks, pause, count, err := feedLines(t, c, []string{`{this is not json`})
	if err != nil {
		t.Fatalf("malformed line should not error, got %v", err)
	}
	if pause || count != 0 {
		t.Errorf("malformed line should not pause or increment toolUseCount, got pause=%v count=%d", pause, count)
	}
	if len(chunks) != 0 || len(res.Blocks) != 0 {
		t.Errorf("malformed line should emit nothing, got chunks=%d blocks=%d", len(chunks), len(res.Blocks))
	}
}

// streamToolUseLines builds the JSONL a single tool_use block produces under
// --include-partial-messages: content_block_start(tool_use) → input_json_delta →
// content_block_stop — the block the CLI later invokes as an mcp tools/call.
func streamToolUseLines(t *testing.T, index int, id, name string, input map[string]any) []string {
	t.Helper()
	inputJSON, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal tool input: %v", err)
	}
	return []string{
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_start", "index": index,
			"content_block": map[string]any{"type": "tool_use", "id": id, "name": name},
		}}),
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_delta", "index": index,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": string(inputJSON)},
		}}),
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_stop", "index": index,
		}}),
	}
}

// TestParser_RestreamedMessageRoutesLiveResultByKey covers a re-streamed
// assistant message (an HTTP-529 api_retry, or a --resume replaying the parked
// turn): the parser sees the SAME (name+args) tool_use across two message_start
// events, but only the final attempt is invoked as a tools/call. Routing is by
// (name+args) key, so the worker's delivered result reaches the parked call
// regardless of the superseded re-stream — no stream-order id reconstruction,
// nothing to desync. (A superseded attempt that produced its OWN fed result is a
// distinct, worker-level concern: it must not become a committed tool-action;
// the control protocol only ever routes the results it is actually handed.)
func TestParser_RestreamedMessageRoutesLiveResultByKey(t *testing.T) {
	buf, cp := captureStdin()
	c := &Client{model: "sonnet", activeSession: &activeSession{live: &liveCLI{control: cp}}}

	input := map[string]any{"command": "ls"}
	var lines []string
	// Attempt 1: a fresh message that streams the tool_use, then is superseded.
	lines = append(lines, mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}}))
	lines = append(lines, streamToolUseLines(t, 0, "u-stale", mcpToolPrefix+"bash", input)...)
	// Attempt 2: the retry re-opens the message, re-streams the tool_use with a
	// fresh id, and pauses at tool_use.
	lines = append(lines, mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}}))
	lines = append(lines, streamToolUseLines(t, 0, "u-real", mcpToolPrefix+"bash", input)...)
	lines = append(lines, mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
	}}))

	_, _, pause, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if !pause {
		t.Fatalf("expected the stream to pause at tool_use")
	}

	// The reader parks the tools/call only after the stream pauses; mirror that.
	argsJSON, _ := json.Marshal(input)
	params, _ := json.Marshal(MCPToolsCallParams{Name: mcpToolPrefix + "bash", Arguments: argsJSON})
	jrpc, _ := json.Marshal(JSONRPCMessage{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params})
	if err := cp.handleControlRequest(&StreamMessage{
		Type: "control_request", RequestID: "req-real",
		Request: &ControlRequestBody{Subtype: "mcp_message", Message: jrpc},
	}); err != nil {
		t.Fatalf("park tools/call: %v", err)
	}

	// Worker delivers the result for the id the model actually emitted.
	if _, err := cp.deliverNextToolResult(makeMCPMatchKey("bash", argsJSON), &provider.ToolResult{
		ToolUseID: "u-real", Content: "REAL-OUTPUT", ResultStatus: provider.ResultStatusSuccess,
	}); err != nil {
		t.Fatalf("deliver: %v", err)
	}

	got := collectAnswers(t, buf)
	if got["req-real"] != "REAL-OUTPUT" {
		t.Errorf("req-real got %q, want REAL-OUTPUT — the live result must route to the parked call by (name+args) key across a re-streamed message", got["req-real"])
	}
}

func TestParser_SystemInitCapturesSessionID(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "uuid-abc",
	})}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("system/init: %v", err)
	}
	if res.SessionID != "uuid-abc" {
		t.Errorf("expected SessionID=uuid-abc, got %q", res.SessionID)
	}
}

// lastStatusChunk returns the content of the last status chunk in the slice,
// or "" if there is none.
func lastStatusChunk(chunks []provider.StreamChunk) string {
	got := ""
	for _, ch := range chunks {
		if ch.Type == provider.ContentBlockTypeStatus {
			got = ch.Content
		}
	}
	return got
}

func TestParser_SystemInitEmitsWaitingPhase(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "uuid-abc",
	})}
	_, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("system/init: %v", err)
	}
	// The CLI has booted; the spinner should flip from "Starting…" to a
	// "waiting on the model" liveness beat. With no per-turn label set, it
	// falls back to the generic phaseWaiting.
	if got := lastStatusChunk(chunks); got != phaseWaiting {
		t.Errorf("system/init should emit a %q status chunk, got %q (all chunks: %+v)", phaseWaiting, got, chunks)
	}
}

func TestParser_SystemInitEmitsColdStartHistoryPhase(t *testing.T) {
	c := newParserClient()
	// A cold start carrying prior history sets this before reading the stream;
	// system/init should surface it so the long cache-miss wait is labelled.
	c.turnWaitingPhase = phaseProcessingHistory
	lines := []string{mustJSON(t, map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": "uuid-abc",
	})}
	_, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("system/init: %v", err)
	}
	if got := lastStatusChunk(chunks); got != phaseProcessingHistory {
		t.Errorf("system/init should emit the per-turn label %q, got %q", phaseProcessingHistory, got)
	}
}

func TestParser_MessageStartEmitsGeneratingPhase(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type": "stream_event",
		"event": map[string]any{
			"type":    "message_start",
			"message": map[string]any{"usage": map[string]any{"input_tokens": 12}},
		},
	})}
	_, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("message_start: %v", err)
	}
	// The mid-wait beat: ingestion is done and generation has begun.
	if got := lastStatusChunk(chunks); got != phaseGenerating {
		t.Errorf("message_start should emit a %q status chunk, got %q (all chunks: %+v)", phaseGenerating, got, chunks)
	}
}

func TestParser_SystemApiRetryEmitsStatusChunk(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":           "system",
		"subtype":        "api_retry",
		"attempt":        2,
		"max_retries":    5,
		"retry_delay_ms": 3500,
		"error_status":   529,
	})}
	_, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("api_retry: %v", err)
	}
	if len(chunks) != 1 || chunks[0].Type != provider.ContentBlockTypeStatus {
		t.Fatalf("expected one status chunk, got %+v", chunks)
	}
	if !strings.Contains(chunks[0].Content, "HTTP 529") || !strings.Contains(chunks[0].Content, "2/5") {
		t.Errorf("status content missing retry detail: %q", chunks[0].Content)
	}
}

func TestParser_ResultErrorReturnsError(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":    "result",
		"subtype": "error",
		"result":  "rate limit exceeded",
	})}
	_, _, _, _, err := feedLines(t, c, lines)
	if err == nil {
		t.Fatal("expected error from result/error event")
	}
	if !strings.Contains(err.Error(), "rate limit") {
		t.Errorf("error should propagate CLI's message, got %v", err)
	}
}

func TestParser_ResultSuccessSetsEndTurnAndUsage(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":    "result",
		"subtype": "success",
		"result":  "ok",
		"usage": map[string]any{
			"input_tokens":                100,
			"output_tokens":               50,
			"cache_read_input_tokens":     200,
			"cache_creation_input_tokens": 25,
		},
	})}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("result/success: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Errorf("expected StopReason=end_turn, got %q", res.StopReason)
	}
	if res.InputTokens != 100 || res.OutputTokens != 50 || res.CacheReadTokens != 200 || res.CacheWriteTokens != 25 {
		t.Errorf("usage not captured from result event: %+v", res)
	}
}

func TestParser_ResultEmptyResponseFlaggedDistinctly(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{
		"type":    "result",
		"subtype": "success",
		"result":  "",
	})}
	res, _, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("result/empty: %v", err)
	}
	if res.StopReason != "empty_response" {
		t.Errorf("expected StopReason=empty_response for empty result string, got %q", res.StopReason)
	}
}

func TestParser_TextTurnAssemblesBlockAndStreamsChunks(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type": "stream_event",
			"event": map[string]any{
				"type":    "message_start",
				"message": map[string]any{"usage": map[string]any{"input_tokens": 12}},
			},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "Hello, "}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "world."}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
		mustJSON(t, map[string]any{
			"type": "stream_event",
			"event": map[string]any{
				"type":  "message_delta",
				"delta": map[string]any{"stop_reason": "end_turn"},
				"usage": map[string]any{"input_tokens": 12, "output_tokens": 7},
			},
		}),
	}
	res, chunks, pause, count, err := feedLines(t, c, lines)
	if err != nil || pause || count != 0 {
		t.Fatalf("unexpected (err=%v pause=%v count=%d)", err, pause, count)
	}
	if res.StopReason != "end_turn" {
		t.Errorf("StopReason=%q, want end_turn", res.StopReason)
	}
	if len(res.Blocks) != 1 || res.Blocks[0].Type != provider.ContentBlockTypeText || res.Blocks[0].Content != "Hello, world." {
		t.Errorf("expected one assembled text block 'Hello, world.', got %+v", res.Blocks)
	}
	chunks = filterNonProgress(chunks)
	if len(chunks) != 2 || chunks[0].Content != "Hello, " || chunks[1].Content != "world." {
		t.Errorf("expected two text chunks streamed, got %+v", chunks)
	}
	if res.OutputTokens != 7 {
		t.Errorf("message_delta usage not captured: out=%d", res.OutputTokens)
	}
}

func TestParser_ThinkingTurnPreservesSignature(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "thinking"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "thinking_delta", "thinking": "Hmm."}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "signature_delta", "signature": "sig-xyz"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
	}
	res, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Blocks) != 1 || res.Blocks[0].Type != provider.ContentBlockTypeThinking || res.Blocks[0].Content != "Hmm." {
		t.Fatalf("expected one thinking block 'Hmm.', got %+v", res.Blocks)
	}
	sig, _ := res.Blocks[0].Metadata["signature"].(string)
	if sig != "sig-xyz" {
		t.Errorf("expected signature preserved on Metadata, got %q", sig)
	}
	chunks = filterNonProgress(chunks)
	// The text streams first, then the signature follows on a contentless
	// chunk: it is complete only at content_block_stop, and the worker needs it
	// to store the block's providerData. A block that reaches the next turn
	// unsigned is dropped rather than replayed, so streaming the text alone
	// would lose Claude's reasoning across every tool call.
	if len(chunks) != 2 {
		t.Fatalf("expected the thinking text and its signature streamed, got %+v", chunks)
	}
	if chunks[0].Type != provider.ContentBlockTypeThinking || chunks[0].Content != "Hmm." {
		t.Errorf("expected the thinking text first, got %+v", chunks[0])
	}
	if chunks[1].Type != provider.ContentBlockTypeThinking || chunks[1].Content != "" {
		t.Errorf("expected a contentless signature chunk, got %+v", chunks[1])
	}
	if sig, _ := chunks[1].Metadata["signature"].(string); sig != "sig-xyz" {
		t.Errorf("streamed signature = %q, want sig-xyz", sig)
	}
}

func TestParser_ToolUseSingleBlockPauses(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "mcp__juggler__bash"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"cmd":"ls"}`}},
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
	res, chunks, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if !pause || count != 1 {
		t.Errorf("expected pause=true count=1, got pause=%v count=%d", pause, count)
	}
	if res.StopReason != "tool_use" {
		t.Errorf("StopReason=%q, want tool_use", res.StopReason)
	}
	if len(res.Blocks) != 1 || res.Blocks[0].Type != provider.ContentBlockTypeToolUse {
		t.Fatalf("expected one tool_use block, got %+v", res.Blocks)
	}
	tu := res.Blocks[0]
	if tu.ToolUseID != "t1" || tu.ToolName != "bash" {
		t.Errorf("expected (id=t1, name=bash) after prefix strip, got (%q, %q)", tu.ToolUseID, tu.ToolName)
	}
	if cmd, _ := tu.ToolInput["cmd"].(string); cmd != "ls" {
		t.Errorf("tool_use input not parsed, got %+v", tu.ToolInput)
	}
	// The tool_use chunk must reach the callback exactly once and only
	// after content_block_stop (deferred-emit contract).
	toolChunks := 0
	for _, ch := range chunks {
		if ch.Type == provider.ContentBlockTypeToolUse {
			toolChunks++
		}
	}
	if toolChunks != 1 {
		t.Errorf("expected exactly one tool_use chunk emitted to callback, got %d", toolChunks)
	}
}

// TestParser_ParallelToolUseBlocks is the regression test for the
// MCP-FIFO-mismatch class of bug at the parser layer: the LLM emits two
// tool_use blocks in one assistant message at different indices, with
// interleaved deltas. Each block must finalise to its own tool_use chunk
// with the right (id, name, input), and message_delta{tool_use} must
// pause with count=2.
func TestParser_ParallelToolUseBlocks(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t-A", "name": "mcp__juggler__bash"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "tool_use", "id": "t-B", "name": "mcp__juggler__read_file"}},
		}),
		// Interleave the input_json_delta payloads to mirror real streaming.
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"cmd":"`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"path":"/tmp/a"}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `pwd"}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 1},
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
	res, chunks, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatal(err)
	}
	if !pause || count != 2 {
		t.Errorf("expected pause=true count=2, got pause=%v count=%d", pause, count)
	}
	if len(res.Blocks) != 2 {
		t.Fatalf("expected 2 tool_use blocks, got %d (%+v)", len(res.Blocks), res.Blocks)
	}
	// Blocks are appended in content_block_stop order: index 1 stopped
	// first in this script, then index 0.
	byID := map[string]provider.ContentBlock{}
	for _, b := range res.Blocks {
		byID[b.ToolUseID] = b
	}
	a, okA := byID["t-A"]
	b, okB := byID["t-B"]
	if !okA || !okB {
		t.Fatalf("missing block; got map=%+v", byID)
	}
	if a.ToolName != "bash" {
		t.Errorf("t-A name=%q want bash", a.ToolName)
	}
	if cmd, _ := a.ToolInput["cmd"].(string); cmd != "pwd" {
		t.Errorf("t-A input.cmd=%q want pwd", cmd)
	}
	if b.ToolName != "read_file" {
		t.Errorf("t-B name=%q want read_file", b.ToolName)
	}
	if p, _ := b.ToolInput["path"].(string); p != "/tmp/a" {
		t.Errorf("t-B input.path=%q want /tmp/a", p)
	}
	toolChunks := 0
	for _, ch := range chunks {
		if ch.Type == provider.ContentBlockTypeToolUse {
			toolChunks++
		}
	}
	if toolChunks != 2 {
		t.Errorf("expected 2 tool_use chunks delivered to callback, got %d", toolChunks)
	}
}

func TestParser_MessageDeltaStopReasonMapping(t *testing.T) {
	cases := []struct {
		clistop string
		want    string
	}{
		{"end_turn", "end_turn"},
		{"stop_sequence", "end_turn"},
		{"max_tokens", "end_turn"},
		{"refusal", "refusal"}, // unknown passes through
	}
	for _, tc := range cases {
		t.Run(tc.clistop, func(t *testing.T) {
			c := newParserClient()
			line := mustJSON(t, map[string]any{
				"type":  "stream_event",
				"event": map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": tc.clistop}},
			})
			res, _, _, _, err := feedLines(t, c, []string{line})
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if res.StopReason != tc.want {
				t.Errorf("CLI stop_reason=%q → result.StopReason=%q, want %q", tc.clistop, res.StopReason, tc.want)
			}
		})
	}
}

// TestParser_ResultEventToleratesModelUsage exercises the per-model
// context-window auto-update path when the CLI reports modelUsage. We don't
// assert on the global modelInfoCache here (it would leak across tests); we
// only verify the parser doesn't error or panic on the shape.
func TestParser_ResultEventToleratesModelUsage(t *testing.T) {
	c := newParserClient()
	line := mustJSON(t, map[string]any{
		"type":    "result",
		"subtype": "success",
		"result":  "ok",
		"modelUsage": map[string]any{
			"claude-sonnet-4-6": map[string]any{
				"contextWindow":   1000000,
				"maxOutputTokens": 64000,
				"inputTokens":     10,
				"outputTokens":    5,
			},
		},
	})
	if _, _, _, _, err := feedLines(t, c, []string{line}); err != nil {
		t.Fatalf("result with modelUsage should parse cleanly, got %v", err)
	}
}

// TestParser_ProgressEmittedDuringToolUseInputJSON drives a tool_use stream
// where the input arrives as input_json_delta fragments. The parser should
// emit at least one progress chunk carrying a running output-token estimate
// before content_block_stop finalises the tool_use — that's what lets the
// UI's "Receiving..." spinner switch to a live token count instead of
// staying silent during the entire tool-input stream.
func TestParser_ProgressEmittedDuringToolUseInputJSON(t *testing.T) {
	c := newParserClient()
	bigJSON := strings.Repeat(`{"x":"yyyyyyyyyyyyyyyy"}`, 8) // ~200 chars, ~50 tokens
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "Edit"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": bigJSON}},
		}),
	}
	_, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("feed: %v", err)
	}

	var sawProgress bool
	for _, ch := range chunks {
		if ch.Type != provider.ContentBlockTypeProgress {
			continue
		}
		sawProgress = true
		tokens, _ := ch.Metadata["outputTokens"].(int)
		if tokens <= 0 {
			t.Errorf("progress chunk should carry outputTokens > 0, got %d", tokens)
		}
	}
	if !sawProgress {
		t.Fatalf("expected at least one progress chunk during input_json_delta, got chunks=%+v", chunks)
	}
}

// malformedToolUseLines builds the JSONL for one tool_use block whose
// accumulated input payload is non-empty but unparseable — the shape the model
// mis-samples (here the doubled comma observed in the wild).
func malformedToolUseLines(t *testing.T, index int, id string) []string {
	t.Helper()
	return []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": "mcp__juggler__read"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"file_path": "thread_helpers.go", "offset": 340, , "limit": 70}`}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": index},
		}),
	}
}

// TestParser_MalformedToolInputSkipped is the regression test for the
// "tool/request divergence" +1-shift cascade. When a tool_use block's
// accumulated input_json_delta payload is non-empty but won't parse, the parser
// must NOT coerce it to empty args and emit the tool_use anyway: executing a
// tool with empty args (e.g. read with no file_path) injects a phantom result
// that the control-protocol's (name+args) FIFO mis-pairs, desyncing every later
// tool result in the turn. It must also not fail the turn — the CLI answers
// such a block itself with an InputValidationError and drives the model's
// retry, and a turn error would tear the process down mid-recovery.
func TestParser_MalformedToolInputSkipped(t *testing.T) {
	c := newParserClient()
	res, chunks, pause, count, err := feedLines(t, c, malformedToolUseLines(t, 0, "t-bad"))
	if err != nil {
		t.Fatalf("malformed tool input must not fail the turn (the CLI recovers from it), got %v", err)
	}
	if pause || count != 0 {
		t.Errorf("skipped block should neither pause nor count, got pause=%v count=%d", pause, count)
	}
	for _, ch := range chunks {
		if ch.Type == provider.ContentBlockTypeToolUse {
			t.Errorf("malformed tool input must not emit a tool_use chunk (it would execute with empty args), got input=%+v", ch.ToolInput)
		}
	}
	for _, b := range res.Blocks {
		if b.Type == provider.ContentBlockTypeToolUse {
			t.Errorf("malformed tool input must not append a tool_use block, got input=%+v", b.ToolInput)
		}
	}
	if res.cliServedThisCall != 1 {
		t.Errorf("skipped block should be tallied as CLI-served, got %d", res.cliServedThisCall)
	}
	if lastStatusChunk(chunks) == "" {
		t.Error("skipped block should emit a status chunk so the user sees the retry")
	}
}

// TestParser_MalformedToolInputAloneDoesNotPause covers the second half of the
// fix: a tool_use batch whose every block was skipped parks nothing on our
// side, so the message_delta pause must be suppressed and the read loop must
// carry on into the CLI's recovery call. Pausing there would hand the worker a
// round with no tools to run while the CLI streams that call to nobody.
func TestParser_MalformedToolInputAloneDoesNotPause(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}})}
	lines = append(lines, malformedToolUseLines(t, 0, "t-bad")...)
	lines = append(lines,
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
		}}),
		// The CLI's recovery call: the model retries, this time with valid
		// input, and the turn ends normally.
		mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}}),
	)
	lines = append(lines, streamToolUseLines(t, 0, "t-good", "mcp__juggler__read", map[string]any{"file_path": "thread_helpers.go"})...)
	lines = append(lines, mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
	}}))

	res, chunks, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pause {
		t.Fatal("the recovery call's tool_use must still pause the turn")
	}
	if count != 1 {
		t.Errorf("only the well-formed block should count, got %d", count)
	}
	tools := 0
	for _, ch := range filterNonProgress(chunks) {
		if ch.Type == provider.ContentBlockTypeToolUse {
			tools++
			if ch.ToolUseID != "t-good" {
				t.Errorf("emitted the wrong tool_use: %q", ch.ToolUseID)
			}
		}
	}
	if tools != 1 || len(res.Blocks) != 1 {
		t.Fatalf("expected exactly the recovery tool_use, got chunks=%d blocks=%d", tools, len(res.Blocks))
	}
}

// TestParser_MalformedToolInputMixedBatchStillPauses guards the boundary: when
// a batch carries a well-formed block alongside a skipped one, the CLI IS
// parked on the good one, so the turn must pause and deliver its result as
// normal.
func TestParser_MalformedToolInputMixedBatchStillPauses(t *testing.T) {
	c := newParserClient()
	lines := []string{mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{"type": "message_start"}})}
	lines = append(lines, streamToolUseLines(t, 0, "t-good", "mcp__juggler__read", map[string]any{"file_path": "a.go"})...)
	lines = append(lines, malformedToolUseLines(t, 1, "t-bad")...)
	lines = append(lines, mustJSON(t, map[string]any{"type": "stream_event", "event": map[string]any{
		"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"},
	}}))

	res, _, pause, count, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pause || count != 1 {
		t.Fatalf("a batch with one dispatchable block must pause with count 1, got pause=%v count=%d", pause, count)
	}
	if res.StopReason != "tool_use" {
		t.Errorf("StopReason = %q, want tool_use", res.StopReason)
	}
}

// TestParser_EmptyToolInputStillEmits guards the boundary the fix above must
// not cross: a tool legitimately called with NO arguments (empty payload)
// finalises to an empty-args tool_use, not an error. Only a non-empty,
// unparseable payload is the corruption case.
func TestParser_EmptyToolInputStillEmits(t *testing.T) {
	c := newParserClient()
	lines := []string{
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t-noargs", "name": "mcp__juggler__list_projects"}},
		}),
		mustJSON(t, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		}),
	}
	res, chunks, _, _, err := feedLines(t, c, lines)
	if err != nil {
		t.Fatalf("no-arg tool must not error, got %v", err)
	}
	toolChunks := 0
	for _, ch := range chunks {
		if ch.Type == provider.ContentBlockTypeToolUse {
			toolChunks++
		}
	}
	if toolChunks != 1 || len(res.Blocks) != 1 {
		t.Fatalf("no-arg tool should emit exactly one tool_use chunk+block, got chunks=%d blocks=%d", toolChunks, len(res.Blocks))
	}
}
