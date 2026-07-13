//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"juggler/cmd/juggler/core"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"

	ycrdt "github.com/skyterra/y-crdt"
)

// sendReadyWithDocMetadata collects the standard set of metadata keys from the
// Yjs doc and calls sendReadyWithMetadata. Used on both the reconnect path and
// the first-init path so the two call sites stay in sync.
func (w *ConversationWorker) sendReadyWithDocMetadata() {
	metadata := make(map[string]any)
	for _, key := range []string{"created", "defaultModelConfig", "currentStrategyId"} {
		if v := w.doc.GetMetadata(key); v != nil {
			metadata[key] = v
		}
	}
	w.sendReadyWithMetadata(metadata)
}

func (w *ConversationWorker) handleInit(payload json.RawMessage) {
	var msg InitMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse init message: %v", err)
		w.sendError("Failed to parse init message", "")
		return
	}

	// Reconnect path: viewer reconnected to an already-initialized worker.
	// Do NOT cancel processing, reload from disk, or reset processingState —
	// just update config, sync the reconnecting client, and return.
	if w.initialized {
		w.log.Debug("Client attached to conversation (conv=%s, state=%s)", w.conversationID, w.loadState())
		w.tape.Record("init", map[string]any{
			"path":         "reconnect",
			"origin":       w.replyTo,
			"loadFromDisk": msg.Conversation.LoadFromDisk,
		})

		// Sync the reconnecting client with current Yjs state
		w.broadcastFullState()
		w.sendUndoState(w.tracker.CanUndo(), w.tracker.CanRedo())

		// Send ready with metadata if requested. The conversation name is
		// the folder name on disk and lives on the session manifest, not
		// in the Yjs doc — so we don't include it here.
		if msg.Conversation.LoadFromDisk {
			w.sendReadyWithDocMetadata()
		} else {
			w.sendReady()
		}
		return
	}

	// First-init path: full initialization
	w.tape.Record("init", map[string]any{
		"path":         "first",
		"origin":       w.replyTo,
		"loadFromDisk": msg.Conversation.LoadFromDisk,
	})
	w.projectPath = msg.Config.ProjectPath
	w.txnStore = NewTransactionStore(w.pathProvider)
	w.assetStore = NewAssetStore(w.pathProvider)

	// Open this conversation's own log file (in addition to the process-wide
	// server.log) so a conversation's worker activity can be read in isolation.
	// The filename is prefixed with the current tab name for easy browsing, with
	// the stable conv id as the authoritative suffix. Only when on-disk logging
	// is actually enabled; otherwise w.log stays nil and the nil-safe handle
	// routes to the process sink + console alone.
	if jlog.FileLoggingEnabled() {
		path := logpaths.ConversationLogPath(w.projectPath, w.conversationID, w.conversationName())
		w.log = jlog.NewLogger(path, 10, 5)
	}

	initStart := time.Now()

	// Track whether we loaded from disk to determine what metadata to send
	loadedFromDisk := false

	// Load existing Yjs state from disk (for existing conversations)
	// mustExist=true when loading from disk: missing file means the conversation
	// was orphaned (e.g. app quit before worker could save) — report error so
	// frontend removes it from conversationOrder.
	if err := w.loadStateFromDisk(msg.Conversation.LoadFromDisk); err != nil {
		w.log.Error("Failed to load state from disk: %v", err)
		if msg.Conversation.LoadFromDisk {
			w.sendError(fmt.Sprintf("Conversation data not found: %v", err), "")
			return
		}
	} else {
		// Successfully loaded from disk
		loadedFromDisk = true
	}

	// Initialize the items Y.Array on the worker side, making the worker the
	// SOLE creator of root["items"]. If both worker and browser independently
	// created the array, the Yjs Y.Map conflict resolution discards one (and
	// with it the browser's SYSTEM_1). Flushing the doc state to the viewer
	// before sendReady lets the viewer's activateYjsSync see the array as
	// already present so it doesn't try to create a competing one.
	w.tracker.EnsureInitialized()
	if !msg.Conversation.LoadFromDisk {
		w.batcher.Flush()
	}

	// Repair routines below all read items via doc.GetItems(), which is
	// backed by ensureItems() and would create an empty Y.Array for a new
	// conversation. That empty array races the browser's array (with
	// SYSTEM_1) for the items key on root. Only run repairs for loaded
	// conversations — new ones have nothing to repair.
	if msg.Conversation.LoadFromDisk {
		// Repair any duplicate messageIds from undo/redo bugs
		repairedCount := w.repairDuplicateItemIds()
		if repairedCount > 0 {
			w.log.Info("Repaired %d duplicate messageIds", repairedCount)
			// Save repaired state immediately to prevent re-corruption on next load
			if err := w.saveStateToDisk(); err != nil {
				w.log.Error("Failed to save repaired state: %v", err)
			}
			// Notify frontend about the repair
			w.sendCorruptionRepaired(repairedCount)
		}

		// A thread with no result is OPEN, not stuck: a thread closes only on
		// an explicit return_result call (or a hard error). So a resultless
		// thread must survive a reload / server restart as open — there is no
		// repair to do here. (A non-terminal tool-action left mid-flight is
		// handled by CancelStaleToolActions below + the requestLLM re-drive.)

		// Cancel tool-actions left running when the app was killed
		w.CancelStaleToolActions()
	}

	// Initialize the conversation-level DEFAULT model config in doc metadata for
	// new conversations (for existing conversations it is loaded from disk above).
	// The key is `defaultModelConfig`; threads override via their own Y.Map
	// `modelConfig` key. Guard on BOTH the new key and the legacy `modelConfig`
	// metadata key so a loaded pre-rename session is never re-seeded over its
	// persisted default.
	if msg.Conversation.ModelConfig != nil &&
		msg.Conversation.ModelConfig.Provider != "" &&
		msg.Conversation.ModelConfig.Model != "" &&
		w.doc.GetMetadata("defaultModelConfig") == nil &&
		w.doc.GetMetadata("modelConfig") == nil {
		w.doc.SetMetadata("defaultModelConfig", map[string]any{
			"provider": msg.Conversation.ModelConfig.Provider,
			"model":    msg.Conversation.ModelConfig.Model,
		})
	}

	// Initialize created timestamp in doc metadata for new conversations.
	// (Name lives on the on-disk folder name now, not the Yjs doc.)
	if msg.Conversation.Created != "" && w.doc.GetMetadata("created") == nil {
		w.doc.SetMetadata("created", msg.Conversation.Created)
	}

	// Seed the strategy-activation marker so onActivate fires only on a genuine,
	// non-baseline activation (matching the old "fires on a live switch, never on
	// initial load" rule):
	//   - reloaded conversation: treat the persisted strategy as already active,
	//     so reopening never re-injects its guidance;
	//   - new conversation: baseline `default`, so a plain default conversation
	//     never pays a no-op activation round-trip, while a switch to (or creation
	//     in) plan/research still fires onActivate.
	// Only seed when absent: a conversation activated under this feature has its
	// own persisted value that must win.
	if w.doc.GetMetadata("activatedStrategyId") == nil {
		seed := defaultStrategyID
		if loadedFromDisk {
			if cur, ok := w.doc.GetMetadata("currentStrategyId").(string); ok && cur != "" {
				seed = cur
			}
		}
		w.doc.SetMetadata("activatedStrategyId", seed)
	}

	// For new conversations, save the initial state immediately so the .yjs file
	// exists on disk before the frontend can write the conversation ID to
	// conversationOrder. This prevents orphaned IDs if the app quits quickly.
	if !msg.Conversation.LoadFromDisk {
		if err := w.saveStateToDisk(); err != nil {
			w.log.Error("Failed to save initial state for new conversation: %v", err)
		}
	}

	// Clear any undo history that accumulated during initialization (e.g. from
	// repairDuplicateItemIds, which uses authorID). The repair operations are
	// not user-initiated and should not be undoable.
	w.tracker.ClearHistory()

	// Reset processingState on first init. Default to idle, but if the
	// on-disk doc still has a non-terminal tool-action (e.g. user quit while
	// an approval dialog was open) re-establish activity="awaiting_llm" on
	// the owning thread. Without this, after restart + approve the tool
	// completes but the thread reducer sees activity="" and returns
	// ActionNone, so the next LLM turn never fires.
	w.sendStatus("idle", "")
	if threadID, ok := w.findThreadWithIncompleteTool(); ok {
		w.requestLLM(threadID)
	}

	// Broadcast state to frontend so it can sync
	w.broadcastFullState()

	// Broadcast initial undo state so clients know undo availability after load
	w.sendUndoState(w.tracker.CanUndo(), w.tracker.CanRedo())

	w.initialized = true

	// Send ready message LAST (after all document mutations complete).
	// This prevents race with tests that start modifying document after
	// receiving "ready". The conversation name lives on the session
	// manifest (folder name on disk), not in the Yjs doc — so we don't
	// look it up here.
	if msg.Conversation.LoadFromDisk && loadedFromDisk {
		w.sendReadyWithDocMetadata()
		w.log.Debug("[worker] loaded conv=%s in %v", w.conversationID, time.Since(initStart).Round(time.Millisecond))
	} else {
		w.sendReady()
		w.log.Debug("[worker] created conv=%s in %v", w.conversationID, time.Since(initStart).Round(time.Millisecond))
	}
}

func (w *ConversationWorker) handleSendMessage(payload json.RawMessage) {
	var msg SendMessageMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.sendError("Failed to parse send-message", "")
		return
	}

	// If a turn is already in flight (a live LLM call, or a tool batch awaiting
	// approval), don't drop the message — queue it. The strategy loop drains the
	// queue at its next boundary; Stop and Deny promote it and stay idle. Empty
	// messages and continuations have nothing to queue.
	input := msg.UserInput()
	if w.getActivity() != ActivityNone || w.loadState() != StateIdle {
		if !msg.IsContinuation && !input.isEmpty() {
			w.enqueuePendingMessage(msg.ThreadItemID, input)
		}
		return
	}

	// Guard: empty message (no text AND no attachments) with no incomplete
	// tools = nothing to do.
	if input.isEmpty() && !msg.IsContinuation && !w.hasIncompleteTools() {
		return
	}

	// Resolve model config: check thread Y.Map → parent chain → conversation metadata
	modelConfig := w.doc.ResolveEffectiveModelConfig(msg.ThreadItemID)

	if modelConfig == nil || modelConfig.Model == "" {
		errMsg := "Please select a model before sending a message"
		if msg.IsContinuation {
			errMsg = "Please select a model before continuing"
		}
		w.sendStatus("validation-error", errMsg)
		return
	}

	// A send/continue is a fresh user intent to drive the LLM after any prior
	// undo/redo history navigation.
	w.suppressReconcileAfterHistoryNavUntilMs = 0

	// Set thread context for this request. Validate the target thread BEFORE
	// mutating w.thread, so an early return (completed thread / missing items
	// array) can't leave w.thread pointing at a half-set thread from this request.
	if msg.ThreadItemID != "" {
		// Guard: reject messages to completed threads
		if threadYMap := w.doc.GetThreadYMap(msg.ThreadItemID); threadYMap != nil {
			if result, _ := threadYMap.Get("result").(string); result != "" {
				w.sendError("Thread is completed. Reopen it to send messages.", "")
				return
			}
		}

		itemsArray := w.doc.GetThreadItemsArray(msg.ThreadItemID)
		if itemsArray == nil {
			w.sendError(fmt.Sprintf("Thread item %s not found", msg.ThreadItemID), "")
			return
		}
		w.thread.itemID = msg.ThreadItemID
		w.thread.itemsArray = itemsArray
	} else {
		w.thread.itemID = ""
		w.thread.itemsArray = nil
	}

	// Add user message to doc before signaling the reducer.
	if !msg.IsContinuation && !input.isEmpty() {
		w.addUserMessage(input)
		w.batcher.Flush()
		w.handleItemsChange()
	}

	// Explicit Continue clicks have no new user item to make the reducer's
	// intent obvious. Remember the one-shot intent until the reducer claims
	// the turn, so a root thread ending in an assistant message can still
	// dispatch exactly once.
	if msg.IsContinuation {
		w.markExplicitContinuation(msg.ThreadItemID)
	}

	// Signal the reducer to dispatch an LLM call. requestLLM sets
	// activity="awaiting_llm" atomically; the reducer picks it up on
	// the next event-loop tick via tryReconcile → dispatchCallLLM.
	w.requestLLM(msg.ThreadItemID)
	w.needsReconcile = true
}

// handleProviderTurn lands a turn the provider surfaced out-of-band — an
// autonomous wake/monitor turn the backend emitted with no Submit in flight —
// into the root conversation as a normal assistant turn. Delivering it as it
// completes prevents turn mis-attribution: the next foreground Submit can no
// longer dequeue it as its own reply. The relative inbound-FIFO ordering
// vs. a near-simultaneous send-message is best-effort, not guaranteed: a wake
// turn can occasionally land just after the user message instead of before.
// It can also be dispatched from inside a wait loop (waitForLLMResponse /
// waitForRetryDelay route inbound through dispatchMessage), so a wake turn may
// splice in mid-solicited-loop — it still inserts cleanly at root with its own
// txnID, just at an uncontrolled position. Both are cosmetic, not corrupting.
//
// Autonomous turns belong to the root conversation, not whatever thread a
// prior turn happened to run in, so blocks are appended at root.
//
// RISK — autonomous tool_use is not yet driven through the approval pipeline.
// The claudecode drain stops on tool_use, so in practice such turns rarely
// reach here; when one does we log+skip its tool_use blocks. Note this is a
// latent wedge, not a clean no-op: a wake turn that emits ONLY tool_use leaves
// the CLI parked inside an MCP tools/call awaiting a result nobody will send,
// and the next Submit resumes a session stuck mid-tool. Acceptable only because
// autonomous tool turns are rare.
//
// Cost is finalized exactly as for a solicited turn: every landed item is
// stamped with one shared transactionId and a transaction blob carrying the
// turn's usage is persisted. An autonomous turn spends real tokens (a
// wake/monitor can drive a multi-million-token agentic loop), so it must be
// billed, not lost — the footer reads the latest blob's inputTokens. There is
// no juggler request behind an autonomous turn, so the blob's input context is
// empty; the output blocks + usage come from the turn itself.
func (w *ConversationWorker) handleProviderTurn(payload json.RawMessage) {
	var msg ProviderTurnMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse provider-turn: %v", err)
		return
	}

	txnID := generateTransactionID()

	inserted := false
	for _, block := range msg.Blocks {
		switch block.Type {
		case provider.ContentBlockTypeThinking:
			content := block.Content
			if content == "" {
				content = block.Thinking
			}
			if content == "" {
				continue
			}
			w.tracker.InsertMessage(w.doc.GetItemsLength(), ConversationItem{
				Type:          ItemTypeThinking,
				ItemID:        generateItemID(),
				Content:       content,
				TransactionID: txnID,
				Timestamp:     time.Now().Format(time.RFC3339),
			})
			inserted = true
		case provider.ContentBlockTypeText:
			if block.Content == "" {
				continue
			}
			w.tracker.InsertMessage(w.doc.GetItemsLength(), ConversationItem{
				Type:          ItemTypeAssistant,
				ItemID:        generateItemID(),
				Content:       block.Content,
				TransactionID: txnID,
				Timestamp:     time.Now().Format(time.RFC3339),
			})
			inserted = true
		case provider.ContentBlockTypeToolUse:
			w.log.Info("provider-turn: autonomous tool_use %q not yet driven through approval pipeline (deferred); skipping", block.Name)
		}
	}

	if !inserted {
		return
	}

	// Persist the transaction blob so the turn is billable and "View
	// Transaction" resolves. StartTime is now / Duration is zero: the turn ran
	// in the CLI, so juggler has no real wall-clock for it (cosmetic fields).
	// SaveBlob no-ops on a nil store (tests without persistence).
	if err := w.txnStore.SaveBlob(TransactionBlobInput{
		ConversationID: w.conversationID,
		TxnID:          txnID,
		Response: &LLMResponse{
			Blocks:           msg.Blocks,
			InputTokens:      msg.InputTokens,
			OutputTokens:     msg.OutputTokens,
			CachedTokens:     msg.CachedTokens,
			CacheWriteTokens: msg.CacheWriteTokens,
			StopReason:       msg.StopReason,
		},
		StartTime:   time.Now(),
		ModelConfig: w.resolveModelConfig(),
	}); err != nil {
		w.log.Error("Failed to save autonomous-turn transaction blob: %v", err)
	}

	// Flush so the autonomous turn syncs to the browser promptly; the items
	// observer will drive the reducer on the next tick (an assistant message at
	// root with no pending activity is inert).
	w.batcher.Flush()
}

func (w *ConversationWorker) handleCancel() {
	// Unwind any engine-driven strategy execution (e.g. plan onWorkerIdle's
	// _driveExecution loop): the worker cancels the turn/tools below, but the
	// driver loop lives in the engine and must abort its controller so it stops
	// rather than continuing to the next step. Fire-and-forget to the engine.
	w.dispatchCancelStrategyExecution()

	if w.loadState() == StateProcessing {
		w.storeState(StateCancelling)
		if p := w.llmCancelFunc.Swap(nil); p != nil {
			(*p)()
		}
		// Release any parked provider subprocess that the ctx-cancel above
		// doesn't reach. Critical for claudecode: between the CLI emitting
		// stop_reason=tool_use and the strategy loop transitioning to
		// AwaitingLLM, state is still Processing but llmCancelFunc has
		// already been nil'd by callLLM's defer. Without this call the
		// claudecode session is left in memory with pendingToolIDs set and
		// a live CLI parked inside MCP — the next user message would route
		// through isContinuation/continueSession and the CLI would resume
		// the abandoned turn, never seeing the new user input. The release is
		// warm-preserving: sessionUUID survives so the next turn --resumes warm.
		if w.cancelLLMSession != nil {
			w.cancelLLMSession(w.conversationID)
		}
		return
	}

	// Non-blocking tool wait: the worker is idle but a turn is parked in
	// activity="awaiting_llm" (a tool batch awaiting approval, or in-flight
	// tools/threads). How we cancel depends on what is actually blocking.
	if w.getActivity() == ActivityAwaitingLLM {
		threadID := w.getProcessingThreadItemID()
		// Decide BEFORE cancelling — cancelling flips pending → cancelled.
		pureApproval := w.blockedOnlyByApprovals()

		// Stop everything in this parked turn, including approvals the browser
		// hasn't resolved (the test path has no browser-side approval cancel).
		w.CancelAllToolActions()
		// The provider may have a live subprocess parked inside an MCP
		// tools/call awaiting a result that will now never come — release it so
		// handlers don't block until their 5-minute timeout. The release is
		// warm-preserving: it kills the parked CLI but keeps the resume anchor
		// (sessionUUID/sentCount/sentHash + sidecar). The sidecar always points at
		// the last completed end_turn — a tool_use pause never commits one — so it
		// is a clean prefix the next turn resumes from via regimeResumeDelta, the
		// delta carrying the [cancelled-tool-result, user-new] shape. This holds
		// whether the turn was parked purely on approvals or had real work in
		// flight: re-driving the interrupted tools is prevented by the parking
		// below, NOT by discarding the session. Dropping the warm anchor here
		// would force a multi-minute cold start that re-sends the whole
		// conversation — and that is the common case, since Claude emits
		// multi-tool batches where one tool executes while a sibling still awaits
		// approval, so "real work in flight" is the norm at an approval prompt.
		if w.cancelLLMSession != nil {
			w.cancelLLMSession(w.conversationID)
		}

		if pureApproval {
			// The turn was parked purely on approvals — nothing was executing.
			// Dropping the approvals means "run what I queued, if anything":
			// hand off to the reducer, which continues a queued turn or rests.
			// Deliberately does NOT write idle here — that would clear
			// awaiting_llm before the reducer runs and strand the continuation.
			w.needsReconcile = true
			return
		}

		// Real work was in flight (an approved/running tool, or an open
		// sub-thread). Park: keep any queued messages by promoting them into
		// the thread, then rest — don't silently re-drive the interrupted work.
		w.promotePendingItems(threadID)
		w.sendStatus("idle", "")
		w.resetThreadContext()
	}
}

func (w *ConversationWorker) handleRenderContextItemsResponse(payload json.RawMessage) {
	// Correlate the reply with the in-flight request. The worker broadcasts the
	// render request to every connected client, so it may receive several replies
	// plus late replies to earlier turns. Without this gate a stale reply (e.g.
	// one from a peer that lacks this turn's sub-thread context items) could win
	// the cap-1 slot and be consumed as this turn's context. Drop anything that
	// isn't the reply to the current request; tests inject directly into the
	// channel and so bypass this path.
	if w.expectedContextRequestID == "" {
		return
	}
	var head struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(payload, &head); err == nil && head.RequestID != "" && head.RequestID != w.expectedContextRequestID {
		return
	}
	select {
	case w.contextResultChan <- payload:
	default:
	}
}

func (w *ConversationWorker) handleToolsResult(payload json.RawMessage) {
	select {
	case w.toolsResultChan <- payload:
	default:
	}
}

func (w *ConversationWorker) handleStrategyHookResponse(payload json.RawMessage) {
	select {
	case w.strategyHookResultChan <- payload:
	default:
	}
}

func (w *ConversationWorker) handleBuildSubthreadSpecResponse(payload json.RawMessage) {
	select {
	case w.subthreadSpecResultChan <- payload:
	default:
	}
}

func (w *ConversationWorker) handleSubthreadErrorResponse(payload json.RawMessage) {
	select {
	case w.subthreadErrorResultChan <- payload:
	default:
	}
}

func (w *ConversationWorker) handleYjsSync(payload json.RawMessage) {
	var msg YjsSyncMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	var applyErr error
	if msg.EngineDerived {
		applyErr = w.doc.ApplyEngineDerivedSyncUpdate(msg.Bytes)
	} else {
		applyErr = w.doc.ApplySyncUpdate(msg.Bytes)
	}
	// `origin` identifies WHICH client's sync this was — when a flake's
	// worker doc diverges from a viewer's, the writer of the divergent
	// update is the whole question.
	w.tape.Record("yjs-apply", map[string]any{
		"bytes":         len(msg.Bytes),
		"engineDerived": msg.EngineDerived,
		"err":           applyErr != nil,
		"origin":        w.replyTo,
	})
	if applyErr != nil {
		w.log.Error("Failed to apply sync update: %v", applyErr)
		return
	}

	// Refresh the UndoManager scope after applying remote state. On the first
	// sync the browser may send its own items Y.Array which wins the Yjs
	// conflict, replacing the Go-created array. Without this call the manager
	// keeps watching the stale (tombstoned) array and canUndo stays false.
	w.tracker.RefreshScope()

	// Schedule save to persist frontend updates (metadata, context items, etc.)
	w.scheduleSave()

	// Explicitly check for items changes after applying sync update.
	// ycrdt's items.Observe may not fire for remote updates applied via ApplyUpdate,
	// so we manually trigger change detection to ensure undo tracking works.
	w.handleItemsChange()
}

// handleResyncRequest answers a client's reconnect catch-up: it sends only the
// Yjs ops the client lacks, computed as the delta since the client's state
// vector. This is the cheap path back to consistency after a transient WS drop
// — no full-state re-broadcast, no page reload. A nil/empty vector degenerates
// to full state (equivalent to request-full-state).
func (w *ConversationWorker) handleResyncRequest(payload json.RawMessage) {
	var msg ResyncRequestMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse resync-request: %v", err)
		return
	}
	update := w.doc.GetStateUpdate(msg.StateVector)
	if len(update) > 0 {
		w.sendYjsSync(update)
	}
}

// handleResyncToOrigin pushes the worker's full Yjs state to ONLY the client
// that asked (w.replyTo), not every viewer. It seeds a freshly (re)connected
// engine with the conversations that were already loaded before it attached:
// an on-demand engine that was torn down and recreated starts empty and would
// otherwise never re-load them (it only auto-loads on an incidental yjs-sync),
// so their approved tool-actions would never execute. Skips uninitialized
// workers (their doc isn't loaded yet — handleInit's broadcastFullState will
// cover the engine once init runs).
//
// INTERIM (Phase 0.3): superseded by the worker-driven stateless tool executor,
// after which the engine holds no conversation state and needs no seeding.
func (w *ConversationWorker) handleResyncToOrigin() {
	if !w.initialized {
		return
	}
	state := w.doc.ToState()
	if len(state) > 0 {
		w.reply(YjsSyncMessage{Type: "yjs-sync", Bytes: state})
	}
	// A freshly (re)attached engine has commanded none of this conversation's
	// tools yet. Clear the dedup set so every non-terminal tool-action is
	// commanded again against the new engine instance. Drop in-flight/retry
	// bookkeeping too: any command awaiting an ack from the previous engine will
	// never be answered, so it must not block re-driving against the new one.
	w.commandedToolActions = make(map[string]string)
	w.inFlightToolCommands = make(map[string]string)
	w.toolCommandRetries = make(map[string]int)
	w.inFlightDispatchedAt = make(map[string]time.Time)
	w.toolCommandTimeouts = make(map[string]int)
	// No command is in flight against the new engine yet; disarm the watchdog (the
	// drive below re-arms it if it dispatches).
	w.disarmAckWatchdog()

	// A tool stuck in state=running with no result was being executed by the
	// PREVIOUS engine instance, which has gone away (it never wrote a result).
	// The new engine has no in-flight execution for it and would never command
	// it (driveToolActions only acts on ""/approved). Reset such tools to
	// approved so the drive below re-issues execute-tool against the new engine.
	// This preserves the documented crash-mid-execution double-exec property: a
	// side-effecting tool that partially ran before the engine died is re-run.
	w.resetRunningToolsForReattach()

	// Re-drive: command evaluate-tool ("") / execute-tool (approved) for every
	// non-terminal tool-action (including the ones just reset above) so an
	// approved/running tool the new engine never observed still executes.
	w.driveToolActions()
}

// resetRunningToolsForReattach walks all items (root + nested threads) and
// resets every tool-action in state=running with no result back to approved
// (clearing runningStartedAt), so driveToolActions re-commands execute-tool on
// the freshly attached engine. The previous engine that claimed these tools is
// gone, so leaving them "running" would strand them forever. Worker-managed
// tools (create_thread) are skipped — the worker, not the engine, executes
// them, so an attach doesn't strand them. Clears the dedup entry for each reset
// tool so the subsequent drive re-dispatches.
func (w *ConversationWorker) resetRunningToolsForReattach() {
	// Read the current turn outside the walk's lock (docTurnCounter acquires
	// ycrdtMu itself). A running tool stamped with this turn already had a
	// result delivered to the provider this turn and must NOT be re-executed.
	currentTurn := w.docTurnCounter()

	var ids []string
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if state, _ := m.Get("state").(string); state != StateRunning {
			return false
		}
		if m.Get("result") != nil {
			return false // already finished
		}
		// A result for this still-running tool was already delivered to the
		// provider this turn (buildMessages' auto-continue placeholder feed stamps
		// resultFedTurn). Re-executing it on reattach would double-fire the side
		// effect and re-feed a duplicate — so treat it as terminal-for-this-turn.
		// This is the resultFedTurn CURE (doc.go's "Tool-delivery desync" section,
		// claudecode provider). Field absence (rawFed == nil) means never fed →
		// fall through and reset.
		if rawFed := m.Get("resultFedTurn"); rawFed != nil {
			var fedTurn int64
			switch v := rawFed.(type) {
			case int64:
				fedTurn = v
			case float64:
				fedTurn = int64(v)
			case int:
				fedTurn = int64(v)
			}
			if fedTurn == currentTurn {
				return false
			}
		}
		if name, _ := m.Get("toolName").(string); name == "create_thread" {
			return false // worker-managed: not executed by the engine
		}
		if id, _ := m.Get("toolUseId").(string); id != "" {
			ids = append(ids, id)
		}
		return false
	})
	ycrdtMu.Unlock()

	for _, id := range ids {
		// UpdateToolActionFieldsRecursive acquires ycrdtMu internally, so this
		// must run with the lock released.
		w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
			"state":            StateApproved,
			"runningStartedAt": nil,
		})
		delete(w.commandedToolActions, id)
		delete(w.inFlightToolCommands, id)
		delete(w.toolCommandRetries, id)
		delete(w.inFlightDispatchedAt, id)
		delete(w.toolCommandTimeouts, id)
	}
}

// handleToolCommandAck records the engine's acknowledgement of a tool-command
// (evaluate-tool / execute-tool) and is the confirmed half of the command-driven
// handshake. driveToolActions only marks a command as in-flight when it sends it;
// this ack decides its fate:
//
//   - ok=true  → the engine handled it (evaluated, or claimed→running and ran the
//     side effect to a terminal result — handleExecuteTool awaits executeToolAction
//     before acking). Promote the in-flight entry to commandedToolActions so
//     steady-state re-drives don't re-command a running/terminal tool.
//   - ok=false → the engine could not act (conversation/tool not loaded yet, a
//     lost claim). Clear the in-flight entry and re-drive (needsReconcile) so the
//     command is reissued. Bounded by toolCommandRetries so a permanently-
//     unsatisfiable command can't spin; at the cap the worker latches and logs,
//     deferring recovery to the next engine reattach.
//
// This closes the fire-and-forget hole where a single dropped or no-op'd command
// stranded a tool-action non-terminal forever — "approved a tool, it never
// executed, the item pulses but the tab isn't busy".
func (w *ConversationWorker) handleToolCommandAck(payload json.RawMessage) {
	var msg struct {
		Action    string `json:"action"`
		ToolUseID string `json:"toolUseId"`
		OK        bool   `json:"ok"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	state, inFlight := w.inFlightToolCommands[msg.ToolUseID]
	if !inFlight {
		// Stale or duplicate ack, or the tool already moved on — nothing to do.
		return
	}
	delete(w.inFlightToolCommands, msg.ToolUseID)
	delete(w.inFlightDispatchedAt, msg.ToolUseID)
	// An ack arrived, so the silent-ack watchdog has nothing to do for this id;
	// disarm once nothing else is in flight (no idle wakeups).
	defer w.disarmAckWatchdogIfDrained()

	if msg.OK {
		w.commandedToolActions[msg.ToolUseID] = state
		delete(w.toolCommandRetries, msg.ToolUseID)
		delete(w.toolCommandTimeouts, msg.ToolUseID)
		return
	}

	n := w.toolCommandRetries[msg.ToolUseID] + 1
	w.toolCommandRetries[msg.ToolUseID] = n
	if n > maxToolCommandRetries {
		w.log.Error("[worker] tool-command %s for %s no-op'd %d×; latching to stop re-drive (recovery deferred to reattach)",
			msg.Action, msg.ToolUseID, n)
		w.commandedToolActions[msg.ToolUseID] = state
		return
	}
	// Re-drive: with both maps cleared for this id, the next reconcile re-dispatches
	// the command. The run loop drains needsReconcile after this message returns.
	w.needsReconcile = true
}

// handleEngineTrace persists a diagnostic event the engine emits over its WS
// (sendEngineTrace) into the per-project server log, tagged with this worker's
// conversation. The engine's WebView console is not captured anywhere, so this
// is the only durable record of the engine-side tool-execution lifecycle —
// claim → execute-start → execute-done, and cancel HIT/MISS. A wedge shows up as
// a lifecycle that stops early (e.g. execute-start with no execute-done means the
// tool is stranded inside executeToolAction). Logged raw so new fields the engine
// adds appear without a Go change. Purely diagnostic — no behaviour depends on it.
// Logged at Trace: this is a file-only durable record (3–4 events per tool, plus
// a failed tool's full error blob), kept out of the console even under --verbose.
// Recover it with the file log when diagnosing a wedge.
func (w *ConversationWorker) handleEngineTrace(payload json.RawMessage) {
	w.log.Trace("[engine-trace] conv=%s %s", w.conversationID, string(payload))
}

// conversationName returns the current human-readable tab name, derived from the
// conversation's on-disk folder (the source of truth for the name). Empty when
// unknown — before projectPath is set, with no path provider, or for an
// unparseable folder — in which case the log file falls back to a bare conv-id
// filename.
func (w *ConversationWorker) conversationName() string {
	if w.pathProvider == nil {
		return ""
	}
	dir, ok := w.pathProvider(w.conversationID)
	if !ok || dir == "" {
		return ""
	}
	name, _, ok := core.ParseDirName(filepath.Base(dir))
	if !ok {
		return ""
	}
	return name
}

// handleRenameLog re-derives the tab name from the (already-renamed) folder and
// moves the per-conversation log file to match, so its filename tracks the tab
// title. Triggered by the rename API via the manager. Runs on the worker's run
// goroutine; jlog.Logger.Rename itself serializes against concurrent writes.
func (w *ConversationWorker) handleRenameLog() {
	if w.log == nil {
		return
	}
	newPath := logpaths.ConversationLogPath(w.projectPath, w.conversationID, w.conversationName())
	w.log.Rename(newPath)
}

func (w *ConversationWorker) handleUndo(payload json.RawMessage) {
	w.handleUndoOrRedo(w.tracker.Undo, payload)
}

func (w *ConversationWorker) handleRedo(payload json.RawMessage) {
	w.handleUndoOrRedo(w.tracker.Redo, payload)
}

func (w *ConversationWorker) handleUndoOrRedo(fn func() bool, payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse undo/redo message: %v", err)
		return
	}
	// Stop any in-flight strategy loop before we start mutating the document.
	// Without this, an undo issued while the worker is mid-turn would race
	// the rollback against the worker's writes, and worse, when the strategy
	// loop's defers finally run (writing a fallback result, transitioning to
	// idle, etc.) they would overwrite the just-restored state. Cancelling
	// first puts the worker on a path to Idle so the undo lands cleanly.
	w.cancelAndWaitForIdle()

	// Suppress the items observer for the duration of the undo. Otherwise
	// the UndoManager's restoration of items (e.g. a thread with a trailing
	// user message) immediately tickles the reducer, which dispatches a new
	// LLM turn — the user's undo would visibly do nothing because the worker
	// fights it. Same reason we clear needsReconcile afterwards.
	w.suppressItemsChange = true
	success := fn()
	// The Yjs items observer fires synchronously inside fn(), enqueueing
	// docChangeChan signals. Drain them before clearing suppressItemsChange
	// so the next event-loop tick doesn't run handleItemsChange against
	// the post-undo state and tickle the reducer.
	select {
	case <-w.docChangeChan:
	default:
	}
	w.suppressItemsChange = false
	w.needsReconcile = false

	// Clear any in-flight activity marker. The user explicitly reverted
	// state; awaiting_llm or calling_llm semantics from before the undo
	// no longer apply. Without this, the reducer would dispatch a new LLM
	// turn the moment the next docChangeChan signal arrives — because the
	// post-undo doc ([..., user]) plus activity="awaiting_llm" matches
	// decideNextAction's ItemTypeUser-AwaitingLLM = CallLLM branch.
	// Note: this is a no-op if activity was already None.
	w.releaseLLM()
	// Keep suppressing reducer advancement for immediate post-undo/redo Yjs sync
	// echoes. This is time-bounded so later Yjs-originated user actions (approval
	// clicks) still drive the reducer normally.
	w.suppressReconcileAfterHistoryNavUntilMs = time.Now().UnixMilli() + 500

	// Flush Yjs sync BEFORE ACK so frontend state is updated when undo()/redo() returns
	w.batcher.Flush()
	w.reply(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": success,
	})
}

// handleBeginUndoCoalesce snapshots the current undo-stack height so a
// browser-driven multi-step command (e.g. /clear: wipe history + re-seed auto
// items) can be collapsed into a single undo group by the matching end marker.
// Closes the capture window first so the command's first mutation starts a
// fresh group exactly at the snapshotted index. The command's mutations arrive
// as ordered yjs-sync frames on the same channel after this marker, so the
// snapshot reflects state strictly before the command's first write.
func (w *ConversationWorker) handleBeginUndoCoalesce() {
	w.tracker.StopCapturing()
	w.undoCoalesceFromIdx = w.tracker.UndoStackLen()
}

// handleEndUndoCoalesce collapses every undo group added since the matching
// begin marker into one, so the bracketed command reverts in a single undo.
// Structurally identical to the compaction merge (see MergeFromIndex); a no-op
// when zero or one group was added. Acks so the browser can await completion.
func (w *ConversationWorker) handleEndUndoCoalesce(payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	_ = json.Unmarshal(payload, &msg)
	if w.undoCoalesceFromIdx >= 0 {
		w.tracker.MergeFromIndex(w.undoCoalesceFromIdx)
		w.tracker.StopCapturing()
		w.undoCoalesceFromIdx = -1
	}
	w.batcher.Flush()
	w.reply(map[string]any{
		"type":  "ack",
		"ackId": msg.AckID,
	})
}

// cancelAndWaitForIdle stops any in-flight strategy loop and blocks (briefly)
// until the worker reaches StateIdle. Called before undo/redo so the document
// rollback can't be raced by the strategy's deferred writes.
func (w *ConversationWorker) cancelAndWaitForIdle() {
	if w.loadState() == StateIdle {
		return
	}
	w.handleCancel()
	// Wait up to ~1s for the strategy goroutine to honour the cancel and
	// transition to Idle. Polling is acceptable here: undo is rare and the
	// strategy loop checks its state every iteration / on LLM cancel.
	for i := 0; i < 100; i++ {
		if w.loadState() == StateIdle {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (w *ConversationWorker) handleReopenThread(payload json.RawMessage) {
	var msg ReopenThreadMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse reopen-thread message: %v", err)
		return
	}
	success := w.clearThreadResult(msg.ThreadItemID)
	w.batcher.Flush()
	w.reply(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": success,
	})
}

// handleCloseThreadWithLastMessage closes an open thread by promoting its
// trailing assistant message as the result — the footer's "Close with last
// message" action. No LLM turn: it reuses the same trailing-assistant-text
// selection the auto-fallback once applied, now triggered only on demand.
func (w *ConversationWorker) handleCloseThreadWithLastMessage(payload json.RawMessage) {
	var msg CloseThreadWithLastMessageMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse close-thread-with-last-message message: %v", err)
		return
	}
	success := w.closeThreadWithLastMessage(msg.ThreadItemID)
	w.batcher.Flush()
	w.reply(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": success,
	})
}

// handleClearHistory clears all items (unified storage includes context items).
// Clear is the one thread-wide mutator that must also remember the pending
// (queued-message) staging array — wipe it alongside the items.
func (w *ConversationWorker) handleClearHistory() {
	w.tracker.ClearAll()
	w.clearPendingItems("")
}

// resetToolActionAndRedrive is the shared tail of the retry handlers: it writes
// the given field reset onto the tool-action (recursively, so sub-thread tools
// are found), drops all in-flight/retry/timeout bookkeeping so a wedged command
// can't block the retry, then re-requests the LLM for the owning thread and
// re-commands the tool via driveToolActions. Callers supply only the field map
// that distinguishes a re-ask (state="") from a re-run (state="approved").
func (w *ConversationWorker) resetToolActionAndRedrive(toolUseID string, fields map[string]any) {
	w.doc.UpdateToolActionFieldsRecursive(toolUseID, fields)

	// Drop the dedup entry so driveToolActions re-dispatches even though the
	// tool was already commanded at its prior state, plus all outstanding
	// in-flight/retry/timeout bookkeeping so a wedged command doesn't block.
	w.clearToolCommandBookkeeping(toolUseID)

	// Signal that the reducer should dispatch CallLLM once the tool reaches a
	// terminal state again. "" targets the root thread.
	threadID, _ := w.doc.FindThreadIDForToolUseID(toolUseID)
	w.requestLLM(threadID)

	// The reset is driven by the worker: driveToolActions pushes the new state
	// to the engine and re-commands the tool so the retry actually runs.
	w.driveToolActions()
}

// handleRetryToolApproval re-asks a completed tool-action (e.g.
// AskUserQuestion) by resetting it to the *unevaluated* state ("") and
// clearing every derived field: the result and approvalResponse (so the prior
// answer isn't reused), plus the approvalOptions and displayData (the cached
// approval form). This is deliberately a full reset rather than a patch to
// 'pending': the empty state makes the frontend reducer treat the tool-action
// as brand-new and re-run handleNewToolAction, which re-derives a fresh
// approval form from the tool's (immutable) toolInput — exactly like a
// first-time ask. A mere patch to 'pending' would keep the stale derived
// fields, rendering the question form from a post-completion displayData and
// dropping its questions.
func (w *ConversationWorker) handleRetryToolApproval(payload json.RawMessage) {
	var msg struct {
		ToolUseID string `json:"toolUseId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	// Empty state = "not yet evaluated". The frontend reducer's empty-state
	// branch re-runs handleNewToolAction, which rebuilds approvalOptions +
	// displayData and writes 'pending'. Clearing the derived fields (result,
	// approvalResponse, approvalOptions, displayData) makes the re-ask look
	// brand-new so a fresh approval form is derived from the immutable toolInput.
	w.resetToolActionAndRedrive(msg.ToolUseID, map[string]any{
		"state":            StateUnevaluated,
		"result":           nil,
		"approvalResponse": nil,
		"approvalOptions":  nil,
		"displayData":      nil,
	})
}

// handleMoveContextItemMessageToEnd moves a context item placeholder message to the end of items
func (w *ConversationWorker) handleMoveContextItemMessageToEnd(payload json.RawMessage) {
	var msg struct {
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	items := w.doc.GetItems()
	for i, item := range items {
		if item.ItemID == msg.ItemID && item.Type != ItemTypeToolAction {
			// Remove from current position and add to end
			w.doc.DeleteMessages([]int{i})
			w.tracker.InsertMessage(w.doc.GetItemsLength(), item)
			break
		}
	}
}

// handleUpdateAndRepositionToolActions updates tool actions with new hash and repositions changed ones
func (w *ConversationWorker) handleUpdateAndRepositionToolActions(payload json.RawMessage) {
	var msg struct {
		ItemID  string `json:"itemId"`
		NewHash int    `json:"newHash"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	// Find all tool-actions for this context item, update hash on data, reposition if changed
	items := w.doc.GetItems()
	for i := len(items) - 1; i >= 0; i-- {
		item := items[i]
		if item.ItemID == msg.ItemID && item.Type == ItemTypeToolAction {
			// Update the hash in data
			var data map[string]any
			if item.Data != nil {
				_ = json.Unmarshal(item.Data, &data)
			}
			if data == nil {
				data = make(map[string]any)
			}

			oldHash, _ := data["hash"].(float64)
			if int(oldHash) != msg.NewHash {
				data["hash"] = msg.NewHash
				newData, _ := json.Marshal(data)
				item.Data = newData
				// Remove and re-add at end
				w.doc.DeleteMessages([]int{i})
				w.tracker.InsertMessage(w.doc.GetItemsLength(), item)
				// Refresh items since we modified the array
				items = w.doc.GetItems()
			}
		}
	}
}

// handleRetryToolAction resets a tool action for re-run. It writes the
// doc change (state=approved, result=nil) and sets activity="awaiting_llm"
// so the thread reducer dispatches the LLM call when the tool completes.
func (w *ConversationWorker) handleRetryToolAction(payload json.RawMessage) {
	var msg struct {
		ToolUseID string `json:"toolUseId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	w.tape.Record("retry-tool", map[string]any{
		"toolUseId": msg.ToolUseID,
		"origin":    w.replyTo,
	})

	// Set state='approved' and clear result. Writing 'approved' (the
	// "ready to run" state) lets the frontend reducer atomically
	// claim it → 'running' → execute exactly once.
	//
	// Clear runningStartedAt too: it anchors the properties panel's "Running…
	// Xs" elapsed digit and is re-stamped by the frontend's claimRunning on the
	// next APPROVED→RUNNING transition. Clearing it authoritatively here (single
	// writer) means a re-run's elapsed timer restarts from zero rather than
	// carrying on from the prior run — and if the engine is slow to re-claim,
	// the viewer shows a plain "Running…" instead of a stale climbing number.
	w.resetToolActionAndRedrive(msg.ToolUseID, map[string]any{
		"state":            StateApproved,
		"result":           nil,
		"runningStartedAt": nil,
	})
}

// handleUpdateToolActionForRetry updates approval options and display data for retry
func (w *ConversationWorker) handleUpdateToolActionForRetry(payload json.RawMessage) {
	var msg struct {
		ToolUseID       string          `json:"toolUseId"`
		ApprovalOptions json.RawMessage `json:"approvalOptions"`
		DisplayData     json.RawMessage `json:"displayData"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	fields := map[string]any{}
	if msg.ApprovalOptions != nil {
		fields["approvalOptions"] = msg.ApprovalOptions
	}
	if msg.DisplayData != nil {
		fields["displayData"] = msg.DisplayData
	}
	if len(fields) > 0 {
		w.doc.UpdateToolActionFieldsRecursive(msg.ToolUseID, fields)
	}
}

// handleRepositionContextItemPlaceholder clears itemId and sets placeholder content for a context item
func (w *ConversationWorker) handleRepositionContextItemPlaceholder(payload json.RawMessage) {
	var msg struct {
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	w.doc.UpdateToolActionByItemIDRecursive(msg.ItemID, map[string]any{
		"itemId":  "",
		"content": "(context item was repositioned)",
	})
}
