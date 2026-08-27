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

// TestDelegationBlockedDrivesBothConsumers pins the property that makes
// delegationBlocked worth having: its answer must reach BOTH things that follow
// from it. Whenever it says delegation is unavailable, the tool list must have
// dropped every RequiresDelegation tool (they could only fail) and kept every
// merely-optional delegator (they still work inline); whenever it says
// delegation is available, both must survive.
//
// Asserting the two together is the point. Either consumer alone can be changed
// without breaking its own test while silently disagreeing with the other, and
// that disagreement is exactly the bug this pairing exists to prevent: a tool
// offered to a model that cannot use it.
func TestDelegationBlockedDrivesBothConsumers(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "read", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "Explore", InputSchema: json.RawMessage(`{"type":"object"}`),
			DelegatesToSubthread: true, RequiresDelegation: true},
		{Name: "WebFetch", InputSchema: json.RawMessage(`{"type":"object"}`),
			DelegatesToSubthread: true},
	}
	offers := func(ts []ToolDefinition, name string) bool {
		for _, td := range ts {
			if td.Name == name {
				return true
			}
		}
		return false
	}

	cases := []struct {
		name        string
		build       func(*ConversationWorker) string
		wantBlocked bool
	}{
		{"ordinary thread", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Normal", llmCreated: true})
		}, false},
		{"delegated thread", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Sub-agent", delegated: true})
		}, true},
		{"descendant of a delegated thread", func(w *ConversationWorker) string {
			parent := insertThreadWithOpts(w, threadOpts{goal: "Sub-agent", delegated: true})
			arr := w.doc.GetThreadItemsArray(parent)
			w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), "Child")
			kids := w.doc.GetItemsFromArray(arr)
			return kids[len(kids)-1].ItemID
		}, true},
		{"at the nesting cap", func(w *ConversationWorker) string {
			arr := w.doc.ensureItems()
			deepest := ""
			for i := 1; i <= maxThreadDepth; i++ {
				nested := w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), "L")
				items := w.doc.GetItemsFromArray(arr)
				deepest = items[len(items)-1].ItemID
				arr = nested
			}
			return deepest
		}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			threadID := tc.build(w)
			w.turn.thread.itemID = threadID

			reason := w.delegationBlocked(threadID)
			if (reason != "") != tc.wantBlocked {
				t.Fatalf("delegationBlocked = %q, wantBlocked=%v", reason, tc.wantBlocked)
			}
			if tc.wantBlocked && reason == "" {
				t.Fatal("a blocked thread must give a reason; it is logged and read by a human")
			}

			got := w.currentRun().filterToolsForThread(tools)
			if offers(got, "Explore") == tc.wantBlocked {
				t.Errorf("Explore offered=%v while delegation blocked=%v: a delegation-only tool must be offered exactly when it could be used",
					offers(got, "Explore"), tc.wantBlocked)
			}
			if !offers(got, "WebFetch") {
				t.Error("WebFetch has an inline path, so it must survive the filter in every case and lose only its delegation")
			}
			if !offers(got, "read") {
				t.Error("an unrelated tool must never be touched by the delegation rule")
			}
		})
	}
}

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
// build-subthread-spec round-trip with the supplied spec (nil → do not
// delegate). The offered tools include a delegating WebFetch so
// turn.delegatingTools routes its calls through the delegation path.
func newDelegationHarness(t *testing.T, spec *SubthreadSpec, mocks []MockResponse) *ConversationWorker {
	t.Helper()
	return newDelegationHarnessSpecs(t, []*SubthreadSpec{spec}, mocks)
}

// newDelegationHarnessSpecs is newDelegationHarness with one spec per call, in
// order; the last repeats once the list runs out. Consumed only on the worker's
// own goroutine, which is what serialises the round-trip.
func newDelegationHarnessSpecs(t *testing.T, specs []*SubthreadSpec, mocks []MockResponse) *ConversationWorker {
	t.Helper()
	return newDelegationHarnessTools(t, specs, mocks, ToolDefinition{
		Name:                 "WebFetch",
		Category:             "read",
		DelegatesToSubthread: true,
		InputSchema:          json.RawMessage(`{"type":"object","properties":{"url":{"type":"string"},"prompt":{"type":"string"}},"required":["url"]}`),
	})
}

// newDelegationHarnessTools is newDelegationHarnessSpecs with the offered
// delegating tool stated explicitly, for tests about what a tool's DEFINITION
// carries into the child it spawns.
func newDelegationHarnessTools(t *testing.T, specs []*SubthreadSpec, mocks []MockResponse, tool ToolDefinition) *ConversationWorker {
	t.Helper()
	next := 0
	spec := func() *SubthreadSpec {
		if len(specs) == 0 {
			return nil
		}
		s := specs[min(next, len(specs)-1)]
		next++
		return s
	}
	w := NewConversationWorker("conv-deleg", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-deleg"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.currentRun().storeState(StateProcessing)

	w.SetCallback("engine", func(b []byte) {
		var head struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &head) != nil {
			return
		}
		if head.Type == "build-subthread-spec" {
			resp, _ := json.Marshal(BuildSubthreadSpecResponse{
				Type:      "build-subthread-spec-response",
				RequestID: head.RequestID,
				Spec:      spec(),
			})
			w.subthreadSpecReply.inject(w.done, resp)
		}
		// A spec carrying a StrategyID makes the child's first turn activate it,
		// which blocks on this hook. Answer with no guidance so activation
		// completes on the spot.
		if head.Type == "run-strategy-hook" {
			resp, _ := json.Marshal(StrategyHookResponse{
				Type:      "strategy-hook-response",
				RequestID: head.RequestID,
			})
			w.strategyHookReply.inject(w.done, resp)
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
			Type:  "tools-result",
			Tools: []ToolDefinition{tool},
		})
		for {
			if !w.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	w.setMockResponses(mocks)
	return w
}

// TestDelegatingToolDeliversChildResultToParent is the happy path: the LLM calls
// a delegating tool (WebFetch with a prompt), the engine returns a spec, a child
// thread runs and comes to rest, and what that run returns is delivered as THIS
// tool's tool_result — the parent sees a well-formed WebFetch
// tool_use/tool_result pair, exactly like create_thread.
func TestDelegatingToolDeliversChildResultToParent(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:       "Find page answer",
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
		// Child thread: comes to rest on its reply.
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "The answer is 42."}},
			StopReason: "end_turn",
		},
		// Parent continuation.
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Done."}},
			StopReason: "end_turn",
		},
	})

	w.currentRun().runStrategyLoop("Find the answer", false)

	messages := w.currentRun().buildMessages(nil)
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
		t.Errorf("tool-result should carry what the child's run returned; got %q", toolResultContent)
	}
	thread := onlyThread(t, w)
	items := threadItems(w, thread.ItemID)
	var runGoal string
	for _, item := range items {
		if item.RunToolUseID == "tu-wf-1" {
			runGoal = item.RunGoal
		}
	}
	if runGoal != "Find page answer" {
		t.Errorf("delegated run goal = %q, want the resolved short spec goal", runGoal)
	}
}

// TestReadOnlySubthreadClaimReachesTheChild follows the readOnlySubthread claim
// the whole way: an item's MANIFEST stamps it on the tool definition, the engine
// offers that definition for one turn, and the child the call spawns must still
// carry the claim afterwards — because the reducer that acts on it runs later,
// when the turn and its tool list are gone.
//
// The negative half is the point of the test rather than an afterthought: a
// delegating tool that says nothing must produce a child that says nothing, or
// every ordinary sub-thread would inherit the licence to run beside its
// siblings.
func TestReadOnlySubthreadClaimReachesTheChild(t *testing.T) {
	for _, tc := range []struct {
		name     string
		declared bool
	}{
		{"declared", true},
		{"undeclared", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := &SubthreadSpec{Goal: "Read the page", Prompt: "Fetch https://example.com and summarise it."}
			w := newDelegationHarnessTools(t, []*SubthreadSpec{spec}, []MockResponse{
				{
					Blocks: []LLMResponseBlock{
						{Type: "tool_use", ID: "tu-ro-1", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"summarise"}`)},
					},
					StopReason: "tool_use",
				},
				{Blocks: []LLMResponseBlock{{Type: "text", Content: "It is a placeholder page."}}, StopReason: "end_turn"},
				{Blocks: []LLMResponseBlock{{Type: "text", Content: "Done."}}, StopReason: "end_turn"},
			}, ToolDefinition{
				Name:                 "WebFetch",
				Category:             "read",
				DelegatesToSubthread: true,
				ReadOnlySubthread:    tc.declared,
				InputSchema:          json.RawMessage(`{"type":"object","properties":{"url":{"type":"string"},"prompt":{"type":"string"}},"required":["url"]}`),
			})

			w.currentRun().runStrategyLoop("Summarise the page", false)

			thread := onlyThread(t, w)
			if got := w.threadIsReadOnly(thread.ItemID); got != tc.declared {
				t.Errorf("threadIsReadOnly(child) = %v, want %v — the tool's claim must survive onto the thread", got, tc.declared)
			}
		})
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

	w.currentRun().runStrategyLoop("Fetch the page", false)

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

// TestDelegatingToolEmptyPromptRunsToolAction covers a spec that names a goal
// but asks nothing. A child with no invocation message has no run record to
// stamp, so its run can only report through the thread's summary — and a child
// agent handed no work is not a delegation in the first place. It degrades to
// the ordinary tool-action, exactly as a null spec does.
func TestDelegatingToolEmptyPromptRunsToolAction(t *testing.T) {
	w := newDelegationHarness(t, &SubthreadSpec{Goal: "Read https://example.com"}, []MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-3", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com"}`)},
			},
			StopReason: "tool_use",
		},
	})

	w.currentRun().runStrategyLoop("Fetch the page", false)

	var foundToolAction bool
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeToolAction && item.ToolUseID == "tu-wf-3" {
			foundToolAction = true
		}
		if item.Type == ItemTypeThread {
			t.Errorf("a spec with no prompt spawned a thread; it has nothing to ask a child")
		}
	}
	if !foundToolAction {
		t.Errorf("expected a client-side WebFetch tool-action (tu-wf-3); items=%+v", w.doc.GetItems())
	}
}

// TestDelegatedChildCannotReDelegate proves the anti-recursion invariant: once
// inside a delegated thread, delegating tools run INLINE rather than spawning
// another child. The parent delegates a WebFetch (→ one child thread); the child
// then calls WebFetch again with a prompt — which, but for the guard, would
// delegate into a grandchild thread and, repeated, cascade without bound. With
// delegationBlocked refusing delegation inside the child, that second call
// becomes an ordinary tool-action and no grandchild thread is created, so
// exactly ONE thread exists in the whole doc. WebFetch is the right tool to
// prove it with: it HAS an inline path, so it stays offered and the guard has to
// be the thing that stops it — a sub-agent tool would simply be absent.
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

	w.currentRun().runStrategyLoop("start", false)

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

// TestDelegatedChildSettlesOnTrailingText proves the return contract: a run's
// answer is the assistant message it comes to rest on, with no tool involved.
// The child here calls nothing and simply replies; that reply settles the run,
// resumes the parent, and is delivered as the WebFetch tool_result. Were the
// answer conditional on a tool call, this run would strand the parent's stamped
// tool_use unpaired.
func TestDelegatedChildSettlesOnTrailingText(t *testing.T) {
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
		// Child: plain text — the run rests on it and returns it.
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

	w.currentRun().runStrategyLoop("What colour?", false)

	// A run that came to rest stamps its reply as the thread's summary.
	var threadResult string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			if ym := w.doc.GetThreadYMap(item.ItemID); ym != nil {
				threadResult, _ = ym.Get("result").(string)
			}
		}
	}
	if !strings.Contains(threadResult, "the answer is Blue") {
		t.Errorf("a run that rested on assistant text must summarise the thread with it; got %q", threadResult)
	}

	// And that result must reach the parent as the WebFetch tool_result.
	messages := w.currentRun().buildMessages(nil)
	var toolResultContent string
	for _, m := range messages {
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-wf-3" {
			toolResultContent, _ = m["content"].(string)
		}
	}
	if !strings.Contains(toolResultContent, "the answer is Blue") {
		t.Errorf("parent must receive a tool_result for the settled run (tu-wf-3); got %q", toolResultContent)
	}
}

// TestDelegatedSessionIsAutoNamedAndReported proves a caller never has to plan
// ahead to follow up. A tool that names no session still gets one, derived from
// its own name, and the result opens with that handle — so the usual shape
// (call it, read the answer, THEN want more) is reachable rather than lost.
func TestDelegatedSessionIsAutoNamedAndReported(t *testing.T) {
	w := newDelegationHarness(t, &SubthreadSpec{
		Goal:   "Read https://example.com",
		Prompt: "Fetch https://example.com and answer: what colour?",
	}, []MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-5", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"what colour?"}`)},
			},
			StopReason: "tool_use",
		},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Blue."}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Thanks."}}, StopReason: "end_turn"},
	})

	w.currentRun().runStrategyLoop("What colour?", false)

	var sessionName string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			sessionName = item.SessionName
		}
	}
	if sessionName != "webfetch-1" {
		t.Errorf("auto session name = %q, want webfetch-1 (derived from the calling tool)", sessionName)
	}

	var content string
	for _, m := range w.currentRun().buildMessages(nil) {
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-wf-5" {
			content, _ = m["content"].(string)
		}
	}
	if !strings.HasPrefix(content, "webfetch-1 · new") {
		t.Errorf("a delegated result must report the handle it can be called on; got %q", content)
	}
}

// TestDelegatedSessionResumeIsAppendOnly proves the delegation path carries the
// same session contract as create_thread: a second call naming the session
// appends one message to the child it already ran — nothing re-seeded, nothing
// replayed — and the parent gets a second tool_result paired to that run alone.
func TestDelegatedSessionResumeIsAppendOnly(t *testing.T) {
	w := newDelegationHarnessSpecs(t, []*SubthreadSpec{
		{Goal: "Read the page", Prompt: "What colour is it?", SessionName: "page"},
		{Goal: "Read the page", Prompt: "And how big?", SessionName: "page"},
	}, []MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-a", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"colour?","session":"page"}`)},
			},
			StopReason: "tool_use",
		},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "It is blue."}}, StopReason: "end_turn"},
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-b", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"size?","session":"page"}`)},
			},
			StopReason: "tool_use",
		},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "About 20kb."}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Done."}}, StopReason: "end_turn"},
	})

	w.currentRun().runStrategyLoop("Tell me about the page", false)

	if n := countThreads(w); n != 1 {
		t.Fatalf("resuming a session must not spawn a sibling: expected 1 thread, got %d", n)
	}

	var threadItem ConversationItem
	for _, item := range w.doc.GetItems() {
		// The alias the resume appended is a second view of the same thread, not
		// the container: the transcript hangs off the canonical.
		if item.Type == ItemTypeThread && item.AliasOf == "" {
			threadItem = item
		}
	}
	items := threadItems(w, threadItem.ItemID)
	first := indexOfItem(items, ItemTypeUser, "What colour is it?")
	answer := indexOfItem(items, ItemTypeAssistant, "It is blue.")
	second := indexOfItem(items, ItemTypeUser, "And how big?")
	if first < 0 || answer < 0 || second < 0 || first >= answer || answer >= second {
		t.Fatalf("resume must append after everything run 1 produced; items=%+v", items)
	}

	results := toolResultContents(w.currentRun().buildMessages(nil))
	if got := results["tu-a"]; !strings.HasPrefix(got, "page · new") || !strings.Contains(got, "It is blue.") {
		t.Errorf("first delegated result = %q, want run 1's reply under the new-session preamble", got)
	}
	if got := results["tu-b"]; !strings.HasPrefix(got, "page · resumed, call 2") || !strings.Contains(got, "About 20kb.") {
		t.Errorf("second delegated result = %q, want run 2's reply under the resumed preamble", got)
	}
}

// TestDelegatedThreadRunsUnderSpecStrategy proves a spec can pin the child's
// strategy. This is what makes a subagent a subagent: the delegating item owns a
// (hidden) strategy with its own tool filter and approval policy, names it here,
// and the child runs under it instead of inheriting the caller's. The id must
// land on the child's own Y.Map, and resolve as its effective strategy.
func TestDelegatedThreadRunsUnderSpecStrategy(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:       "Explore the repo",
		Prompt:     "Find where auth is implemented",
		StrategyID: "subagent-explore",
	}
	w := newDelegationHarness(t, spec, []MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-6", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"where is auth?"}`)},
			},
			StopReason: "tool_use",
		},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "In auth.go."}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Thanks."}}, StopReason: "end_turn"},
	})

	w.currentRun().runStrategyLoop("Where is auth?", false)

	var childID string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			childID = item.ItemID
		}
	}
	if childID == "" {
		t.Fatalf("expected a delegated child thread; items=%+v", w.doc.GetItems())
	}

	ycrdtMu.Lock()
	ym := findThreadYMap(w.doc.getItems(), childID)
	stamped, _ := ym.Get("currentStrategyId").(string)
	ycrdtMu.Unlock()
	if stamped != "subagent-explore" {
		t.Errorf("child thread currentStrategyId = %q, want subagent-explore", stamped)
	}
	if got := w.doc.ResolveEffectiveStrategyID(childID); got != "subagent-explore" {
		t.Errorf("effective strategy for the delegated child = %q, want subagent-explore", got)
	}
}

// TestDelegatedChildErrorReachesParent proves an errored run is an answer, not a
// hang: the child's turn fails, the run settles as an error carrying the
// provider's text, and that text is delivered as the delegating call's
// tool_result so the parent can act on it. The child is left exactly as it is —
// stopped, unsummarised, and free to run again.
func TestDelegatedChildErrorReachesParent(t *testing.T) {
	spec := &SubthreadSpec{
		Goal:   "Read https://example.com",
		Prompt: "Fetch https://example.com and answer: what colour?",
	}
	w := newDelegationHarness(t, spec, []MockResponse{
		// Parent turn: calls delegating WebFetch.
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-wf-4", Name: "WebFetch", Input: json.RawMessage(`{"url":"https://example.com","prompt":"what colour?"}`)},
			},
			StopReason: "tool_use",
		},
		// Child: the turn fails. "invalid request" is terminal — a transient
		// phrase would be retried by the turn loop instead of surfacing.
		{Error: "invalid request: the model refused"},
		// Parent continuation (fires once the child's run settles).
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Noted."}},
			StopReason: "end_turn",
		},
	})

	w.currentRun().runStrategyLoop("What colour?", false)

	// Nothing fabricates a summary out of a failure.
	for _, item := range w.doc.GetItems() {
		if item.Type != ItemTypeThread {
			continue
		}
		if ym := w.doc.GetThreadYMap(item.ItemID); ym != nil {
			if r, _ := ym.Get("result").(string); r != "" {
				t.Errorf("an errored run must not summarise the thread; got %q", r)
			}
		}
	}

	messages := w.currentRun().buildMessages(nil)
	var toolResultContent string
	for _, m := range messages {
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-wf-4" {
			toolResultContent, _ = m["content"].(string)
		}
	}
	if !strings.Contains(toolResultContent, "invalid request") {
		t.Errorf("parent must receive the error text as the delegating call's tool_result; got %q", toolResultContent)
	}
}
