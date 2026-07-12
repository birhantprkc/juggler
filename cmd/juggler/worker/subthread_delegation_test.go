//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// countThreads returns the total number of thread items anywhere in the doc
// (root + nested), used to prove delegation did or did not nest.
func countThreads(w *ConversationWorker) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	n := 0
	walkThreads(w.doc.getItems(), func(_ *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		n++
		return false
	})
	return n
}

// newDelegationHarness wires a worker with an in-test "engine" that answers the
// subthread-delegation round-trips: build-subthread-spec is answered with the
// supplied spec (nil → do not delegate), and subthread-error is answered with
// an empty fallback. The offered tools include a delegating WebFetch so
// turnDelegatingTools routes its calls through the delegation path.
func newDelegationHarness(t *testing.T, spec *SubthreadSpec, mocks []MockResponse) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("conv-deleg", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-deleg"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.handleInit(initPayload)
	w.storeState(StateProcessing)

	w.SetCallback("engine", func(b []byte) {
		var head struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &head) != nil {
			return
		}
		switch head.Type {
		case "build-subthread-spec":
			resp, _ := json.Marshal(BuildSubthreadSpecResponse{
				Type:      "build-subthread-spec-response",
				RequestID: head.RequestID,
				Spec:      spec,
			})
			w.subthreadSpecResultChan <- resp
		case "subthread-error":
			resp, _ := json.Marshal(SubthreadErrorResponse{
				Type:      "subthread-error-response",
				RequestID: head.RequestID,
				Result:    "",
			})
			w.subthreadErrorResultChan <- resp
		}
	})
	w.SetEngineClientID("engine")

	// Feed context + tools continuously (one pair per LLM turn). The tools list
	// carries a delegating WebFetch so the worker treats its calls as delegable.
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(ToolsResultMessage{
			Type: "tools-result",
			Tools: []ToolDefinition{{
				Name:                 "WebFetch",
				Category:             "read",
				DelegatesToSubthread: true,
				InputSchema:          json.RawMessage(`{"type":"object","properties":{"url":{"type":"string"},"prompt":{"type":"string"}},"required":["url"]}`),
			}},
		})
		for {
			select {
			case <-w.done:
				return
			case w.contextResultChan <- ctxResp:
			}
			select {
			case <-w.done:
				return
			case w.toolsResultChan <- toolsResp:
			}
		}
	}()

	w.setMockResponses(mocks)
	return w
}

// TestDelegatingToolDeliversChildResultToParent is the happy path: the LLM calls
// a delegating tool (WebFetch with a prompt), the engine returns a spec, a child
// thread runs and closes via return_result, and the child's result is delivered
// as THIS tool's tool_result — the parent sees a well-formed WebFetch
// tool_use/tool_result pair, exactly like create_thread.
func TestDelegatingToolDeliversChildResultToParent(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:       "Read https://example.com",
		Prompt:     "Fetch https://example.com and answer: what is the answer?",
		ResultSpec: "the answer in markdown",
	}
	w := newDelegationHarness(t, spec, []MockResponse{
		// Parent turn: calls the delegating WebFetch tool.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-1", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"what is the answer?"}`)},
			},
			StopReason: "tool_use",
		},
		// Child thread: closes via return_result.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-ret-1", Name: "return_result", Input: json.RawMessage(`{"result":"The answer is 42."}`)},
			},
			StopReason: "tool_use",
		},
		// Parent continuation.
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Done."}},
			StopReason: "end_turn",
		},
	})

	w.runStrategyLoop("Find the answer", false)

	messages := w.buildMessages(nil)
	var foundToolUse, foundToolResult bool
	var toolResultContent string
	for _, m := range messages {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-wf-1" && m["toolName"] == "WebFetch" {
			foundToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-wf-1" {
			foundToolResult = true
			toolResultContent, _ = m["content"].(string)
		}
	}
	if !foundToolUse {
		t.Errorf("expected WebFetch tool-use (tu-wf-1) in parent messages; messages=%+v", messages)
	}
	if !foundToolResult {
		t.Fatalf("expected tool-result for tu-wf-1 (delegated child result) in parent messages; messages=%+v", messages)
	}
	if !strings.Contains(toolResultContent, "The answer is 42.") {
		t.Errorf("tool-result should carry the child's return_result; got %q", toolResultContent)
	}
}

// TestDelegatingToolNullSpecRunsToolAction proves conditional delegation: when
// buildSubthreadSpec returns null (here: WebFetch with no prompt), the worker
// falls back to the ordinary client-side tool-action rather than spawning a
// thread. No thread item is created; a WebFetch tool-action is.
func TestDelegatingToolNullSpecRunsToolAction(t *testing.T) {
	w := newDelegationHarness(t, nil, []MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-2", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com"}`)},
			},
			StopReason: "tool_use",
		},
	})

	w.runStrategyLoop("Fetch the page", false)

	var foundToolAction, foundThread bool
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeToolAction && item.ToolUseID == "tu-wf-2" && item.ToolName == "WebFetch" {
			foundToolAction = true
		}
		if item.Type == ItemTypeThread {
			foundThread = true
		}
	}
	if !foundToolAction {
		t.Errorf("null spec must fall back to a client-side WebFetch tool-action (tu-wf-2); items=%+v", w.doc.GetItems())
	}
	if foundThread {
		t.Errorf("null spec must NOT spawn a delegated thread; a thread item was created")
	}
}

// TestDelegatedChildCannotReDelegate proves the anti-recursion invariant: once
// inside a delegated thread, delegating tools run INLINE rather than spawning
// another child. The parent delegates a WebFetch (→ one child thread); the child
// then calls WebFetch again with a prompt — which, but for the guard, would
// delegate into a grandchild thread and, repeated, cascade without bound. With
// withinDelegatedThread suppressing turnDelegatingTools in the child, that second
// call becomes an ordinary tool-action and no grandchild thread is created, so
// exactly ONE thread exists in the whole doc.
func TestDelegatedChildCannotReDelegate(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:       "Read https://example.com",
		Prompt:     "Fetch https://example.com and answer the request",
		ResultSpec: "the answer in markdown",
	}
	w := newDelegationHarness(t, spec, []MockResponse{
		// Parent turn: delegating WebFetch → spawns the (only) child thread.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-parent", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"outer?"}`)},
			},
			StopReason: "tool_use",
		},
		// Child turn: calls WebFetch AGAIN with a prompt. The guard must force this
		// to run inline (a tool-action), NOT delegate into a grandchild thread.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-child", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"inner?"}`)},
			},
			StopReason: "tool_use",
		},
	})

	w.runStrategyLoop("start", false)

	if n := countThreads(w); n != 1 {
		t.Fatalf("delegated child must not re-delegate: expected exactly 1 thread (the delegated child), got %d", n)
	}

	// The child's second WebFetch must have landed as an ordinary tool-action.
	var childToolAction bool
	ycrdtMu.Lock()
	walkThreads(w.doc.getItems(), func(_ *ycrdt.YMap, nested *ycrdt.YArray, _ string) bool {
		if nested == nil {
			return false
		}
		for _, it := range w.doc.getItemsFromArrayLocked(nested) {
			if it.Type == ItemTypeToolAction && it.ToolUseID == "tu-child" && it.ToolName == "WebFetch" {
				childToolAction = true
			}
		}
		return false
	})
	ycrdtMu.Unlock()
	if !childToolAction {
		t.Errorf("child's second WebFetch should run inline as a tool-action (tu-child), not delegate")
	}
}

// TestDelegatedOpenChildResolvesResult proves the open-end guarantee: a
// delegated child that ends WITHOUT calling return_result must still yield a
// tool_result so the parent's stamped tool_use is never stranded. Here the child
// ends on plain assistant text; resolveDelegatedThreadResult promotes that text
// as the result, which resumes the parent and is delivered as the WebFetch
// tool_result. Without the resolution the thread would stay open and the parent
// would hang with an unpaired tool_use.
func TestDelegatedOpenChildResolvesResult(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:   "Read https://example.com",
		Prompt: "Fetch https://example.com and answer: what colour?",
	}
	w := newDelegationHarness(t, spec, []MockResponse{
		// Parent turn: calls delegating WebFetch.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-3", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"what colour?"}`)},
			},
			StopReason: "tool_use",
		},
		// Child: plain text, NO return_result → ends open.
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "I read the page; the answer is Blue."}},
			StopReason: "end_turn",
		},
		// Parent continuation (fires once the child result is resolved).
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Thanks."}},
			StopReason: "end_turn",
		},
	})

	w.runStrategyLoop("What colour?", false)

	// The delegated thread must have a resolved result (not left open).
	var threadResult string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			if ym := w.doc.GetThreadYMap(item.ItemID); ym != nil {
				threadResult, _ = ym.Get("result").(string)
			}
		}
	}
	if !strings.Contains(threadResult, "the answer is Blue") {
		t.Errorf("open delegated child must resolve a result from its trailing text; got %q", threadResult)
	}

	// And that result must reach the parent as the WebFetch tool_result.
	messages := w.buildMessages(nil)
	var toolResultContent string
	for _, m := range messages {
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-wf-3" {
			toolResultContent, _ = m["content"].(string)
		}
	}
	if !strings.Contains(toolResultContent, "the answer is Blue") {
		t.Errorf("parent must receive a tool_result for the open delegated child (tu-wf-3); got %q", toolResultContent)
	}
}
