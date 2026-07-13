//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// These tests cover the pure decideNextAction function — the reducer's
// core. One test per row of the decision table in the MessageThread
// state machine plan.
//
// decideNextAction reads only its arguments — it does not touch any
// worker in-memory state — so these tests do not need a worker instance.

// resultJSON builds a json.RawMessage for a tool result, used to mark a
// tool-action as terminal (state alone isn't enough; the Result field
// must also be non-nil for the reducer's hasResult-style checks).
func resultJSON(content string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"content": content})
	return b
}

// userMsg returns a user-type conversation item with the given content.
func userMsg(content string) ConversationItem {
	return ConversationItem{Type: ItemTypeUser, Content: content}
}

// assistantMsg returns an assistant text-only message.
func assistantMsg(content string) ConversationItem {
	return ConversationItem{Type: ItemTypeAssistant, Content: content}
}

// toolAction returns a tool-action item in the given lifecycle state.
// If state is StateCompleted or StateCancelled, a non-empty result is
// attached so isToolTerminal / hasResult checks pass.
func toolAction(id, state string) ConversationItem {
	item := ConversationItem{
		Type:      ItemTypeToolAction,
		ToolUseID: id,
		ToolName:  "bash",
		State:     state,
	}
	if state == StateCompleted {
		item.Result = resultJSON("ok")
	}
	if state == StateCancelled {
		item.Result = resultJSON("cancelled")
	}
	return item
}

// threadMsg returns a thread item. If result is non-empty, the thread
// is considered complete (hasThreadResult returns true).
func threadMsg(itemID, result string) ConversationItem {
	item := ConversationItem{
		Type:   ItemTypeThread,
		ItemID: itemID,
		Goal:   "test thread",
	}
	if result != "" {
		item.Result = json.RawMessage(`"` + result + `"`)
	}
	return item
}

// TestDecideNextAction_Empty: no items → None regardless of root/activity.
func TestDecideNextAction_Empty(t *testing.T) {
	if got := decideNextAction(nil, ActivityNone, true, false); got != ActionNone {
		t.Errorf("empty/root: expected None, got %s", got)
	}
	if got := decideNextAction(nil, ActivityNone, false, false); got != ActionNone {
		t.Errorf("empty/nested: expected None, got %s", got)
	}
}

// TestDecideNextAction_CallingLLM: any state → None if an LLM call is in progress.
func TestDecideNextAction_CallingLLM(t *testing.T) {
	items := []ConversationItem{userMsg("hi")}
	if got := decideNextAction(items, ActivityCallingLLM, true, false); got != ActionNone {
		t.Errorf("calling_llm guard: expected None, got %s", got)
	}
}

// TestDecideNextAction_LastIsUser: user message → CallLLM only when activity="awaiting_llm".
func TestDecideNextAction_LastIsUser(t *testing.T) {
	items := []ConversationItem{userMsg("hello")}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("user/root/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionCallLLM {
		t.Errorf("user/nested/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("user/root/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_LastIsAssistantText_Root: resting unless an explicit
// continuation was requested.
func TestDecideNextAction_LastIsAssistantText_Root(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("hello there"),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("assistant-text/root: expected None, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("assistant-text/root/explicit-continuation: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("assistant-text/root/stale-awaiting: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_LastIsAssistantText_Nested: a nested thread ending in
// an assistant message rests OPEN, exactly like root — ending a turn with
// plain assistant text is no longer an auto-close (a thread closes only on an
// explicit return_result call, or a hard error). So the reducer returns
// ActionNone, never auto-completing the thread. With activity="awaiting_llm",
// the earlier guard treats trailing assistant text as a stale awaiting marker
// (tools were deleted) and returns GoIdle unless this is an explicit user
// continuation.
func TestDecideNextAction_LastIsAssistantText_Nested(t *testing.T) {
	items := []ConversationItem{
		userMsg("do thing"),
		assistantMsg("did thing"),
	}
	if got := decideNextAction(items, ActivityNone, false, false); got != ActionNone {
		t.Errorf("assistant-text/nested/idle: expected None, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionGoIdle {
		t.Errorf("assistant-text/nested/stale-awaiting: expected GoIdle, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, true); got != ActionCallLLM {
		t.Errorf("assistant-text/nested/explicit-continuation: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchPending: any pending tool → rest.
func TestDecideNextAction_BatchPending(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StatePending),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("pending tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchApproved: approved/running → rest (tool-action
// reducer is handling it).
func TestDecideNextAction_BatchApproved(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StateApproved),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("approved tool/root: expected None, got %s", got)
	}

	items[2].State = StateRunning
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("running tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchUnsetState: state="" → rest (new tool-action
// not yet evaluated by the tool-action reducer).
func TestDecideNextAction_BatchUnsetState(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		{Type: ItemTypeToolAction, ToolUseID: "call_1", ToolName: "bash"}, // State=""
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("unset-state tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_Awaiting: all tools completed +
// activity="awaiting_llm" → continue the LLM.
func TestDecideNextAction_BatchAllCompleted_Awaiting(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls and pwd"),
		assistantMsg("running both"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCompleted),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("all-completed/awaiting: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_Idle: all tools completed +
// activity="" → None (tools already consumed by a previous LLM turn).
func TestDecideNextAction_BatchAllCompleted_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls and pwd"),
		assistantMsg("running both"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCompleted),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("all-completed/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_CallingLLM: all tools completed +
// activity="calling_llm" → None (LLM call already in progress).
func TestDecideNextAction_BatchAllCompleted_CallingLLM(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
	}
	if got := decideNextAction(items, ActivityCallingLLM, true, false); got != ActionNone {
		t.Errorf("all-completed/calling: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchMixed: some completed, some cancelled +
// activity="awaiting_llm" → any denial stops the turn → GoIdle.
func TestDecideNextAction_BatchMixed(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("mixed batch/awaiting: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchMixedExplicitContinue: same mixed batch as above,
// but the user explicitly clicked Continue (explicitContinuation=true). An
// explicit Continue means "proceed anyway despite the denial" → CallLLM, not
// GoIdle. Mirrors the assistant-last branch which already honours the flag.
func TestDecideNextAction_BatchMixedExplicitContinue(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("mixed batch/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelledExplicitContinue: user denied every
// tool in the batch, then explicitly clicked Continue → CallLLM (proceed with
// the cancelled results), not GoIdle.
func TestDecideNextAction_BatchAllCancelledExplicitContinue(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("all-cancelled/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Root: user denied everything +
// activity="awaiting_llm" → GoIdle (clear the awaiting marker).
func TestDecideNextAction_BatchAllCancelled_Root(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("all-cancelled/root: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Nested: nested thread with all
// tools denied + activity="awaiting_llm" → GoIdle (denial is not a
// completion — just clear the marker and rest).
func TestDecideNextAction_BatchAllCancelled_Nested(t *testing.T) {
	items := []ConversationItem{
		userMsg("run things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionGoIdle {
		t.Errorf("all-cancelled/nested: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Idle: all cancelled + activity=""
// → None (not awaiting, so don't act).
func TestDecideNextAction_BatchAllCancelled_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("run things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
	}
	if got := decideNextAction(items, ActivityNone, false, false); got != ActionNone {
		t.Errorf("all-cancelled/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_OldIncompleteToolBlocksNewLLMCall: the reducer
// must not CallLLM while ANY tool in the thread (not just the current
// batch) is still in flight.
func TestDecideNextAction_OldIncompleteToolBlocksNewLLMCall(t *testing.T) {
	items := []ConversationItem{
		userMsg("turn 1"),
		assistantMsg("used tool"),
		toolAction("old", StateApproved), // user-retried old tool, still in flight
		userMsg("turn 2"),                // new user message
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("old incomplete tool: expected None, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemWithResult_Awaiting: parent sees a nested
// thread with a result + activity="awaiting_llm" → CallLLM.
func TestDecideNextAction_ThreadItemWithResult_Awaiting(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", "child is done"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("thread-with-result/awaiting: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemWithResult_Idle: parent sees a nested
// thread with a result + activity="" → None (already consumed).
func TestDecideNextAction_ThreadItemWithResult_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", "child is done"),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread-with-result/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemNoResult: parent sees a nested thread
// still running → rest; the child's reducer is handling it.
func TestDecideNextAction_ThreadItemNoResult(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", ""),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread-no-result: expected None, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemExplicitNull: a thread.Result set to
// literal JSON null should NOT count as a result.
func TestDecideNextAction_ThreadItemExplicitNull(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		{
			Type:   ItemTypeThread,
			ItemID: "child-1",
			Result: json.RawMessage("null"),
		},
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread null-result: expected None, got %s", got)
	}
}

// TestDecideNextAction_MetaToolResult: a meta-tool result triggers CallLLM
// only when activity="awaiting_llm".
func TestDecideNextAction_MetaToolResult(t *testing.T) {
	items := []ConversationItem{
		userMsg("compact"),
		{Type: ItemTypeMetaToolResult, Content: "compacted"},
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("meta-tool-result/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("meta-tool-result/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_IgnoresThinkingAndErrors: thinking blocks and
// error items are skipped; decision falls through to the previous
// conversation item.
func TestDecideNextAction_IgnoresThinkingAndErrors(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		{Type: ItemTypeThinking, Content: "hmm"},
		{Type: ItemTypeError, Content: "something weird"},
	}
	// Effective last item is the user → CallLLM when awaiting, None when idle.
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("trailing thinking+error/root/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("trailing thinking+error/root/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_IgnoresContextItems: context items like
// system-prompt, rule, tree must not drive the decision.
func TestDecideNextAction_IgnoresContextItems(t *testing.T) {
	items := []ConversationItem{
		{Type: "system-prompt", Content: "you are helpful"},
		{Type: "rule", Content: "be terse"},
		{Type: "tree", Content: "project tree"},
		userMsg("hi"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("context-items + user/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("context-items + user/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_OnlyContextItems: a conversation with only
// context items and no conversation flow is at rest.
func TestDecideNextAction_OnlyContextItems(t *testing.T) {
	items := []ConversationItem{
		{Type: "system-prompt", Content: "you are helpful"},
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("only context items: expected None, got %s", got)
	}
}

// TestCurrentToolBatch: walks back from the end collecting consecutive
// tool-actions.
func TestCurrentToolBatch(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("a1"),
		toolAction("t1", StateCompleted),
		toolAction("t2", StateCompleted),
		assistantMsg("a2"),
		toolAction("t3", StateCompleted),
		toolAction("t4", StateCompleted),
	}
	batch := currentToolBatch(items)
	if len(batch) != 2 {
		t.Fatalf("expected 2 tools in batch, got %d", len(batch))
	}
	if batch[0].ToolUseID != "t3" || batch[1].ToolUseID != "t4" {
		t.Errorf("expected batch [t3 t4], got [%s %s]", batch[0].ToolUseID, batch[1].ToolUseID)
	}
}

// TestCurrentToolBatch_NoTrailingTools: last item isn't a tool → empty batch.
func TestCurrentToolBatch_NoTrailingTools(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("hello"),
	}
	if batch := currentToolBatch(items); len(batch) != 0 {
		t.Errorf("expected empty batch, got %+v", batch)
	}
}

// TestSelectThreadFallbackResult covers the pure picker used on demand by the
// footer's "Close with last message" close (closeThreadWithLastMessage): it
// promotes the trailing assistant text as the thread result, or returns "" when
// there's no clean trailing assistant reply to promote.
func TestSelectThreadFallbackResult(t *testing.T) {
	cases := []struct {
		name  string
		items []ConversationItem
		want  string
	}{
		{
			name: "qualifying assistant text wins",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("here is the summary"),
			},
			want: "here is the summary",
		},
		{
			name: "preamble before tool call is rejected",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("I'll search for it..."),
				toolAction("t1", StateCompleted),
			},
			want: "",
		},
		{
			name: "last qualifying text wins, intermediate preambles ignored",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("I'll search..."),
				toolAction("t1", StateCompleted),
				assistantMsg("found it: foo"),
			},
			want: "found it: foo",
		},
		{
			name: "meta-tool-result also disqualifies preceding text",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("calling a meta tool"),
				{Type: ItemTypeMetaToolResult, ToolUseID: "m1", ToolName: "drop_context_items"},
			},
			want: "",
		},
		{
			name: "empty content is skipped",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg(""),
				assistantMsg("real text"),
			},
			want: "real text",
		},
		{
			name:  "no items returns empty",
			items: nil,
			want:  "",
		},
		{
			name: "trailing user message means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				userMsg("but wait, also..."),
			},
			want: "",
		},
		{
			name: "trailing incomplete tool-action means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				userMsg("do a thing"),
				assistantMsg("ok"),
				toolAction("t1", StateRunning),
			},
			want: "",
		},
		{
			name: "trailing thread item means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				{Type: ItemTypeThread, ItemID: "child"},
			},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := selectThreadFallbackResult(tc.items)
			if got != tc.want {
				t.Errorf("selectThreadFallbackResult = %q, want %q", got, tc.want)
			}
		})
	}
}
