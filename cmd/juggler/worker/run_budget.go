//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// The per-run turn budget.
//
// maxThreadDepth bounds how deep delegation goes, maxLiveThreads how wide, and
// maxConcurrentReadOnlyThreads how much of that width runs at once. None of them
// bounds how far a single child runs, and that is where the tokens are: a
// sub-agent's input grows with its own transcript, so turn 25 costs many times
// turn 1, and the last few turns of a long run cost more than all the early ones
// together. A fan-out of four children that each ran to exhaustion spent 13.8M
// input tokens in ten minutes, about half of it past this budget.
//
// The budget governs a LEAF WORKER an LLM opened, and nothing else — never the
// root thread, never a thread a person created or has taken over. That is not a
// technicality but the point: a human watching their own thread can see it
// running long and stop it, and interrupting them to save tokens they chose to
// spend would be the tool overruling its user. An agent nobody is watching has
// no such brake, so it is given one.
//
// It is per RUN, not per thread. A session is meant to be called again — that is
// what makes a warm child cheaper than a fresh one — so each call gets a whole
// budget.

// runTurnBudget is how many completed LLM round-trips one run of a leaf child
// may take before it is asked to report.
//
// Twelve because it is where the curve turns: replayed against the incident,
// stopping each child at twelve turns retains roughly half of what those runs
// spent, while still being more turns than most sub-agent work ever uses — the
// ordinary Explore answers in three or four. Below about eight the budget starts
// landing on questions that legitimately need the room, and a report written
// under duress is one the caller has to ask for again.
const runTurnBudget = 12

// runBudgetNoticeMarker is the phrase the budget notice is recognised by — in
// the child's transcript, by a reader, and in tests. Its own constant because
// the notice must stay identifiable as one after the wording changes.
const runBudgetNoticeMarker = "turn budget"

// runBudgetNotice is what the child is told at the moment its budget runs out.
//
// Withholding the tools is the mechanism, but on its own it is a silent one: the
// model would reach for a tool, find it gone, and be left to infer why. Saying it
// plainly is what turns a hard stop into a landing — the run's last turn is then
// a deliberate report rather than a sentence cut off, which is the difference
// between the caller getting an answer and getting wreckage.
func runBudgetNotice() string {
	return fmt.Sprintf("This run has used its %s (%d turns), so no further tools will be offered. "+
		"Give your report now from what you already have: answer what you can, and say plainly what you "+
		"could not finish and what you would do next.", runBudgetNoticeMarker, runTurnBudget)
}

// runBudgetState is what one run's budget amounts to: how many turns it has
// taken, whether it has been told they are spent, and which run that is true of.
//
// It is turn state, carried between a run's dispatches by the same turnBoundary
// mechanism as every other "state one logical turn carries between its LLM runs"
// — not a field on the thread's Y.Map. The document is a persisted CRDT synced to
// every viewer, and a counter there wrote once per thread per turn: a sync round
// to every client for bookkeeping nobody reads, landing BETWEEN the items a turn
// produces, which split the coalesced sync the client's auto-selection reads as
// one batch. A sub-thread then auto-selected a seeded context item instead of the
// tool-action it should have shown. A count about a run in flight belongs to the
// worker running it.
//
// starter is what makes it self-correcting. It names the message that began the
// run being counted (the same item settleThreadRun stamps), so the count is
// bound to one run rather than to a thread: when the boundary carries a count
// into a turn whose run has changed, the mismatch resets it. That covers every
// way a run can end — settled, cancelled, abandoned, or ended by a path that
// never came back through here — without a single reset call site to keep in
// step with them.
type runBudgetState struct {
	starter string
	turns   int
	told    bool
	// spendTold records that this run has been told the conversation's spend
	// ceiling has landed on it (announceSpendCeiling). It rides here because it
	// is the same kind of state for the same kind of reason: said once per run,
	// reset by the same starter mismatch, and belonging to the run rather than to
	// the document. The ceiling itself is conversation-wide and lives in spend.go.
	spendTold bool
}

// currentRunStarterID returns the item id of the message that started the
// thread's current run, or "" when no run is open. Same walk settleThreadRun
// uses to decide which message to stamp — openRunMessagesLocked returns the open
// messages newest-first, so the last is the one that began the run.
func (w *ConversationWorker) currentRunStarterID(threadItemID string) string {
	if threadItemID == "" {
		return ""
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadItemID)
	if m == nil {
		return ""
	}
	nested, _ := m.Get("items").(*ycrdt.YArray)
	open := openRunMessagesLocked(nested)
	if len(open) == 0 {
		return ""
	}
	id, _ := open[len(open)-1].Get("itemId").(string)
	return id
}

// syncRunBudget binds the budget to the run this turn is part of, starting a
// fresh one whenever that is a different run from the one counted so far.
//
// Called once at the top of each turn, before anything reads the budget, so
// everything downstream is a plain read of turn-local state on the goroutine
// that owns it.
func (r *run) syncRunBudget() {
	starter := r.currentRunStarterID(r.t.thread.itemID)
	if r.t.runBudget.starter != starter {
		r.t.runBudget = runBudgetState{starter: starter}
	}
}

// noteRunTurn charges one completed LLM round-trip to this run's budget.
func (r *run) noteRunTurn() {
	if r.t.thread.itemID == "" {
		return // root keeps no budget, so it counts nothing
	}
	r.t.runBudget.turns++
}

// runBudgetSpent reports whether this run has used its budget.
//
// The two document reads each exclude a thread the budget has no business
// governing: one no LLM opened (a /compact fold, an orchestrator dispatch, a
// thread the user made), and one a human has since taken over — canSpawnThreads
// is exactly the "a person is steering this" stamp promoteThreadSpawnCapable
// writes when someone types into a thread, so a thread being driven by hand is
// never interrupted by a budget meant for unattended work.
func (r *run) runBudgetSpent() bool {
	threadItemID := r.t.thread.itemID
	if threadItemID == "" {
		return false
	}
	if r.t.runBudget.turns < runTurnBudget {
		return false
	}
	if !r.doc.threadFlag(threadItemID, "llmCreated") {
		return false
	}
	return !r.doc.threadFlag(threadItemID, "canSpawnThreads")
}

// announceRunBudgetSpent appends the budget notice to the current thread, at the
// turn boundary where the budget ran out.
//
// Said once per run: a notice repeated every turn afterwards would end up the
// loudest thing in the child's context, and be read as a fresh instruction each
// time, which is the opposite of asking it to land. The flag records that rather
// than inferring it from the count, because a turn boundary is not the same
// thing as a turn — the reducer re-enters a parked run at the same count, which
// is how the notice went in twice before.
func (r *run) announceRunBudgetSpent() {
	if !r.runBudgetSpent() || r.t.runBudget.told {
		return
	}
	r.t.runBudget.told = true
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeSystemReminder,
		ItemID:    generateItemID(),
		Content:   runBudgetNotice(),
		Source:    "run budget",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	r.log.Info("[worker] thread %s reached its %d-turn run budget — tools withheld, asked to report",
		r.t.thread.itemID, runTurnBudget)
}
