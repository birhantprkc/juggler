//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"strings"
	"testing"
)

// runOnThread points a worker's run at a thread and binds its budget to
// whatever run that thread currently has open, as a turn boundary does.
func runOnThread(w *ConversationWorker, threadItemID string) *run {
	r := w.currentRun()
	r.t.thread.itemID = threadItemID
	r.t.thread.itemsArray = w.doc.GetThreadItemsArray(threadItemID)
	r.syncRunBudget()
	return r
}

// spendTurns charges n completed round-trips to the run's budget.
func spendTurns(r *run, n int) {
	for i := 0; i < n; i++ {
		r.noteRunTurn()
	}
}

// TestRunBudgetGovernsOnlyLeafChildren pins WHO the turn budget applies to, and
// what it does when it lands.
//
// The budget is the only limit here that touches the tokens a fan-out actually
// spends: the children in the incident ran 13, 18, 24 and 27 turns, and their
// input per turn climbed from 12k to 300k as each transcript grew. Width caps
// bound how many children there are; only this bounds how far one of them runs.
//
// Who it applies to is the whole safety argument. It governs a leaf worker an
// LLM opened and nothing else: never the root thread, never a thread a person
// created or has taken over, because a budget on those would interrupt the
// human's own work — and a person can see how long their thread has been
// running and stop it themselves. An agent nobody is watching cannot.
func TestRunBudgetGovernsOnlyLeafChildren(t *testing.T) {
	tools := []ToolDefinition{{Name: "read"}, {Name: "grep"}}

	cases := []struct {
		name      string
		build     func(*ConversationWorker) string
		turns     int
		wantSpent bool
	}{
		{"a leaf child at its budget", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
		}, runTurnBudget, true},
		{"a leaf child one turn short", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
		}, runTurnBudget - 1, false},
		{"a leaf child well past its budget", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
		}, runTurnBudget * 3, true},
		{"a thread a human is steering", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Mine", llmCreated: true, canSpawnThreads: true})
		}, runTurnBudget * 3, false},
		{"a thread nobody's agent created", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Compaction"})
		}, runTurnBudget * 3, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			threadID := tc.build(w)
			r := runOnThread(w, threadID)
			spendTurns(r, tc.turns)

			if got := r.runBudgetSpent(); got != tc.wantSpent {
				t.Fatalf("runBudgetSpent after %d turns = %v, want %v", tc.turns, got, tc.wantSpent)
			}

			// The budget lands by taking the tools away: a turn with nothing to
			// call has to answer, which is the report the caller is waiting for.
			got := r.filterToolsForThread(tools)
			if tc.wantSpent && len(got) != 0 {
				t.Errorf("tools offered = %d at a spent budget, want none — a child handed tools keeps working",
					len(got))
			}
			if !tc.wantSpent && len(got) != len(tools) {
				t.Errorf("tools offered = %d, want all %d: the budget must not touch this thread",
					len(got), len(tools))
			}
		})
	}

	t.Run("the root thread is never budgeted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		r := runOnThread(w, "")
		spendTurns(r, runTurnBudget*3)
		if r.runBudgetSpent() {
			t.Fatal("root is the user's own thread; a budget there would stop the work they are watching")
		}
		if got := r.filterToolsForThread(tools); len(got) != len(tools) {
			t.Errorf("root tools = %d, want all %d", len(got), len(tools))
		}
	})
}

// TestRunBudgetIsPerRunNotPerThread pins the reset. A session is called again
// and again — the whole point of a resumable child — so a counter that only ever
// climbed would spend the budget on call one and hand every later call a child
// that could not use a tool. The budget is a bound on ONE run's length.
func TestRunBudgetIsPerRunNotPerThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)
	invocation := func(id, text string) {
		r.appendTargetMessage(ConversationItem{
			Type: ItemTypeUser, ItemID: id, Content: text,
			RunToolUseID: "tu-" + id, RunToolName: "Explore",
		})
	}

	// Call one spends the whole budget and settles.
	invocation("inv-1", "find it")
	r.syncRunBudget()
	spendTurns(r, runTurnBudget)
	if !r.runBudgetSpent() {
		t.Fatal("the budget should be spent after its last turn")
	}
	r.appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Here is what I found.",
	})
	w.settleThreadRun(threadID, false)

	// Call two appends its own invocation message, which is a different run —
	// and so a whole budget, without anything having to remember to clear one.
	invocation("inv-2", "now check the tests")
	r.syncRunBudget()

	if got := r.t.runBudget.turns; got != 0 {
		t.Errorf("turns = %d at the start of the next call, want 0 — each call into a session gets a whole budget",
			got)
	}
	if r.runBudgetSpent() {
		t.Error("a resumed child must be able to run again with tools")
	}
	if got := r.filterToolsForThread([]ToolDefinition{{Name: "read"}}); len(got) != 1 {
		t.Errorf("tools offered on the new run = %d, want 1", len(got))
	}
}

// TestRunBudgetLandsOnceWithANotice pins the soft landing. Withholding the tools
// alone would leave the model to work out why its next call vanished; being told
// is what turns a hard stop into a report. It is said exactly once, at the turn
// the budget runs out, because a notice repeated every turn afterwards would be
// the loudest thing in the child's context.
func TestRunBudgetLandsOnceWithANotice(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Explore", llmCreated: true})
	r := runOnThread(w, threadID)

	notices := func() int {
		n := 0
		for _, it := range threadItems(w, threadID) {
			if it.Type == ItemTypeSystemReminder && strings.Contains(it.Content, runBudgetNoticeMarker) {
				n++
			}
		}
		return n
	}

	// Short of the budget there is nothing to say.
	spendTurns(r, runTurnBudget-1)
	r.announceRunBudgetSpent()
	if got := notices(); got != 0 {
		t.Fatalf("notices = %d below the budget, want 0", got)
	}

	// At the budget it is said once, however many times the turn boundary is
	// re-entered — the reducer re-dispatches a parked run, and each re-entry
	// passes this point.
	spendTurns(r, 1)
	r.announceRunBudgetSpent()
	r.announceRunBudgetSpent()
	if got := notices(); got != 1 {
		t.Fatalf("notices = %d at the budget, want exactly 1", got)
	}

	// And it is not repeated by the turns that follow it.
	spendTurns(r, 1)
	r.announceRunBudgetSpent()
	if got := notices(); got != 1 {
		t.Errorf("notices = %d after a further turn, want the single one", got)
	}

	// A system reminder, never a user message: a user item here would be taken
	// for the message that started the run and stamped with its outcome.
	for _, it := range threadItems(w, threadID) {
		if strings.Contains(it.Content, runBudgetNoticeMarker) && it.Type != ItemTypeSystemReminder {
			t.Errorf("the notice is a %s item; it must be a system reminder", it.Type)
		}
	}
}
