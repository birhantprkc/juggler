//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// maxToolCommandAttempts bounds how many times driveToolActions re-dispatches a
// tool-command that stays stuck at the same delivery state ("" or approved). Past
// this the worker escalates the tool to a terminal error so a parked turn unblocks
// instead of hanging forever, rather than re-driving indefinitely. At the default
// redriveInterval (~5s) this is ~30s of silence before escalation.
const maxToolCommandAttempts = 6

// defaultRedriveInterval is how long driveToolActions waits before re-dispatching
// a tool-command still stuck at the state it was last sent at. Doc-state
// progression (the engine claimed/evaluated the tool) suppresses re-drive
// immediately; this interval only bounds recovery of a silently-dropped command.
// Exposed as the redriveInterval worker field, which tests shrink.
const defaultRedriveInterval = 5 * time.Second

// driveToolActions commands the engine — the single tool executor — to advance
// every non-terminal tool-action in the conversation. It is the worker side of
// the command-driven engine: the worker already observes every doc update via
// handleItemsChange, so rather than relying on the engine's reactive Yjs
// observer to notice a tool-action and react (the racy path that left tools
// "stuck"), the worker explicitly tells the engine what to do. The worker is the
// SOLE driver of the tool lifecycle; the engine has no tool observer.
//
// Called from tryReconcile on every reconcile tick. It scans root + nested
// threads and, per non-terminal tool-action, dispatches the command matching its
// state: "" → evaluate-tool, approved → execute-tool. pending (awaiting the user)
// and running (already claimed) need no command. Terminal tools are skipped.
//
// Dedup + recovery are one level-based rule: re-dispatch a tool's command only
// when the doc state still demands one AND it wasn't already dispatched at that
// state within redriveInterval (tools.shouldRedrive). Doc-state progression is the
// "engine acted" signal — the engine handlers are independently idempotent
// (handleNewToolAction's ifState CAS and claimRunning's compare-and-set), so a
// redundant command is a harmless no-op — so the age test alone both suppresses
// per-tick spam and recovers a silently-dropped command once it goes stale. A tool
// stuck at the same delivery state past maxToolCommandAttempts is escalated to a
// terminal error so the parked turn unblocks. Worker-managed tools (create_thread)
// are commanded too but the engine no-ops them (its handlers early-return on the
// workerManaged manifest), so they remain worker-executed.
func (w *ConversationWorker) driveToolActions() {
	// Re-evaluate tools parked awaiting approval if the active strategy changed
	// since the last tick. This is a pure worker-side doc write (independent of
	// the engine), so run it before the engine-attached guard — a switch made
	// while the engine is momentarily detached must not be lost.
	w.reevaluatePendingToolsOnStrategyChange()

	if !w.callbacks.engineAttached() {
		return
	}

	type toolCmd struct {
		id, state, action string
	}
	var cmds []toolCmd

	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		id, _ := m.Get("toolUseId").(string)
		if id == "" {
			return false
		}
		state, _ := m.Get("state").(string)
		var action string
		switch state {
		case StateUnevaluated:
			action = "evaluate-tool"
		case StateApproved:
			action = "execute-tool"
		default:
			// pending (awaiting user), running (already claimed), or terminal
			// (completed/cancelled): nothing for the worker to command. The user's
			// approval is expressed as the viewer's state=approved write, which
			// this walk picks up on the next tick via the StateApproved branch.
			return false
		}
		cmds = append(cmds, toolCmd{id: id, state: state, action: action})
		return false
	})
	ycrdtMu.Unlock()

	// Filter to the commands due for dispatch: either the doc demands a fresh
	// command (never dispatched, or the demanded state changed) or the last
	// dispatch at this state has aged past redriveInterval. recordDispatch stamps
	// the dispatch and returns the attempt count; past maxToolCommandAttempts the
	// tool is escalated to a terminal error instead of re-driven forever.
	now := time.Now()
	var toDispatch, escalate []toolCmd
	for _, c := range cmds {
		if !w.tools.shouldRedrive(c.id, c.state, now, w.redriveInterval) {
			continue // already dispatched at this state and not yet stale
		}
		if n := w.tools.recordDispatch(c.id, c.state, now); n > maxToolCommandAttempts {
			escalate = append(escalate, c)
			continue
		}
		toDispatch = append(toDispatch, c)
	}

	if len(toDispatch) > 0 {
		// The engine acts solely on these commands and must already hold the
		// tool-action each refers to. Push the full doc through the SAME ordered
		// engine mailbox the commands use, so the engine applies the tool-action
		// before handling the command (engine doc-syncs are batched behind a
		// setTimeout, so a bare command could arrive before the sync that created
		// the tool and resolve to nothing). This ordering discipline — commands ride
		// the doc-sync mailbox; the engine flushes pending syncs before acting — is
		// the load-bearing invariant of the command-driven engine.
		w.pushStateToEngine()
		for _, c := range toDispatch {
			w.dispatchToolCommand(c.action, c.id)
		}
	}

	for _, c := range escalate {
		w.escalateStaleToolCommand(c.id, c.state)
	}
}

// reevaluatePendingToolsOnStrategyChange resets a thread's tool-actions parked
// in StatePending (awaiting user approval) back to StateUnevaluated when that
// thread's effective strategy has changed since the last reconcile tick, so
// driveToolActions re-dispatches evaluate-tool and the engine's handleNewToolAction
// re-decides approval under the NEW strategy's getApprovalPolicy().
//
// Without this, a tool that parked for approval under the old strategy keeps
// waiting for a click even after the user switches to YOLO mid-loop: the engine
// makes its approval decision exactly once, at evaluate time, and nothing
// revisits an already-parked tool. The engine-side policy fix only covers tools
// evaluated AFTER the switch; this covers the ones already pending.
//
// Strategy is per-thread, so the switch is detected per-thread: each thread
// (root + every sub-thread) is compared against its own last-reconciled effective
// strategy, and only the threads whose strategy actually changed have their
// pending tools reset. The reset mirrors handleRetryToolApproval — a full return
// to "" clearing the cached approval form — and drops each tool's dedup entry so
// the drive below re-commands it.
//
// The first observation (worker init / load) only records the baseline; it never
// resets, so freshly-loaded pending tools aren't disturbed on startup. A newly
// appeared thread likewise only records its baseline (its tools are fresh). An
// empty effective strategy is normalized to "default" by the resolver, so a
// default→yolo switch is detected even though the doc went from "" to "yolo".
func (w *ConversationWorker) reevaluatePendingToolsOnStrategyChange() {
	// Snapshot the current effective strategy for root + every sub-thread.
	current := map[string]string{"": w.doc.ResolveEffectiveStrategyID("")}
	var threadIDs []string
	ycrdtMu.Lock()
	walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if id, _ := m.Get("itemId").(string); id != "" {
			threadIDs = append(threadIDs, id)
		}
		return false
	})
	ycrdtMu.Unlock()
	for _, id := range threadIDs {
		current[id] = w.doc.ResolveEffectiveStrategyID(id)
	}

	if !w.strategyBaselineSet {
		// First observation: record every thread's baseline without resetting.
		w.lastReconciledStrategyIDs = current
		w.strategyBaselineSet = true
		return
	}

	// Determine which threads changed strategy since the last tick.
	changed := make(map[string]bool)
	for threadID, cur := range current {
		prev, existed := w.lastReconciledStrategyIDs[threadID]
		if !existed {
			// Newly appeared thread — record baseline, don't reset (tools fresh).
			continue
		}
		if cur != prev {
			changed[threadID] = true
		}
	}
	w.lastReconciledStrategyIDs = current
	if len(changed) == 0 {
		return
	}

	// Collect pending tool-actions belonging to a changed thread.
	var ids []string
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if !changed[threadID] {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if state, _ := m.Get("state").(string); state != StatePending {
			return false
		}
		if id, _ := m.Get("toolUseId").(string); id != "" {
			ids = append(ids, id)
		}
		return false
	})
	ycrdtMu.Unlock()

	for _, id := range ids {
		// UpdateToolActionFieldsRecursive acquires ycrdtMu internally, so this
		// must run with the lock released. Full reset to "" so the engine rebuilds
		// a fresh approval decision (and form, if still needed) from the tool's
		// immutable toolInput under the new policy.
		w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
			"state":            StateUnevaluated,
			"approvalResponse": nil,
			"approvalOptions":  nil,
			"displayData":      nil,
		})
		w.tools.clear(id)
	}
	if len(ids) > 0 {
		w.tape.Record("strategy-switch-reevaluate", map[string]any{
			"threads": len(changed), "count": len(ids),
		})
	}
}

// dispatchToolCommand marshals and sends one ToolCommand to the engine only. The
// conversationId is stamped by the outbound envelope (FormatWorkerMessage).
func (w *ConversationWorker) dispatchToolCommand(action, toolUseID string) {
	w.dispatchToolCommandEpoch(action, toolUseID, 0)
}

// dispatchToolCommandEpoch is dispatchToolCommand carrying an execution
// generation, so a cancel-tool command aborts only the incarnation it was
// issued against (see ToolCommand.RunningEpoch). Epoch 0 is omitted from the
// wire and means "unscoped" — the value passed by every non-cancel command.
func (w *ConversationWorker) dispatchToolCommandEpoch(action, toolUseID string, runningEpoch int64) {
	data, err := json.Marshal(ToolCommand{Type: action, ToolUseID: toolUseID, RunningEpoch: runningEpoch})
	if err != nil {
		w.log.Error("[worker] marshal tool-command %s: %v", action, err)
		return
	}
	w.tape.Record("tool-command", map[string]any{"action": action, "id": toolUseID, "runningEpoch": runningEpoch})
	w.callbacks.sendToEngine(data)
}

// clearToolCommandBookkeeping drops all command bookkeeping for a toolUseId at a
// full-reset site (user-triggered retry, escalation-to-failed). Leaving a stale
// entry would make driveToolActions treat a fresh incarnation as already-dispatched
// and suppress its first command until the age test elapsed.
func (w *ConversationWorker) clearToolCommandBookkeeping(id string) {
	w.tools.clear(id)
}

// escalateStaleToolCommand fails a tool whose engine command stayed stuck at the
// same delivery state past maxToolCommandAttempts. It writes a terminal error
// result onto the tool-action — the same recovery shape as a worker-side cancel
// (cancelToolsInArray) — so the reducer feeds an isError tool-result to the
// provider and a parked CLI unblocks (doc.go: "degrade to a recoverable error,
// never an infinite wait").
//
// The walk that selected this id ran earlier and released ycrdtMu, so the engine
// may have claimed or completed the tool since. Revalidate under the lock: only
// fail a tool still at expectState with no result; otherwise the engine acted and
// we just drop the stale bookkeeping. All bookkeeping for the id is cleared.
func (w *ConversationWorker) escalateStaleToolCommand(id, expectState string) {
	stillStuck := false
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if tid, _ := m.Get("toolUseId").(string); tid != id {
			return false
		}
		if state, _ := m.Get("state").(string); state == expectState && m.Get("result") == nil {
			stillStuck = true
		}
		return true // found the tool; stop the walk
	})
	ycrdtMu.Unlock()
	if !stillStuck {
		w.clearToolCommandBookkeeping(id)
		return
	}

	w.log.Error("[worker] tool-command for %s in %s stayed at state=%q unhandled %d×; failing the tool to unblock the turn",
		id, w.conversationID, expectState, maxToolCommandAttempts)
	w.tape.Record("tool-command-attempts-escalate", map[string]any{
		"id": id, "state": expectState, "attempts": maxToolCommandAttempts,
	})
	w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
		"state": StateCompleted,
		"result": map[string]any{
			"content": fmt.Sprintf("[internal] The tool engine never handled this command after %d attempts; failing it so the turn can proceed.",
				maxToolCommandAttempts),
			"isError": true,
		},
		"runningStartedAt": nil,
	})
	w.clearToolCommandBookkeeping(id)
	w.needsReconcile = true
}
