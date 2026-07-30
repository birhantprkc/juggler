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

// maxToolCommandRetries bounds how many times a single tool-command is re-driven
// after the engine reports it could not act (negative ack). Beyond this the
// worker stops re-driving and latches the command, leaving recovery to the next
// engine reattach — so a permanently-unsatisfiable command can't spin forever.
const maxToolCommandRetries = 5

// defaultAckTimeout is how long the worker waits for the engine to acknowledge a
// tool-command before treating it as silently dropped. The engine acks
// execute-tool only AFTER the tool runs to a terminal result, so this threshold
// must comfortably exceed a slow-but-legitimate tool (e.g. a long `make test`)
// — the sweep additionally refuses to re-drive anything the engine has already
// claimed (state=running), so a slow tool is never re-fired regardless. Exposed
// as the ackTimeout worker field, which tests shrink.
const defaultAckTimeout = 20 * time.Second

// maxToolCommandTimeouts bounds the silent-timeout re-drive loop per toolUseId
// (parallel to maxToolCommandRetries for negative acks). Past this many silent
// timeouts the worker stops re-driving and escalates the tool to a terminal
// error result so the parked turn unblocks instead of hanging forever.
const maxToolCommandTimeouts = 3

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
// Dedup: commandedToolActions records the last state each tool was commanded at,
// so a tool isn't re-dispatched every tick while its state is unchanged. The
// engine handlers are independently idempotent (handleNewToolAction's ifState CAS
// and claimRunning's compare-and-set), so a redundant command is harmless — the
// dedup only suppresses needless traffic. Worker-managed tools (create_thread)
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

	// Filter to the commands not already dispatched at this state.
	// Comma-ok, not a bare lookup: StateUnevaluated is "" and a missing map
	// entry also reads "", so a bare `commandedToolActions[c.id] == c.state`
	// treats a never-commanded tool as already commanded at "" and never
	// dispatches its first evaluate-tool. Only dedup when the tool was
	// actually commanded before, at this same state.
	var toDispatch []toolCmd
	for _, c := range cmds {
		if prev, ok := w.tools.commandedAt(c.id); ok && prev == c.state {
			continue // engine confirmed it handled this state (positive ack)
		}
		if prev, ok := w.tools.inFlightAt(c.id); ok && prev == c.state {
			continue // dispatched, awaiting the engine's ack — don't re-spam it
		}
		toDispatch = append(toDispatch, c)
	}
	if len(toDispatch) == 0 {
		return
	}

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
		// Record as in-flight, NOT commanded: the dedup holds until the engine
		// acks. A positive ack (handleToolCommandAck) promotes this to
		// commandedToolActions; a negative ack clears it and the next reconcile
		// re-dispatches. (This replaced an optimistic latch straight into
		// commandedToolActions, which wedged the tool forever if the single
		// command was dropped or no-op'd by the engine.)
		w.tools.markInFlight(c.id, c.state, time.Now())
		w.dispatchToolCommand(c.action, c.id)
	}
	// A command is now outstanding: arm the watchdog so a silently-dropped command
	// (no execution, no ack) is detected and recovered rather than latching forever.
	w.armAckWatchdog()
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
		w.tools.clearCommanded(id)
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

// armAckWatchdog starts the ack watchdog if it isn't already running. The timer
// callback only signals ackWatchdogC (mirroring saveTimer → saveChan); all
// watchdog state is mutated on the run goroutine in sweepStaleToolCommands. Once
// armed it stays armed until it fires (the sweep re-arms while work remains) or a
// drain disarms it — so a burst of dispatches doesn't keep pushing the deadline
// out and starve the sweep.
func (w *ConversationWorker) armAckWatchdog() {
	if w.ackWatchdog != nil {
		return
	}
	w.ackWatchdog = time.AfterFunc(w.ackTimeout, func() {
		select {
		case w.ackWatchdogC <- struct{}{}:
		default:
		}
	})
}

// disarmAckWatchdog stops the watchdog and drains any already-fired signal so a
// stale wake can't sweep an empty in-flight set. Run-goroutine only.
func (w *ConversationWorker) disarmAckWatchdog() {
	if w.ackWatchdog != nil {
		w.ackWatchdog.Stop()
		w.ackWatchdog = nil
	}
	select {
	case <-w.ackWatchdogC:
	default:
	}
}

// disarmAckWatchdogIfDrained disarms the watchdog once no tool-command remains in
// flight, so an idle worker has no pending wakeups.
func (w *ConversationWorker) disarmAckWatchdogIfDrained() {
	if w.tools.inFlightCount() == 0 {
		w.disarmAckWatchdog()
	}
}

// sweepStaleToolCommands is the watchdog body: it inspects every in-flight
// tool-command and recovers the ones the engine never acknowledged. It runs on
// the run goroutine (the ackWatchdogC select case), so it touches all the
// tool-command maps without a lock.
//
// Per stale id (dispatched ≥ ackTimeout ago):
//   - If the doc state advanced past the state it was dispatched at, the engine
//     DID act (it CAS-claims approved→running BEFORE any side effect, or ran the
//     tool to a terminal result) and only the ack was lost — drop the stale
//     bookkeeping, never re-drive (a side effect may be in flight).
//   - Otherwise the engine never claimed it (state unchanged, no runningStartedAt),
//     so a re-drive cannot double-fire a side effect: under the cap, clear the
//     in-flight latch and request a reconcile (driveToolActions re-pushes the doc
//     to the engine — forcing it to (re)load this conversation as a peer, the
//     stateful-peer cause — and re-dispatches); past the cap, escalate to a
//     terminal error so the parked turn unblocks.
func (w *ConversationWorker) sweepStaleToolCommands() {
	// The timer fired; clear the handle so armAckWatchdog can re-arm below.
	w.ackWatchdog = nil

	if w.tools.inFlightCount() == 0 {
		return
	}

	// Snapshot the current doc state of every tool-action (root + nested threads)
	// so each in-flight command can be classified against the state it was
	// dispatched at.
	states := map[string]string{}
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if id, _ := m.Get("toolUseId").(string); id != "" {
			state, _ := m.Get("state").(string)
			states[id] = state
		}
		return false
	})
	ycrdtMu.Unlock()

	now := time.Now()
	var escalate []string
	for _, c := range w.tools.inFlightSnapshot() {
		if c.dispatchedAt.IsZero() {
			// Missing timestamp (shouldn't happen): stamp it and wait one cycle.
			w.tools.restamp(c.id, now)
			continue
		}
		if now.Sub(c.dispatchedAt) < w.ackTimeout {
			continue // not stale yet
		}

		if cur, present := states[c.id]; !present || cur != c.state {
			// Engine acted (claimed/ran/removed) — only the ack was lost. Drop the
			// stale bookkeeping; the normal reconcile handles the rest. Never re-drive.
			w.tools.clearInFlight(c.id)
			continue
		}

		n := w.tools.bumpTimeouts(c.id)
		if n > maxToolCommandTimeouts {
			escalate = append(escalate, c.id)
			continue
		}
		w.log.Error("[worker] engine never acked tool-command for %s (state=%q) in %s within %s; re-driving (%d/%d)",
			c.id, c.state, w.conversationID, w.ackTimeout, n, maxToolCommandTimeouts)
		w.tools.clearInFlight(c.id)
		w.needsReconcile = true
	}

	for _, id := range escalate {
		w.escalateStaleToolCommand(id)
	}

	if w.tools.inFlightCount() > 0 {
		w.armAckWatchdog()
	}
}

// clearToolCommandBookkeeping drops every dedup/in-flight/escalation field for a
// toolUseId at a full-reset site (user-triggered retry, escalation-to-failed).
// Leaving any field populated wedges the re-drive: a stale in-flight latch makes
// the staleness sweep think a command is still outstanding, and a stale
// retry/timeout count prematurely trips the escalation caps on the next run.
func (w *ConversationWorker) clearToolCommandBookkeeping(id string) {
	w.tools.clear(id)
}

// escalateStaleToolCommand fails a tool whose engine command went unacknowledged
// past maxToolCommandTimeouts. It writes a terminal error result onto the
// tool-action — the same recovery shape as a worker-side cancel
// (cancelToolsInArray) — so the reducer feeds an isError tool-result to the
// provider and a parked CLI unblocks (doc.go: "degrade to a recoverable error,
// never an infinite wait"). All bookkeeping for the id is cleared.
func (w *ConversationWorker) escalateStaleToolCommand(id string) {
	w.log.Error("[worker] tool-command for %s in %s went unacknowledged %d×; failing the tool to unblock the turn",
		id, w.conversationID, w.tools.timeoutCount(id))
	w.tape.Record("tool-command-timeout-escalate", map[string]any{
		"id": id, "timeouts": w.tools.timeoutCount(id),
	})
	w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
		"state": StateCompleted,
		"result": map[string]any{
			"content": fmt.Sprintf("[internal] The tool engine never acknowledged this command after %s and %d retries; failing it so the turn can proceed.",
				w.ackTimeout, maxToolCommandTimeouts),
			"isError": true,
		},
		"runningStartedAt": nil,
	})
	w.clearToolCommandBookkeeping(id)
	w.needsReconcile = true
}
