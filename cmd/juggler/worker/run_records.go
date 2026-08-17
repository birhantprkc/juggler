//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"

	ycrdt "github.com/skyterra/y-crdt"
)

// A thread is a sequence of RUNS over one accumulating transcript. A run is one
// message appended to the thread, the tool loop that message drives, and the
// rest at the end of it: many LLM calls, one outcome. The message that starts a
// run carries that run's record — runStatus/runResult once it settles, plus the
// parent's tool-use coordinates when the run was started by a delegating call.
//
// The record is what tells every decider "is this child finished?". The thread's
// `result` field cannot answer that: it is the thread's current SUMMARY, which
// survives across runs, so a thread that has run five times and is about to run
// a sixth carries a result and is not finished. Per-run state has to live per
// run.
//
// The question is asked per CALL, not per thread: a caller parks on the run it
// started (itemRunSettled), because a session resumed by somebody else's later
// call is finished as far as the earlier call is concerned. The parent names the
// run it means with a selector on its own item — the same coordinates, read from
// the other end (ConversationItem.AliasOf).
//
// The LAST of the parent's items referring to a session is the exception, and
// tracks the session rather than one run of it (isTrailingViewOf). Nothing else
// stands for a run a human started by typing into a stopped child: that run has
// no invocation message and no call behind it, so the item still waiting on the
// thread is the only place it can report. Everything above it stays frozen,
// which is what keeps the committed wire from moving.
//
// The outcome is stored rather than re-derived because a run's trailing items
// are user-editable and deletable: the wire must still reconstruct a stable
// tool_use/tool_result pair for a run whose transcript has since been edited.
const (
	// runStatusRest — the run came to rest on clean trailing assistant text.
	runStatusRest = "rest"
	// runStatusError — the run stopped on an error item.
	runStatusError = "error"
	// runStatusCancelled — the run was cancelled or interrupted. Also written
	// browser-side (conversation.js) when a stop settles a thread the worker is
	// not currently driving; keep the two spellings in step.
	runStatusCancelled = "cancelled"
	// runStatusBarren — the run settled with nothing clean to return.
	runStatusBarren = "barren"
)

const (
	// runCancelledNote is the run result for a cancelled run, appended to
	// whatever the run had produced by then.
	runCancelledNote = "[The run was cancelled before it finished.]"
	// runBarrenNote is the run result for a run that settled without a reply.
	runBarrenNote = "The run ended without producing a reply."
)

// isInvocationMessage reports whether an item is the message that started a
// delegated run: a user message stamped with the calling tool's coordinates.
//
// The type is part of the test. A thread item carries the same three
// coordinates to mean its run SELECTOR (which run of that thread this item is
// the parent's view of — see ConversationItem.AliasOf), and a child thread
// standing in a transcript is not a call made into the transcript holding it.
func isInvocationMessage(it ConversationItem) bool {
	return it.Type == ItemTypeUser && it.RunToolUseID != ""
}

// lastInvocationIndex returns the position of a thread's most recent invocation
// message, or -1 when it has none.
//
// That message is the one item a compaction fold may not take (both fold paths
// pin it). Everything about the thread's current state is read off it: the
// settling run's outcome is stamped there (openRunStarterLocked), and both
// runSettlement and its live-CRDT twin decide "is this child finished?" by
// walking back to it. Fold it away and a run in flight would never settle, and
// a session whose runs have only ever errored would read as busy forever —
// refusing the resume the whole feature exists for.
//
// Earlier invocation messages carry no such live state. Their records are
// copied onto the fold that swallows them (foldedRunsIn), so folding one costs
// the transcript nothing, and the run bodies between them — which is what a
// long-lived session actually needs compacted — fold as one contiguous stretch
// rather than one stranded slice per call.
func lastInvocationIndex(items []ConversationItem) int {
	for i := len(items) - 1; i >= 0; i-- {
		if isInvocationMessage(items[i]) {
			return i
		}
	}
	return -1
}

// foldedRunsIn collects the run records a fold about to replace items must
// carry forward, in the order they stand in the transcript: each invocation
// message's own record, and every record an earlier fold in the range is
// already carrying.
//
// Reading the earlier fold's records is what makes repeated folds converge. A
// fold nests a prior summarized fold in its condensed form (condenseForRefold),
// which keeps foldedRuns and drops everything else, so each pass leaves ONE
// fold carrying every call the thread has ever taken rather than a chain of
// them.
func foldedRunsIn(items []ConversationItem) []FoldedRun {
	var runs []FoldedRun
	for _, it := range items {
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			runs = append(runs, it.FoldedRuns...)
			continue
		}
		if !isInvocationMessage(it) {
			continue
		}
		runs = append(runs, FoldedRun{
			ToolUseID: it.RunToolUseID,
			ToolName:  it.RunToolName,
			ToolInput: it.RunToolInput,
			Status:    it.RunStatus,
			Result:    it.RunResult,
		})
	}
	return runs
}

// threadNestedItems deserialises a thread item's nested items, or nil for a
// non-thread/empty/unreadable one.
func threadNestedItems(item ConversationItem) []ConversationItem {
	if item.Type != ItemTypeThread || len(item.Items) == 0 {
		return nil
	}
	var nested []ConversationItem
	if err := json.Unmarshal(item.Items, &nested); err != nil {
		return nil
	}
	return nested
}

// threadRunSettled reports whether a thread's most recent run has settled — the
// single "is this child finished?" question every decider asks.
//
// A thread whose transcript carries no run record at all answers from `result`
// instead: a user-created thread summarised from the footer, and every document
// written before run records existed, record completion only there. The run
// record is consulted FIRST so that a thread which is invoked again after
// carrying a summary still reads as running.
//
// A compaction fold is the exception: it is not a run but a container of folded
// transcript, and "has the summariser committed yet" is asked of `result`
// directly (pendingCompactionFold asks it the same way). A fold routinely holds
// swallowed invocation messages, and reading its contents as runs would take
// one of those for the fold's own — leaving it a child that never finishes.
func threadRunSettled(item ConversationItem) bool {
	if !item.BoundedCompaction {
		if settled, hasRuns := runSettlement(threadNestedItems(item)); hasRuns {
			return settled
		}
	}
	return hasThreadResult(item)
}

// resolveAliasTarget returns the canonical thread item an alias names, from the
// array it stands in. An alias and its canonical are always siblings: a session
// is scoped to the thread that called it (sessionsInCallingThread), so a resume
// can only ever be issued from the array the thread already sits in.
//
// A compaction fold cannot separate them either. It relocates a contiguous run
// reaching the end of the transcript, so a canonical and every alias after it
// move together; and once a thread has been folded away, sessionsInCallingThread
// no longer finds its name, so no later call can add an alias to a thread that
// is no longer a sibling. Deletion is the one way to break the pairing, and the
// browser deletes a thread's aliases with it.
func resolveAliasTarget(siblings []ConversationItem, item ConversationItem) (ConversationItem, bool) {
	if item.AliasOf == "" {
		return ConversationItem{}, false
	}
	for _, sibling := range siblings {
		if sibling.Type == ItemTypeThread && sibling.AliasOf == "" && sibling.ItemID == item.AliasOf {
			return sibling, true
		}
	}
	return ConversationItem{}, false
}

// isTrailingViewOf reports whether item is the LAST of the parent's items
// referring to a session — the canonical thread and its aliases are the whole
// set, and they always stand in one array (resolveAliasTarget).
//
// That item is the session's live view: it shows the run the transcript is on
// now, whoever started it. Every earlier item is a receipt for the one call it
// was made by, frozen when that run settled. The split is what lets a human
// resume a stopped child and have the answer reach the call that is waiting for
// it, without a later result ever rewriting a tile further up the transcript.
func isTrailingViewOf(siblings []ConversationItem, item ConversationItem, canonicalID string) bool {
	for i := len(siblings) - 1; i >= 0; i-- {
		s := siblings[i]
		if s.Type != ItemTypeThread {
			continue
		}
		if s.ItemID != canonicalID && s.AliasOf != canonicalID {
			continue
		}
		return s.ItemID == item.ItemID
	}
	return false
}

// trailingRunOutcome returns the outcome of the run a transcript is currently
// on, and whether it records one at all. Empty status means that run is still
// going.
//
// It reads the LAST user item rather than the run's invocation message because
// settleThreadRun stamps the same outcome onto every message the run gathered
// (openRunMessagesLocked), so the trailing one always carries it — and it is
// the item runSettlement asks about, which keeps the two answers in step.
//
// It requires no run selector, which is the point: a run a human started by
// typing into the thread is recorded on a plain user message, so threadRunRecords
// does not see it. Reading the message rather than the record is what lets the
// live view show work no call asked for.
func trailingRunOutcome(items []ConversationItem) (status, result string, ok bool) {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Type == ItemTypeUser {
			return items[i].RunStatus, items[i].RunResult, true
		}
	}
	return "", "", false
}

// itemRunCall builds the tool-use coordinates a thread item's run selector
// names, in the fields buildToolUseMap reads.
func itemRunCall(item ConversationItem) ConversationItem {
	return ConversationItem{
		ToolUseID: item.RunToolUseID,
		ToolName:  item.RunToolName,
		ToolInput: item.RunToolInput,
	}
}

// itemThreadRun resolves the run a thread item stands for: the canonical thread
// holding the transcript, that run's outcome, and its 1-based call number.
// Reports false for an item with no run selector, for an alias whose canonical
// is gone, and for a selector naming a run the transcript no longer records.
//
// Which run that is depends on where the item stands. The LAST of the parent's
// items referring to a session is its live view and answers for the run the
// transcript is on now (isTrailingViewOf); every earlier item answers for the
// one run its selector names, frozen where that run settled. So a session
// resumed by a later call reports to the item that call appended, and a session
// resumed by a human — whose run no call named at all — reports to the item
// still waiting on it, rather than to nobody.
//
// The live view borrows the OUTCOME only. Its tool-use coordinates, its goal and
// its call number stay its own, because it is still the parent's view of the
// call it made: the emitted tool_use id must keep matching the one already
// committed to the parent's history.
func itemThreadRun(siblings []ConversationItem, item ConversationItem) (canonical ConversationItem, run threadRun, call int, ok bool) {
	if item.Type != ItemTypeThread || item.RunToolUseID == "" {
		return ConversationItem{}, threadRun{}, 0, false
	}
	canonical = item
	if item.AliasOf != "" {
		if canonical, ok = resolveAliasTarget(siblings, item); !ok {
			return ConversationItem{}, threadRun{}, 0, false
		}
	}
	run, call, ok = runByToolUseID(canonical, item.RunToolUseID)
	if isTrailingViewOf(siblings, item, canonical.ItemID) {
		if status, result, recorded := trailingRunOutcome(threadNestedItems(canonical)); recorded {
			if !ok {
				// A selector no record answers still stands for a call that was
				// made, so it is numbered after the ones that are recorded.
				call = len(threadRunRecords(canonical)) + 1
			}
			return canonical, threadRun{call: itemRunCall(item), status: status, result: result}, call, true
		}
	}
	if !ok {
		return canonical, threadRun{}, 0, false
	}
	return canonical, run, call, true
}

// runByToolUseID returns the canonical's run matching a selector, and its
// 1-based call number.
func runByToolUseID(canonical ConversationItem, toolUseID string) (threadRun, int, bool) {
	if toolUseID == "" {
		return threadRun{}, 0, false
	}
	for i, run := range threadRunRecords(canonical) {
		if run.call.ToolUseID == toolUseID {
			return run, i + 1, true
		}
	}
	return threadRun{}, 0, false
}

// itemRunSettled reports whether the run THIS item stands for has settled.
//
// A thread item stamped with a run selector answers for the run it stands for,
// wherever the transcript now is: an alias resolves to the canonical item
// standing earlier in the same array and reads the record there. A caller parks
// on the call it made, not on whatever the thread most recently did — a session
// resumed by a LATER CALL is finished as far as the earlier call is concerned,
// because that call has an item of its own to wait on it. The last item
// referring to the thread has no such successor, so it follows the session back
// into work when a human resumes it (itemThreadRun).
//
// A selector that resolves to nothing — the canonical deleted, or the run's
// record edited away — is settled: the wire answers such a call with an error
// rather than a placeholder, so there is nothing left to wait for. The one
// exception is a canonical whose transcript records no run at all, which is a
// thread mid-creation; that falls through to threadRunSettled, which reads it as
// still working.
//
// An item with no selector (a user- or strategy-created thread, a fold, every
// document written before aliases) falls back to threadRunSettled, which asks
// the thread's latest run and then its result.
func itemRunSettled(siblings []ConversationItem, item ConversationItem) bool {
	if item.Type == ItemTypeThread && item.RunToolUseID != "" {
		canonical, run, _, ok := itemThreadRun(siblings, item)
		if ok {
			return run.status != ""
		}
		if canonical.ItemID == "" {
			return true // the alias names a thread that is gone
		}
		if len(threadRunRecords(canonical)) > 0 {
			return true // the selector names a run the transcript no longer holds
		}
		return threadRunSettled(canonical)
	}
	if item.AliasOf != "" {
		return true // an alias with no selector stands for no run
	}
	return threadRunSettled(item)
}

// runSettlement reports whether the trailing run in items has settled, and
// whether items records any run at all. A run is settled when the message that
// started it — the trailing user item — carries a runStatus.
//
// Only user items count as run records here: a nested thread item may carry the
// same coordinates as its own run selector, and counting one would answer this
// thread's liveness with a question about a child's.
func runSettlement(items []ConversationItem) (settled, hasRuns bool) {
	seenStarter := false
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if it.Type == ItemTypeUser && (it.RunStatus != "" || it.RunToolUseID != "") {
			hasRuns = true
		}
		if !seenStarter && it.Type == ItemTypeUser {
			seenStarter = true
			settled = it.RunStatus != ""
		}
		if hasRuns && seenStarter {
			break
		}
	}
	return settled, hasRuns
}

// threadRunSettledLocked is threadRunSettled against the live CRDT, for the
// deciders that hold a thread's Y.Map rather than a serialised item. Caller MUST
// hold ycrdtMu.
func threadRunSettledLocked(threadYMap *ycrdt.YMap) bool {
	if threadYMap == nil {
		return false
	}
	if bounded, _ := threadYMap.Get("boundedCompaction").(bool); !bounded {
		nested, _ := threadYMap.Get("items").(*ycrdt.YArray)
		if settled, hasRuns := runSettlementLocked(nested); hasRuns {
			return settled
		}
	}
	result, _ := threadYMap.Get("result").(string)
	return result != ""
}

// runSettlementLocked is runSettlement against the live CRDT. Caller MUST hold
// ycrdtMu.
func runSettlementLocked(nested *ycrdt.YArray) (settled, hasRuns bool) {
	if nested == nil {
		return false, false
	}
	seenStarter := false
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		itemType, _ := m.Get("type").(string)
		status, _ := m.Get("runStatus").(string)
		// Only user items carry run records; a nested thread item's identical
		// coordinates are its own run selector (ConversationItem.AliasOf).
		if itemType == ItemTypeUser {
			if status != "" {
				hasRuns = true
			} else if coordinates, _ := m.Get("runToolUseId").(string); coordinates != "" {
				hasRuns = true
			}
		}
		if !seenStarter && itemType == ItemTypeUser {
			seenStarter = true
			settled = status != ""
		}
		if hasRuns && seenStarter {
			break
		}
	}
	return settled, hasRuns
}

// latestRunOutcomeLocked returns the status and result stored on the thread's
// most recent settled run. Empty status means no run has settled. Caller MUST
// hold ycrdtMu.
func latestRunOutcomeLocked(threadYMap *ycrdt.YMap) (status, result string) {
	if threadYMap == nil {
		return "", ""
	}
	nested, _ := threadYMap.Get("items").(*ycrdt.YArray)
	if nested == nil {
		return "", ""
	}
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if s, _ := m.Get("runStatus").(string); s != "" {
			r, _ := m.Get("runResult").(string)
			return s, r
		}
	}
	return "", ""
}

// openRunMessagesLocked returns the messages of the thread's current run — the
// user items standing after the last run to settle, newest first. Empty when
// that run has already settled, or when the thread has no message to stamp (an
// empty thread, or one continued with no new message). Caller MUST hold
// ycrdtMu.
//
// A run is usually one message, but not always: a human can type into a child
// while its run is in flight, and the loop promotes that message and absorbs it
// into the same run. The outcome is recorded on every message the run gathered,
// because two different readers need to find it. The INVOCATION message must
// carry it — that is where the tool-use coordinates live, so it is where the
// wire reads this call's result, and a run stamped anywhere else would leave
// the caller's tool_use paired with the pending placeholder for good. The
// TRAILING message must carry it too, because runSettlement asks that item
// whether the thread is still working, and an unstamped one reads as a message
// nobody has answered. With a single message — the ordinary case — they are the
// same item.
func openRunMessagesLocked(nested *ycrdt.YArray) []*ycrdt.YMap {
	if nested == nil {
		return nil
	}
	var open []*ycrdt.YMap
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if t, _ := m.Get("type").(string); t != ItemTypeUser {
			continue
		}
		if s, _ := m.Get("runStatus").(string); s != "" {
			break
		}
		open = append(open, m)
	}
	return open
}

// lastSettlingItem returns the item that decides how a run ended: the last one
// that either records a state transition (effectiveItems) or is an error.
// Errors are included here and excluded there because an error does not choose
// the next action — the reducer rests on it exactly as it rests on assistant
// text — but it does decide what the run returns.
func lastSettlingItem(items []ConversationItem) (ConversationItem, bool) {
	for i := len(items) - 1; i >= 0; i-- {
		switch items[i].Type {
		case ItemTypeUser, ItemTypeAssistant, ItemTypeToolAction,
			ItemTypeMetaToolResult, ItemTypeThread, ItemTypeError:
			return items[i], true
		}
	}
	return ConversationItem{}, false
}

// resolveRunOutcome classifies how a run ended and what it returns. Every
// ending resolves to a status and a non-empty result: a run that came to rest
// returns its trailing assistant text, a run that stopped on an error returns
// the error text, a cancelled one returns whatever it had produced plus the
// reason, and one that settled with nothing clean says so. Nothing is
// fabricated, and no ending yields silence — an unpaired tool_use is
// wire-invalid, so a parent that called into this thread must always get
// something back.
func resolveRunOutcome(items []ConversationItem, cancelled bool) (status, result string) {
	if cancelled {
		if text := selectThreadFallbackResult(items); text != "" {
			return runStatusCancelled, text + "\n\n" + runCancelledNote
		}
		return runStatusCancelled, runCancelledNote
	}
	if last, ok := lastSettlingItem(items); ok && last.Type == ItemTypeError {
		if last.Content != "" {
			return runStatusError, last.Content
		}
		return runStatusError, "The run stopped on an error."
	}
	if text := selectThreadFallbackResult(items); text != "" {
		return runStatusRest, text
	}
	return runStatusBarren, runBarrenNote
}

// stampRunOutcome records an outcome the run itself cannot describe — a panic
// unwinding the worker — onto the message that started the thread's current
// run. Reports whether there was an open run to stamp. It writes no summary:
// the thread's own transcript carries the failure, and passing it off as the
// thread's result would be a lie the tile then repeats.
func (w *ConversationWorker) stampRunOutcome(threadItemID, status, result string) bool {
	if threadItemID == "" {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		return false
	}
	nested, _ := threadYMap.Get("items").(*ycrdt.YArray)
	open := openRunMessagesLocked(nested)
	if len(open) == 0 {
		return false
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, m := range open {
			m.Set("runStatus", status)
			m.Set("runResult", result)
		}
	}, w.doc.authorID)
	return true
}

// settleThreadRun records how the run that just ended on threadItemID came out:
// runStatus/runResult onto the message that started it, and — for a run that
// came to rest — the same text onto the thread as its current summary.
//
// This is the sole producer of the completion signal every parked decider
// waits on, so it runs at EVERY ending: rest, error, and cancellation alike.
// A parked tool approval is not an ending — the child is still live and the
// caller stays parked, which is why the strategy loop returns before reaching
// here while an approval is outstanding.
//
// Only a resting run stamps the summary. An error, a cancellation or a barren
// end returns its text to the caller but leaves the tile's summary alone rather
// than passing failure off as a result. There is no other writer and no way to
// pin different words: a thread's summary is the last thing it said, so a
// different summary is a message away.
//
// A bounded-compaction fold settles nothing here. It is not a run but a
// container of folded transcript: its summary is written through the compaction
// path, and every decider asks whether it has one by reading `result` directly
// (threadRunSettled, pendingCompactionFold). Stamping its summarisation prompt
// with a run outcome would write a wrong-meaning record into the document on
// every /compact, /handoff and auto-compaction.
func (w *ConversationWorker) settleThreadRun(threadItemID string, cancelled bool) {
	if threadItemID == "" {
		return
	}

	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		return
	}
	if boundedCompaction, _ := threadYMap.Get("boundedCompaction").(bool); boundedCompaction {
		ycrdtMu.Unlock()
		return
	}
	nested, _ := threadYMap.Get("items").(*ycrdt.YArray)
	threadResult, _ := threadYMap.Get("result").(string)

	var items []ConversationItem
	if nested != nil {
		items = w.doc.getItemsFromArrayLocked(nested)
	}
	status, result := resolveRunOutcome(items, cancelled)
	open := openRunMessagesLocked(nested)
	_, recordsRun := runSettlementLocked(nested)

	// A run with no message to stamp reports through `result` or not at all: a
	// creation that appended no invocation message (a continuation, or a call
	// that supplied no prompt) records a run nowhere else, so a caller parked on
	// this child would be waiting on a run that can never report. That case
	// writes whatever the run came to; every other ending keeps failure out of
	// the summary.
	orphanRun := len(open) == 0 && !recordsRun
	summarises := status == runStatusRest || orphanRun

	if len(open) == 0 && !summarises {
		ycrdtMu.Unlock()
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, m := range open {
			m.Set("runStatus", status)
			m.Set("runResult", result)
		}
		if summarises && result != threadResult {
			threadYMap.Set("result", result)
		}
	}, w.doc.authorID)
	ycrdtMu.Unlock()

	w.log.Info("[worker] Thread %s run settled: %s (%d chars)", threadItemID, status, len(result))
}
