//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"runtime/debug"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// ThreadAction is the reducer's decision for what the worker should do
// next given the current state of a MessageThread's items.
//
// The reducer is authoritative: decideNextAction is the pure decision
// function and tryReconcile dispatches the action it returns (call the
// LLM, complete a nested thread, or go idle). It runs at the top of the
// main event loop on every Yjs update, so the MessageThread's items are
// the single source of truth for what happens next.
type ThreadAction int

const (
	// ActionNone means the thread is at a resting state. Nothing for
	// the worker to do until items change again.
	ActionNone ThreadAction = iota

	// ActionCallLLM means the thread's last relevant item is a user
	// message or a completed tool batch, so the LLM should be called to
	// generate the next assistant turn.
	ActionCallLLM

	// ActionGoIdle means the thread's tools were all denied (cancelled)
	// while activity was "awaiting_llm". The reducer clears the activity
	// marker so the conversation returns to rest. Fires for both root
	// and nested threads — a denial is not a completion.
	ActionGoIdle
)

// String returns a human-readable action name for logging.
func (a ThreadAction) String() string {
	switch a {
	case ActionNone:
		return "None"
	case ActionCallLLM:
		return "CallLLM"
	case ActionGoIdle:
		return "GoIdle"
	default:
		return "Unknown"
	}
}

// decideNextAction is the reducer: a pure function over a thread's items,
// the current activity state from processingState, and whether this is
// the root thread. Returns the single next action the worker should take.
//
// Invariants:
//   - Pure. Reads its arguments only. Does not mutate anything.
//   - Idempotent: same inputs → same output.
//   - Does not consult worker in-memory flags (currentThreadItemID,
//     batchCompleteSignal, loopStoppedByDenial, etc.). Every decision
//     is derivable from items plus activity.
//
// The activity parameter (from processingState.activity in the Yjs doc)
// is what allows the reducer to distinguish "tools freshly completed,
// LLM call needed" (activity="awaiting_llm") from "tools completed long
// ago, conversation at rest" (activity=""). Without this, the reducer
// would re-dispatch after undo or after a previous LLM error.
func decideNextAction(items []ConversationItem, activity string, isRoot bool, explicitContinuation bool) ThreadAction {
	// In-flight guard: if an LLM call is already in progress, the
	// reducer must not launch another. It will re-fire when the call
	// finishes and activity is cleared.
	if activity == ActivityCallingLLM {
		return ActionNone
	}

	// Keep only items that affect the conversation flow. Thinking
	// blocks and context items (system-prompt, rule, tree, etc.) don't
	// drive the decision.
	effective := effectiveItems(items)
	if len(effective) == 0 {
		// If awaiting_llm, an LLM call was explicitly requested (e.g. a
		// continuation thread created with no seed prompt). Root threads
		// with no items have nothing to send — treat as idle.
		if activity == ActivityAwaitingLLM {
			if isRoot {
				return ActionGoIdle
			}
			return ActionCallLLM
		}
		return ActionNone
	}

	// Rule: if ANY tool-action in the thread is still non-terminal
	// (pending / approved / running / state-unset), rest. The
	// tool-action reducer (or the user's approval) will drive that
	// transition; the thread reducer re-fires when the result lands.
	// This covers both freshly-spawned tools and user-initiated retries
	// of older tools.
	for _, item := range effective {
		if item.Type == ItemTypeToolAction && !isToolTerminal(item) {
			return ActionNone
		}
	}

	// Inspect the effective last item to decide the next action.
	last := effective[len(effective)-1]

	// If awaiting_llm but the last effective item is an assistant message,
	// the tools were deleted (undo, user delete) unless this is an explicit
	// user-requested continuation. User messages and meta-tool-results are
	// valid triggers for CallLLM and should NOT clear the activity.
	if activity == ActivityAwaitingLLM && last.Type == ItemTypeAssistant {
		if explicitContinuation {
			return ActionCallLLM
		}
		return ActionGoIdle
	}

	switch last.Type {
	case ItemTypeError:
		// An error occurred (LLM failure, etc.). Rest by default — the user
		// must take action to proceed. But if continuation was explicitly
		// requested (activity="awaiting_llm"), allow the LLM to retry so
		// the "continue" button works after an error.
		if activity == ActivityAwaitingLLM {
			return ActionCallLLM
		}
		return ActionNone

	case ItemTypeUser:
		if activity == ActivityAwaitingLLM {
			return ActionCallLLM
		}
		return ActionNone

	case ItemTypeToolAction:
		// Only dispatch when activity="awaiting_llm" — this distinguishes a
		// fresh tool completion from a stale one after undo or a previous turn.
		if activity != ActivityAwaitingLLM {
			return ActionNone
		}
		batch := currentToolBatch(effective)
		// Guard: all tools in the batch must be terminal (completed or
		// cancelled) before the LLM can continue. In mock/fast mode the
		// reducer can fire before the browser has evaluated tool states
		// (pending/running/undefined). Without this gate, the LLM would
		// be called prematurely with missing tool results.
		for _, t := range batch {
			if !isToolTerminal(t) {
				return ActionNone // still in flight — wait
			}
		}
		if len(batch) > 0 && anyBatchCancelled(batch) {
			// At least one tool was denied. A denial stops the automatic
			// loop — the LLM shouldn't proceed with partial information on
			// its own. But an explicit user Continue means "proceed anyway",
			// so honour it (same as the assistant-last branch above);
			// otherwise clear the awaiting marker and rest.
			if explicitContinuation {
				return ActionCallLLM
			}
			return ActionGoIdle
		}
		return ActionCallLLM

	case ItemTypeMetaToolResult:
		if activity == ActivityAwaitingLLM {
			return ActionCallLLM
		}
		return ActionNone

	case ItemTypeAssistant:
		// Assistant text-only reply (no tool-actions after it). Rest at idle
		// for root AND nested threads alike: ending a turn with plain
		// assistant text is the normal open resting state of a thread, not a
		// close. A thread closes only when the LLM calls return_result (which
		// stamps the result) — or when the user closes it from the footer. A
		// turn that ends on an error rests the same way (see the ItemTypeError
		// case): the error is just an item in the thread's history, not a
		// verdict that closes the thread.
		return ActionNone

	case ItemTypeThread:
		// A nested thread is the effective last item.
		if hasThreadResult(last) {
			// Child finished. Only dispatch if activity signals intent
			// (same pattern as tool-batch completion). Without the gate,
			// undo would re-dispatch on a stale thread-with-result.
			if activity == ActivityAwaitingLLM {
				return ActionCallLLM
			}
			return ActionNone
		}
		// Child still in progress. Rest; the child's own reducer will
		// drive it, and when it writes its result the observer fires
		// on this thread again.
		return ActionNone

	default:
		return ActionNone
	}
}

// effectiveItems filters to only the item types that affect the
// thread-level reducer's decision. Everything else (thinking, context
// items like system-prompt/rule/tree) is skipped because those items
// do not encode a state transition.
func effectiveItems(items []ConversationItem) []ConversationItem {
	out := make([]ConversationItem, 0, len(items))
	for _, item := range items {
		switch item.Type {
		case ItemTypeUser,
			ItemTypeAssistant,
			ItemTypeToolAction,
			ItemTypeMetaToolResult,
			ItemTypeThread:
			out = append(out, item)
		}
	}
	return out
}

// currentToolBatch returns the contiguous trailing run of tool-actions
// at the end of items. Tool-actions are always inserted consecutively
// after the assistant message that requested them, so the current batch
// is the longest tool-action suffix.
func currentToolBatch(items []ConversationItem) []ConversationItem {
	end := len(items)
	start := end
	for start > 0 && items[start-1].Type == ItemTypeToolAction {
		start--
	}
	if start == end {
		return nil
	}
	return items[start:end]
}

// isToolTerminal returns true if a tool-action is in a state that will
// not transition further without external input. Only completed and
// cancelled are terminal; pending/approved/running/"" are in flight.
func isToolTerminal(t ConversationItem) bool {
	return t.State == StateCompleted || t.State == StateCancelled
}

// anyBatchCancelled returns true if at least one tool-action in the
// batch was cancelled (the user denied it). A single denial stops
// the turn — the LLM shouldn't proceed with partial tool results.
func anyBatchCancelled(batch []ConversationItem) bool {
	for _, t := range batch {
		if t.State == StateCancelled {
			return true
		}
	}
	return false
}

// hasThreadResult reports whether a thread item has completed and written its result.
// Thread Y.Maps store their result under the "result" key as a plain string.
func hasThreadResult(item ConversationItem) bool {
	if len(item.Result) == 0 {
		return false
	}
	// A missing field can deserialise as literal JSON "null"; treat that as "no result".
	return string(item.Result) != "null"
}

// reconcileThread is called from the document observer (handleItemsChange)
// on every Yjs update. Because the observer fires synchronously — even
// during a strategy-loop write — this method MUST NOT block. It just
// sets the needsReconcile flag; the main event loop's tryReconcile()
// dispatches the actual action at the top level.
func (w *ConversationWorker) reconcileThread() {
	w.needsReconcile = true
}

// updateApprovalWaitAnchor keeps the spinner's elapsed digit measuring active
// work, not the time the user spends deciding at a tool-approval prompt. It runs
// once per reconcile tick and acts only on the park/resume edges:
//
//   - Enter park (a tool pending, nothing executing): record when the wait began
//     and HIDE the digit (remove startedAt) — clients show no elapsed time while
//     awaiting approval.
//   - Resume to real work: advance startedAt forward by the wait just ended and
//     show it again, so the digit continues with the deliberation excluded.
//   - Park ended without resuming (cancel at the prompt): just clear the marker;
//     the idle transition drops startedAt anyway.
//
// An auto-approved tool goes Unevaluated→Approved without ever sitting pending,
// so the turn is never blockedOnlyByApprovals, no edge fires, and its timer keeps
// running. The deduction is computed from in-memory state alone (processingStartedAt
// + approvalWaitStartedAt); only the single derived startedAt field touches the doc.
func (w *ConversationWorker) updateApprovalWaitAnchor() {
	hasPending, hasExecuting := w.approvalBlockState()
	parked := hasPending && !hasExecuting
	if parked == w.wasBlockedOnApprovals {
		return // no edge this tick
	}
	w.wasBlockedOnApprovals = parked
	if w.processingStartedAt == 0 {
		return // no active turn to anchor
	}
	now := time.Now().UnixMilli()
	if parked {
		w.approvalWaitStartedAt = now
		w.hideElapsedAnchor()
		return
	}
	// Park ended. Exclude the wait only when real work resumed; on a cancel at
	// the prompt there is nothing to resume.
	waitStart := w.approvalWaitStartedAt
	w.approvalWaitStartedAt = 0
	if hasExecuting && waitStart != 0 {
		w.advanceElapsedAnchor(now - waitStart)
	}
}

// tryReconcile is called from the main event loop after every event. If
// the reducer has been tickled (needsReconcile=true), it evaluates the
// current thread's items, decides what action to take, and dispatches.
//
// Walk-down: if the reducer returns ActionNone because the last effective
// item is an incomplete child thread, tryReconcile walks into the child
// and evaluates it. This enables the reducer to dispatch on nested threads
// without recursive strategy loop calls.

// maxReconcilePasses bounds a drain loop so observer re-triggering can't spin
// forever. A dispatch may complete and set needsReconcile again (e.g. a child
// thread completes → parent needs dispatch), so we loop until quiet or capped.
const maxReconcilePasses = 10

// drainReconcile runs tryReconcile until the reducer is quiet, bounded by
// maxReconcilePasses. Used wherever an event or strategy-loop step may leave
// needsReconcile set and no run() event loop is guaranteed to pick it up.
func (w *ConversationWorker) drainReconcile() {
	for i := 0; i < maxReconcilePasses && w.needsReconcile; i++ {
		w.tryReconcile()
	}
}

func (w *ConversationWorker) tryReconcile() {
	if !w.needsReconcile {
		return
	}
	w.needsReconcile = false

	// Guard: the reducer fires on every event-loop tick via handleItemsChange.
	// During partial Yjs sync (mid-update, reconnect, etc.) the items array
	// can contain half-populated Y.Maps that panic in yMapToConversationItem.
	// Recover gracefully — the next observer tick will retry.
	defer func() {
		if r := recover(); r != nil {
			w.log.Error("[reducer] recovered from panic in tryReconcile: %v\n%s", r, debug.Stack())
		}
	}()

	w.updateApprovalWaitAnchor()

	// Command the engine to advance any non-terminal tool-action. The worker
	// observes every doc update, so it drives tool execution directly rather
	// than relying on the engine's reactive observer to notice and react.
	w.driveToolActions()

	// Read activity first. The threadItemId in processingState is only
	// meaningful when an operation is in flight (activity != null).
	// When idle, the reducer evaluates the root thread.
	activity := w.getActivity()
	threadItemID := ""
	if activity != ActivityNone {
		threadItemID = w.getProcessingThreadItemID()
	}

	// Walk-down loop: evaluate the thread, and if the last effective item
	// is an incomplete child thread, descend into it.
	currentActivity := activity
	currentThreadID := threadItemID
	for {
		var items []ConversationItem
		if currentThreadID != "" {
			if arr := w.doc.GetThreadItemsArray(currentThreadID); arr != nil {
				items = w.doc.GetItemsFromArray(arr)
			}
		} else {
			items = w.doc.GetItems()
		}
		isRoot := currentThreadID == ""

		action := decideNextAction(items, currentActivity, isRoot, w.isExplicitContinuation(currentThreadID))

		switch action {
		case ActionNone:
			// Check for walk-down: find the FIRST incomplete child thread
			// among the effective items and descend into it. With multiple
			// sibling sub-threads (parent spawned several via multi-tool-use)
			// this dispatches them in spawn order, one per reconcile tick;
			// each completion ticks the reducer again and the next sibling
			// gets picked up. The descent is recursive, so sub-sub-threads
			// and deeper inherit the same fan-out behavior.
			//
			// Picking last-only would strand earlier siblings: after the
			// last-spawned child completes, the loop terminates with
			// !hasThreadResult(last)==false and the unfinished earlier
			// siblings never get dispatched.
			descended := false
			for _, item := range effectiveItems(items) {
				if item.Type != ItemTypeThread || hasThreadResult(item) {
					continue
				}
				// Never descend into a brand-new EMPTY child thread. The only
				// legitimate auto-run of an empty thread is an explicit
				// continuation (continueInNewThread / the pendingRequests
				// orchestrator): those call requestLLM(newThreadID) so the
				// thread is the walk-down's STARTING thread (currentThreadID set
				// from processingState), reached at the top of this loop — never
				// by descending here. Descending into an empty child instead
				// borrows the PARENT's awaiting_llm marker (left by the parent's
				// own pending tool/turn) and fires an LLM call on a thread the
				// user just created via the "New Thread" button and has not yet
				// sent a message to — the "new thread immediately starts running"
				// bug. An empty/unreadable child is therefore not a descent
				// target; it rests until the user sends a message.
				childArr := w.doc.GetThreadItemsArray(item.ItemID)
				if childArr == nil || len(effectiveItems(w.doc.GetItemsFromArray(childArr))) == 0 {
					continue
				}
				currentThreadID = item.ItemID
				descended = true
				break
			}
			if descended {
				continue // walk down into the chosen sibling
			}
			return // truly nothing to do

		case ActionCallLLM:
			w.dispatchCallLLMOnThread(currentThreadID)
			return

		case ActionGoIdle:
			// All tools were denied/cancelled while activity was "awaiting_llm".
			// If the user queued a follow-up while the turn was parked, a denial
			// means "drop these, run what I just said": continue the turn instead
			// of resting (the strategy loop promotes the queue at its top). With
			// nothing queued, this is a plain stop — promote (a no-op) and rest.
			//
			// Park-on-executing is enforced upstream in handleCancel: an Escape
			// while a tool is actually running cancels everything and writes idle
			// (clearing awaiting_llm) BEFORE the reducer runs, so this continue
			// only ever fires when the block was purely tool approvals.
			if w.hasPendingItems(currentThreadID) {
				w.dispatchCallLLMOnThread(currentThreadID)
				return
			}
			w.promotePendingItems(currentThreadID)
			w.sendStatus("idle", "")
			return
		}
	}
}

// dispatchCallLLMOnThread is the reducer's action handler for ActionCallLLM.
// It claims the in-flight marker for the given thread, sets up thread
// context, and runs a single LLM turn. If the LLM creates async tools
// or a child thread, the loop sets activity="awaiting_llm" and returns.
// The reducer re-dispatches when all work completes.
func (w *ConversationWorker) dispatchCallLLMOnThread(threadItemID string) {
	// Only dispatch when the worker is idle. If state is mid-transition
	// (the previous turn's deferred cleanup hasn't flipped back to Idle yet),
	// re-tickle the reducer so the next event-loop tick retries — otherwise
	// the request is orphaned until some other event re-wakes the loop, which
	// presents to the user as "user message appended but LLM loop never starts;
	// hitting Continue kicks it off".
	if w.loadState() != StateIdle {
		w.needsReconcile = true
		return
	}

	// Transition activity from "awaiting_llm" → "calling_llm".
	// Consume the one-shot continuation marker only once we are actually going
	// to dispatch; if claimLLM fails, leave it for the next reconcile tick.
	if !w.claimLLM(threadItemID) {
		// Already claimed for an LLM call — re-tickle so the next reconcile
		// tick picks it up after the in-flight call completes.
		w.needsReconcile = true
		return
	}
	w.consumeExplicitContinuation(threadItemID)

	// Set up thread context from doc state.
	w.thread.itemID = threadItemID
	if threadItemID != "" {
		w.thread.itemsArray = w.doc.GetThreadItemsArray(threadItemID)
	} else {
		w.thread.itemsArray = nil
	}

	// Turn-scoped anchor: only stamp the start when beginning a fresh turn (from
	// idle, where it was zeroed). Preserving it across re-dispatches within a turn
	// keeps the spinner's elapsed digit measuring the whole turn, instead of
	// resetting to 0 every time a tool completes and the next LLM call dispatches.
	if w.processingStartedAt == 0 {
		w.processingStartedAt = time.Now().UnixMilli()
	}
	w.storeState(StateProcessing)
	w.sendStatus("preparing", "")
	w.batcher.Flush()
	w.runStrategyLoop("", true)
}

// selectThreadFallbackResult returns the trailing assistant text suitable to
// stand in as a thread result without an explicit return_result call. It is
// used on demand by the footer's "Close with last message" action (handled in
// the worker): it returns the content ONLY when the last effective item is a
// non-empty assistant message — i.e. the LLM produced a final reply. Any
// trailing tool-action, meta-tool-result, user, or thread item means there is
// no clean trailing reply to promote, so it returns "" (the caller then leaves
// the thread open rather than stamping stale or unrelated text as the result).
func selectThreadFallbackResult(items []ConversationItem) string {
	eff := effectiveItems(items)
	if len(eff) == 0 {
		return ""
	}
	last := eff[len(eff)-1]
	if last.Type != ItemTypeAssistant || last.Content == "" {
		return ""
	}
	return last.Content
}

// writeThreadResult promotes a forced-close thread's trailing text as its
// result in the one case a close was intended but not recorded: a thread whose
// turn was MANDATED to call return_result (forceTool, e.g. /compact) answered in
// plain text instead because the provider can't honour a forced tool_choice
// (claudecode degrades to text). Called from the strategy loop defer when a turn
// ends; a no-op for every other ending.
//
// An error is NOT such a case. A turn that stops on an error is just a turn that
// ended without closing — identical to one ending on plain assistant text: the
// thread is left OPEN and resumable, with the error visible as an error item.
// The thread closes only when the model calls return_result (which may itself
// report the error as the result) or the user closes it from the footer. The
// worker never fabricates a failure result on the thread's behalf.
//
// Resolves the thread Y.Map, reads its current result, scans the items array,
// and writes the result — ALL under one ycrdtMu critical section. Splitting
// these into separate lock windows was unsafe: between releases a concurrent
// ApplySyncUpdate could tombstone the resolved YMap, leaving the cached
// pointer dangling.
func (w *ConversationWorker) writeThreadResult(threadItemID string) {
	ycrdtMu.Lock()
	wrote, resultLen := w.writeThreadResultLocked(threadItemID)
	ycrdtMu.Unlock()
	if wrote {
		w.log.Info("[reducer] Wrote thread result for %s (%d chars)", threadItemID, resultLen)
	}
}

// writeThreadResultLocked performs the resolve→read→write atomically; caller
// MUST already hold ycrdtMu.
func (w *ConversationWorker) writeThreadResultLocked(threadItemID string) (wrote bool, resultLen int) {
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		return false, 0
	}
	if existingResult, _ := threadYMap.Get("result").(string); existingResult != "" {
		return false, 0 // return_result already wrote it
	}

	// The sole ending that stamps a result here is a thread MANDATED to close
	// via return_result (forceTool, e.g. /compact) whose turn answered in plain
	// text — the provider couldn't honour the forced tool_choice (claudecode
	// degrades to text). Promote that trailing assistant text so the mandated
	// close isn't lost. Any other ending — plain text, or an error — leaves the
	// thread OPEN: that is its normal resting state, resumable until a
	// return_result (or the footer) closes it.
	if ft, _ := threadYMap.Get("forceTool").(string); ft != "return_result" {
		return false, 0
	}

	arr := findThreadItemsArray(w.doc.getItems(), threadItemID)
	if arr == nil {
		return false, 0
	}
	resultText := selectThreadFallbackResult(w.doc.getItemsFromArrayLocked(arr))
	if resultText == "" {
		return false, 0
	}

	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", resultText)
	}, w.doc.authorID)
	return true, len(resultText)
}

// clearThreadResult clears the result field of a completed thread, reopening it.
// Uses authorID as the transaction origin so the operation is tracked by the
// UndoManager and can be undone. The null item created here has Go's clientID,
// which is required for RedoItem to succeed when undoing the clear.
func (w *ConversationWorker) clearThreadResult(threadItemID string) bool {
	// StopCapturing must be called outside ycrdtMu (it takes its own internal
	// lock against the undo manager's afterTransaction handler).
	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		return false
	}
	if existingResult, _ := threadYMap.Get("result").(string); existingResult == "" {
		ycrdtMu.Unlock()
		return false // already open
	}
	ycrdtMu.Unlock()

	w.tracker.StopCapturing()

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	// Re-resolve under the same lock window as the write. The pointer from
	// the existence-check above could have been invalidated by a sync update
	// applied between releasing and re-acquiring.
	threadYMap = findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		return false
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", nil)
	}, w.doc.authorID)
	return true
}

// closeThreadWithLastMessage closes an open thread by promoting its trailing
// assistant message as the result — the footer's "Close with last message"
// action, with no LLM turn. Returns false if the thread is already closed or
// has no clean trailing assistant reply to promote (selectThreadFallbackResult
// yields ""), in which case the caller leaves it open. Written under authorID,
// like clearThreadResult, so the close is a discrete undoable step.
func (w *ConversationWorker) closeThreadWithLastMessage(threadItemID string) bool {
	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		return false
	}
	if existingResult, _ := threadYMap.Get("result").(string); existingResult != "" {
		ycrdtMu.Unlock()
		return false // already closed
	}
	arr := findThreadItemsArray(w.doc.getItems(), threadItemID)
	if arr == nil {
		ycrdtMu.Unlock()
		return false
	}
	resultText := selectThreadFallbackResult(w.doc.getItemsFromArrayLocked(arr))
	ycrdtMu.Unlock()
	if resultText == "" {
		return false // no clean trailing assistant reply to promote
	}

	// StopCapturing outside ycrdtMu (it takes the undo manager's own lock).
	w.tracker.StopCapturing()

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	// Re-resolve under the write lock — a concurrent sync update could have
	// invalidated the pointer or set a result between lock windows.
	threadYMap = findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		return false
	}
	if existingResult, _ := threadYMap.Get("result").(string); existingResult != "" {
		return false
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", resultText)
	}, w.doc.authorID)
	return true
}
