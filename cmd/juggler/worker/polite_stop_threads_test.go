//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// Polite stop (Pause) in a conversation holding more than one thread.
//
// Every case in polite_stop_test.go drives a single thread, so nothing pins what
// the latch means when several runs are live — which is the ordinary shape of any
// turn that spawned sub-agents.

// appendToThread pushes items onto a thread's nested items array in one
// transaction, the way a run appends to the thread it is working in.
func appendToThread(w *ConversationWorker, threadItemID string, items ...ConversationItem) {
	arr := w.doc.GetThreadItemsArray(threadItemID)
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, it := range items {
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(it)})
		}
	}, w.doc.authorID)
}

// feedContextAndTools answers the context/tools round-trips a dispatched turn
// makes, so a turn that wrongly dispatches COMPLETES — leaving evidence in the
// mock queue — instead of hanging the test on a reply channel.
func feedContextAndTools(t *testing.T, w *ConversationWorker) {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			if !w.contextReply.inject(stop, ctxResp) {
				return
			}
		}
	}()
	go func() {
		for {
			if !w.toolsReply.inject(stop, toolsResp) {
				return
			}
		}
	}()
}

// TestPoliteStop_RestsOneThreadAndLetsItsSiblingCallTheModel is the multi-thread
// version of TestPoliteStop_ReducerRestsBeforeNextTurn, and the reported problem
// inside one pass of the reducer.
//
// Two sub-threads are parked on completed tool batches — two sub-agents that have
// each just finished a tool call and are about to ask the model what to do with
// it. One reconcile pass therefore holds two ActionCallLLM targets, and
// dispatchCallLLMOnThread consumes the latch with Swap(false) as its first
// statement. The first thread the walk reaches spends the latch and rests; every
// thread behind it finds the latch already unset and calls the provider.
//
// A pause is a statement about the CONVERSATION — nothing goes to the model until
// the user says so — so both scripted turns must be left unspent.
func TestPoliteStop_RestsOneThreadAndLetsItsSiblingCallTheModel(t *testing.T) {
	w := NewConversationWorker("test-polite-siblings", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// The root turn that spawned them, parked on both children.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a and b",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send two agents.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	// Two children, each mid-run with a completed tool batch awaiting the model.
	children := []string{
		insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true}),
		insertThreadWithOpts(w, threadOpts{goal: "read b", userMessage: "look at b", llmCreated: true, delegated: true}),
	}
	for i, id := range children {
		appendToThread(w, id,
			ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
			ConversationItem{
				Type: ItemTypeToolAction, ItemID: generateItemID(),
				ToolUseID: "tu-" + string(rune('a'+i)), ToolName: "grep",
				State: StateCompleted, Result: resultJSON("ok"),
			},
		)
	}

	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// The user pressed Pause on the root column while both children were in flight.
	w.markPoliteStop("")

	// One scripted turn per child. Every one consumed is a provider request the
	// pause was supposed to prevent.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (a)"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (b)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// Drive the reducer exactly as the event loop would once the tools complete.
	w.needsReconcile.Store(true)
	for i := 0; i < 10 && w.needsReconcile.Load(); i++ {
		w.currentRun().tryReconcile()
	}

	if left := w.mock.remaining(); left != 2 {
		t.Fatalf("Pause let %d of 2 sub-threads call the provider anyway (%d scripted turns left, want 2): "+
			"the latch is conversation-wide but Swap(false) hands it to whichever run reaches a boundary "+
			"first, so one thread rests and every other live thread carries on", 2-left, left)
	}
}

// TestPoliteStop_PausedChildNeitherSettlesNorReDrivesItsParent pins the second
// half of the problem: a pause must not merely fail to stop the conversation, it
// must not START a provider request.
//
// A sub-agent is mid-run when the pause arrives, so the mark is read at
// runOneTurn's top rather than in the reducer. That is a clean ending, not a
// cancellation — so a run that settled here would reach signalParentThread and
// queue the parent for a turn, which is a fresh provider request caused by
// pressing Pause. A paused run is not a finished one: it keeps its open run
// record, the parent stays parked on it, and the thread carries on from exactly
// there when the pause is lifted.
func TestPoliteStop_PausedChildNeitherSettlesNorReDrivesItsParent(t *testing.T) {
	w := NewConversationWorker("test-polite-redrive", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	child := insertThreadWithOpts(w, threadOpts{
		goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true,
	})
	appendToThread(w, child, ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Found it in main.go.",
	})

	// The parent is parked on the child, and the child holds a live claim: the
	// state a conversation is in while a sub-agent works.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.currentRun().claimLLM(child)
	w.turn.thread.itemID = child
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(child)

	// One scripted turn, for the parent. Consuming it is the regression: the user
	// asked the conversation to stop, and it issued a request instead.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (parent)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// The user pressed Pause on the child's own column while it was mid-run.
	w.markPoliteStop(child)

	// The child's next turn begins: the top-of-turn boundary consumes the latch
	// and ends the run.
	w.currentRun().runStrategyLoop("", true)

	for i := 0; i < 10 && w.needsReconcile.Load(); i++ {
		w.currentRun().tryReconcile()
	}

	if left := w.mock.remaining(); left != 1 {
		t.Fatalf("a Pause caused a fresh provider request on the parent (%d scripted turns left, want 1): "+
			"the child rested cleanly on the pause, so its run settled and signalParentThread "+
			"queued the parent for a turn the pause exists to prevent", left)
	}

	// The child's run is still open — that is what keeps the parent parked.
	ycrdtMu.Lock()
	status, _ := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), child))
	ycrdtMu.Unlock()
	if status != "" {
		t.Errorf("the paused child's run settled as %q; a paused run is not a finished one, "+
			"and settling it answers a caller the thread was stopped before answering", status)
	}
}

// TestPoliteStop_StoppingOneThreadLeavesTheConversationPaused is the reported
// sequence, and the one place Pause and Stop meet.
//
// The user pauses the conversation, sees nothing happen for long enough to
// disbelieve it, and presses Stop on the sub-agent to make something happen. A
// hard cancel supersedes a pause (D7) — but only inside what it stops. Lifting
// the ancestor's mark instead hands the parent the turn the pause was holding
// back: the cancelled child reports its outcome to the parent whatever the
// ending, the reducer sees a batch that is now complete, and the parent calls the
// model. That is the "the parent woke up and continued, while still saying
// Pausing…" the user reported.
func TestPoliteStop_StoppingOneThreadLeavesTheConversationPaused(t *testing.T) {
	w := NewConversationWorker("test-polite-stop-child", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	child := insertThreadWithOpts(w, threadOpts{
		goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true,
	})
	appendToThread(w, child, ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Half way through.",
	})

	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.currentRun().claimLLM(child)

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (parent)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// Pause the conversation from the root column, then stop the sub-agent.
	w.markPoliteStop("")
	w.currentRun().handleCancel(cancelReasonUnspecified)

	if !w.politeStopCovers("") {
		t.Fatal("stopping one thread lifted the pause standing over the whole conversation")
	}

	// The stopped child reports its outcome to its caller, as it does at every
	// ending — so the parent's batch is complete and the reducer would drive it.
	w.settleThreadRun(child, true)
	w.needsReconcile.Store(true)
	for i := 0; i < 10 && w.needsReconcile.Load(); i++ {
		w.currentRun().tryReconcile()
	}

	if left := w.mock.remaining(); left != 1 {
		t.Fatalf("the parent carried on after a sub-thread was stopped under a pause "+
			"(%d scripted turns left, want 1): a Stop scoped to one thread must not resume the conversation", left)
	}
}
