//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestResolveRunOutcome pins the whole outcome table. Every ending resolves to
// a status and a non-empty result: a caller that stamped a tool_use is owed a
// tool_result whatever happened, and an unpaired tool_use is wire-invalid.
func TestResolveRunOutcome(t *testing.T) {
	assistant := ConversationItem{Type: ItemTypeAssistant, Content: "Here is the answer."}
	user := ConversationItem{Type: ItemTypeUser, Content: "do it"}

	tests := []struct {
		name       string
		items      []ConversationItem
		cancelled  bool
		wantStatus string
		wantResult string
	}{
		{
			name:       "clean trailing reply rests",
			items:      []ConversationItem{user, assistant},
			wantStatus: runStatusRest,
			wantResult: "Here is the answer.",
		},
		{
			// The error is what the run ended on, so it is what the run returns —
			// never dropped in favour of the reply that preceded it.
			name: "trailing error wins over earlier text",
			items: []ConversationItem{
				user, assistant,
				{Type: ItemTypeError, Content: "invalid request: bad model"},
			},
			wantStatus: runStatusError,
			wantResult: "invalid request: bad model",
		},
		{
			name:       "cancelled with nothing produced",
			items:      []ConversationItem{user},
			cancelled:  true,
			wantStatus: runStatusCancelled,
			wantResult: runCancelledNote,
		},
		{
			// What it managed to say is worth keeping; the reason is appended so
			// the caller can tell a full answer from an interrupted one.
			name:       "cancelled keeps what it produced",
			items:      []ConversationItem{user, assistant},
			cancelled:  true,
			wantStatus: runStatusCancelled,
			wantResult: "Here is the answer.\n\n" + runCancelledNote,
		},
		{
			name:       "nothing clean to return is barren",
			items:      []ConversationItem{user},
			wantStatus: runStatusBarren,
			wantResult: runBarrenNote,
		},
		{
			// A run whose last act was a sync meta tool has no reply to return:
			// the trailing item is plumbing, not an answer.
			name: "trailing meta-tool result is barren",
			items: []ConversationItem{
				user,
				{Type: ItemTypeMetaToolResult, ToolName: "drop_context_items"},
			},
			wantStatus: runStatusBarren,
			wantResult: runBarrenNote,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, result := resolveRunOutcome(tc.items, tc.cancelled)
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if result != tc.wantResult {
				t.Errorf("result = %q, want %q", result, tc.wantResult)
			}
			if result == "" {
				t.Errorf("every ending must return something — a caller is owed a tool_result")
			}
		})
	}
}

// threadItemWithRun builds a thread item whose transcript is one invocation
// message in the given run state, as the wire and the deciders see it. A
// settled run reports the summary as its own result, exactly as a real settle
// writes both.
func threadItemWithRun(t *testing.T, runStatus, result string) ConversationItem {
	t.Helper()
	invocation := ConversationItem{
		Type:         ItemTypeUser,
		ItemID:       "inv-1",
		Content:      "do the task",
		RunToolUseID: "tu-1",
		RunToolName:  "create_thread",
		RunToolInput: json.RawMessage(`{"goal":"g","prompt":"p"}`),
		RunStatus:    runStatus,
	}
	if runStatus != "" {
		invocation.RunResult = result
	}
	nested := []ConversationItem{invocation}
	raw, err := json.Marshal(nested)
	if err != nil {
		t.Fatalf("marshal nested items: %v", err)
	}
	item := ConversationItem{Type: ItemTypeThread, ItemID: "thread-1", Goal: "g", Items: raw}
	if result != "" {
		item.Result, _ = json.Marshal(result)
	}
	return item
}

// TestThreadRunSettledReadsTheRunNotTheSummary pins the distinction the whole
// refactor turns on. `result` is the thread's current summary and outlives the
// run that wrote it, so a thread invoked again while carrying one is still
// running — reading the summary instead would report it finished and answer its
// caller with the previous run's reply.
func TestThreadRunSettledReadsTheRunNotTheSummary(t *testing.T) {
	if settled := threadRunSettled(threadItemWithRun(t, "", "")); settled {
		t.Errorf("a run with no recorded outcome must read as running")
	}
	if settled := threadRunSettled(threadItemWithRun(t, runStatusRest, "The summary.")); !settled {
		t.Errorf("a settled run must read as finished")
	}
	if settled := threadRunSettled(threadItemWithRun(t, "", "An older summary.")); settled {
		t.Errorf("a thread carrying a summary from an earlier run must still read as running")
	}

	// A document written before run records existed answers from `result`, which
	// is the only completion it ever recorded.
	legacy := ConversationItem{Type: ItemTypeThread, ItemID: "thread-legacy", Goal: "g"}
	legacy.Result, _ = json.Marshal("Legacy result.")
	if settled := threadRunSettled(legacy); !settled {
		t.Errorf("a thread with no run record must fall back to its result")
	}
	if settled := threadRunSettled(ConversationItem{Type: ItemTypeThread, ItemID: "empty"}); settled {
		t.Errorf("a thread with neither a run record nor a result is not finished")
	}
}

// TestThreadRunSettledReadsAFoldAsAFold covers the ordinary shape of a fold
// inside a long-lived session: a compaction thread whose swallowed transcript
// carries run records belonging to the runs it folded. Read as runs,
// its trailing item is the summarization prompt with no outcome, so it would
// report as a live child forever — parking the thread that holds it, and
// sending the reducer down into it to re-summarize a fold that already has its
// summary. A fold's completion is its `result`, the same question
// pendingCompactionFold asks.
func TestThreadRunSettledReadsAFoldAsAFold(t *testing.T) {
	swallowed, err := json.Marshal([]ConversationItem{
		{
			Type: ItemTypeUser, ItemID: "inv-1", Content: "do the task",
			RunToolUseID: "tu-1", RunToolName: "Explore",
			RunToolInput: json.RawMessage(`{"prompt":"p"}`),
			RunStatus:    runStatusRest, RunResult: "the answer",
		},
		{Type: ItemTypeUser, ItemID: "prompt", Content: DefaultSummarizationPrompt},
	})
	if err != nil {
		t.Fatalf("marshal swallowed items: %v", err)
	}
	fold := ConversationItem{
		Type: ItemTypeThread, ItemID: "fold-1", Goal: "Compacted conversation history",
		BoundedCompaction: true, Items: swallowed,
	}
	if threadRunSettled(fold) {
		t.Error("an unsummarized fold must read as unfinished — the summarizer still owes it a result")
	}
	fold.Result, _ = json.Marshal("the fold summary")
	if !threadRunSettled(fold) {
		t.Error("a summarized fold is finished; the run records inside it belong to what it swallowed")
	}

	// The same mistake on the wire: a fold's swallowed invocation messages are
	// the caller's calls into the thread that folded them, so emitting them here
	// would put the parent's tool_use blocks inside the child's own history. A
	// fold renders as the inert summary it is.
	if runs := threadRunRecords(fold); runs != nil {
		t.Errorf("a fold reported %d runs of its own; they belong to what it swallowed", len(runs))
	}
	msgs := appendThreadMessages(nil, fold, nil)
	if len(msgs) != 1 || msgs[0]["type"] != ItemTypeUser {
		t.Errorf("fold wire = %+v, want the single inert summary message", msgs)
	}
}

// TestSettledRunUnparksTheCaller is the direct regression guard for the switch
// from `result` to the run record: a parent parked on a child resumes the
// moment that child's run settles, whatever it settled as. A half-applied
// switch shows up here as a parent that never wakes, and nowhere else until a
// user hits it.
func TestSettledRunUnparksTheCaller(t *testing.T) {
	for _, status := range []string{runStatusRest, runStatusError, runStatusCancelled, runStatusBarren} {
		t.Run(status, func(t *testing.T) {
			items := []ConversationItem{
				{Type: ItemTypeUser, Content: "start"},
				threadItemWithRun(t, status, ""),
			}
			if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionCallLLM {
				t.Errorf("action = %q, want %q — a parked caller must resume on a settled run", action, ActionCallLLM)
			}
		})
	}

	// A run still going keeps the caller parked. This is the same guard from the
	// other side: an approval the child is waiting on is not an ending, and
	// inventing a return for it would strand output nobody collects.
	items := []ConversationItem{
		{Type: ItemTypeUser, Content: "start"},
		threadItemWithRun(t, "", ""),
	}
	if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionNone {
		t.Errorf("action = %q, want %q — an unsettled run must keep the caller parked", action, ActionNone)
	}
}

// TestSettleThreadRunStampsTheInvocationMessage proves the outcome is stored on
// the message that started the run, where the wire reads it to pair this run's
// tool_use with this run's tool_result — and that settling twice does not
// re-stamp a run that has already reported.
func TestSettleThreadRunStampsTheInvocationMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", userMessage: "do it"})
	w.thread.itemID = threadID
	w.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.insertTargetMessage(w.getTargetItemsLength(), ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "All done.",
	})

	w.settleThreadRun(threadID, false)

	ycrdtMu.Lock()
	status, result := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadID))
	ycrdtMu.Unlock()
	if status != runStatusRest || result != "All done." {
		t.Fatalf("run record = (%q, %q), want (%q, %q)", status, result, runStatusRest, "All done.")
	}

	// A second settle finds no open run and leaves the record alone.
	w.insertTargetMessage(w.getTargetItemsLength(), ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Something later.",
	})
	w.settleThreadRun(threadID, false)
	ycrdtMu.Lock()
	status, result = latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadID))
	ycrdtMu.Unlock()
	if status != runStatusRest || result != "All done." {
		t.Errorf("settled run was re-stamped: (%q, %q)", status, result)
	}
}

// TestRunWithNothingToStampStillReports covers the child that has no message to
// stamp at all: a creation that appended no invocation message. The run's
// outcome has nowhere to live but the thread's `result`, which is then the only
// completion signal the thread has — so an ending other than rest must still
// write it, or the caller parks on hasIncompleteThreads forever, liveThreadCount
// counts the child for good, and the desktop quit guard reads it as executing.
func TestRunWithNothingToStampStillReports(t *testing.T) {
	cases := []struct {
		name      string
		cancelled bool
		trailing  ConversationItem
	}{
		{"error", false, ConversationItem{Type: ItemTypeError, ItemID: "e-1", Content: "invalid request: bad model"}},
		{"cancelled", true, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Got partway."}},
		{"barren", false, ConversationItem{Type: ItemTypeMetaToolResult, ItemID: "m-1", ToolName: "drop_context_items"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()

			threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", llmCreated: true})
			w.thread.itemID = threadID
			w.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
			w.insertTargetMessage(w.getTargetItemsLength(), tc.trailing)

			w.settleThreadRun(threadID, tc.cancelled)

			if result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); result == "" {
				t.Fatalf("the run reported nothing anywhere — its caller waits on a run that can never report")
			}
			w.resetThreadContext()
			items := append([]ConversationItem{{Type: ItemTypeUser, Content: "start"}}, w.doc.GetItems()...)
			if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionCallLLM {
				t.Errorf("action = %q, want %q — a parked caller must resume", action, ActionCallLLM)
			}
		})
	}
}

// TestFoldRunSettlesNothing pins that a bounded-compaction fold is left alone by
// the settle path. Its summarisation prompt is an unstamped user item, so the
// starter search would find it and record a run outcome that describes nothing:
// a fold is a container of folded transcript, and every decider asks whether it
// has its summary by reading `result`.
func TestFoldRunSettlesNothing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Compacted conversation history", boundedCompaction: true})

	w.settleThreadRun(threadID, false)

	for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
		if it.RunStatus != "" {
			t.Errorf("fold item %s was stamped runStatus=%q; a fold records no runs of its own",
				it.ItemID, it.RunStatus)
		}
	}
	if result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); result != "" {
		t.Errorf("the settle path wrote a fold's summary (%q); that belongs to the compaction path", result)
	}
}

// TestInterjectedMessageDoesNotStrandTheRun covers a human typing into a child
// whose delegated run is still in flight. The loop promotes that message
// mid-run and absorbs it into the same run, so the trailing user item at settle
// is the interjection rather than the call that started everything. Stamping
// the trailing item would leave the invocation message carrying the tool-use
// coordinates unstamped for good: the caller's tool_use would stay paired with
// the pending placeholder while the run's real reply sat somewhere the wire
// never reads. Every child column has a live composer, so this is one keystroke
// away.
func TestInterjectedMessageDoesNotStrandTheRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", llmCreated: true, delegated: true})
	w.thread.itemID = threadID
	w.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)

	appendItem := func(item ConversationItem) {
		w.insertTargetMessage(w.getTargetItemsLength(), item)
	}
	appendItem(ConversationItem{
		Type: ItemTypeUser, ItemID: "inv-1", Content: "find the auth bug",
		RunToolUseID: "tu-1", RunToolName: "Explore",
		RunToolInput: json.RawMessage(`{"prompt":"find the auth bug"}`),
	})
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Looking."})
	appendItem(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "check the tests too"})
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "It is in the token refresh."})

	w.settleThreadRun(threadID, false)

	var invocation, interjection ConversationItem
	for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
		switch it.ItemID {
		case "inv-1":
			invocation = it
		case "human-1":
			interjection = it
		}
	}
	if invocation.RunStatus != runStatusRest || invocation.RunResult != "It is in the token refresh." {
		t.Fatalf("invocation message run record = (%q, %q), want (%q, %q)",
			invocation.RunStatus, invocation.RunResult, runStatusRest, "It is in the token refresh.")
	}
	// The message the run absorbed carries the same outcome, so the trailing
	// item runSettlement reads does not report an unanswered message.
	if interjection.RunStatus != runStatusRest {
		t.Errorf("the interjection carries runStatus %q, want %q — the thread would read as still working",
			interjection.RunStatus, runStatusRest)
	}

	// What the caller reads: its own tool_use paired with the run's reply, not
	// the placeholder that says the run never reported.
	var thread ConversationItem
	for _, it := range w.doc.GetItems() {
		if it.ItemID == threadID {
			thread = it
		}
	}
	if !threadRunSettled(thread) {
		t.Errorf("the thread reads as still working after its run settled — its caller would park forever")
	}
	msgs := appendThreadMessages(nil, thread, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected one tool_use/tool_result pair, got %+v", msgs)
	}
	content, _ := msgs[1]["content"].(string)
	if !strings.Contains(content, "It is in the token refresh.") {
		t.Errorf("tool_result = %q, want the run's reply", content)
	}
}

// TestSettledRunPairsTheWire closes the loop on what the caller actually reads:
// the run's stored result is what comes back as its tool_result, and a run
// still going gets the pending placeholder rather than borrowing the summary
// left by an earlier one.
func TestSettledRunPairsTheWire(t *testing.T) {
	settled := threadItemWithRun(t, runStatusRest, "Thread summary.")
	msgs := appendThreadMessages(nil, settled, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected a tool_use/tool_result pair, got %+v", msgs)
	}
	if content, _ := msgs[1]["content"].(string); !strings.Contains(content, "Thread summary.") {
		t.Errorf("tool_result = %q, want the run's result", content)
	}

	open := threadItemWithRun(t, "", "An older summary.")
	msgs = appendThreadMessages(nil, open, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected a tool_use/tool_result pair, got %+v", msgs)
	}
	content, _ := msgs[1]["content"].(string)
	if strings.Contains(content, "An older summary.") {
		t.Errorf("a run in flight must not answer with an earlier run's reply; got %q", content)
	}
	if content != pendingToolResultPlaceholder {
		t.Errorf("tool_result = %q, want the pending placeholder", content)
	}
}
