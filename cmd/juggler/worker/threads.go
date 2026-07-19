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

// CreateThreadOptions describes a thread to be created via createThread.
//
// Three callsites construct one of these:
//   - executeCreateThread (tool-driven from LLM)      — ToolUseID set
//   - handleCreateThread (WS-driven from browser)     — ExternalDispatch=true
//   - pendingRequests orchestrator                    — ExternalDispatch=true
type CreateThreadOptions struct {
	Goal   string
	Prompt string

	// ResultSpec, when set, is the caller's contract for what the child's
	// return_result summary must contain. It is stored on the thread Y.Map
	// (surfaced in the column header) and appended to the child's seed message
	// so the child acts on it. Optional: an empty spec changes nothing.
	ResultSpec string

	IsContinuation bool

	// Tool-use coordinates: when set, the toolUseId/toolName/toolInput are
	// stamped on the new thread's Y.Map so the parent's buildMessages can
	// reconstruct the tool_use/tool_result pair the LLM expects to see.
	ToolUseID string
	ToolName  string
	ToolInput json.RawMessage

	// Delegated marks a thread spawned by a delegatesToSubthread tool (not the
	// create_thread meta-tool). It is stamped onto the thread Y.Map so the
	// strategy-loop defer can guarantee an open-ended delegated child still
	// resolves a result (resolveDelegatedThreadResult) — the parent's stamped
	// tool_use must always be paired with a tool_result. Tool-use coordinates
	// (ToolUseID/ToolName/ToolInput) are set exactly as for create_thread.
	Delegated bool

	// ParentThreadItemID, if non-empty, switches w.thread to that parent
	// before creating the new thread (used by ExternalDispatch entry points
	// to scope into a specific parent). Empty means: keep the current scope.
	ParentThreadItemID string

	// StrategyID and ModelConfigJSON, when set, override the new thread's
	// strategy and model — stamped on its Y.Map as currentStrategyId /
	// modelConfig so getEffectiveStrategyId / ResolveEffectiveModelConfig
	// resolve them. Used by user-defined subthread commands to run their prompt
	// under a different (e.g. read-only) strategy or model than the parent.
	// ModelConfigJSON is the JSON encoding of a {provider, model, ...} object;
	// empty/invalid leaves the thread inheriting the parent's model.
	StrategyID      string
	ModelConfigJSON string

	// ExternalDispatch=true marks the WS/orchestrator entry path: the worker
	// must be idle, the effective model must be set, the new thread is
	// marked strategyCreated, and the LLM is dispatched via requestLLM+
	// tryReconcile after creation. Tool-driven creation (ExternalDispatch=
	// false) is marked llmCreated and leaves dispatch to the strategy loop's
	// hasIncompleteThreads check.
	ExternalDispatch bool
}

// createThread is the single thread-creation entry point. The three public
// wrappers below differ only in how they assemble CreateThreadOptions; the
// mutation/dispatch policy lives here.
func (w *ConversationWorker) createThread(opts CreateThreadOptions) (string, error) {
	if opts.Goal == "" {
		opts.Goal = "Thread"
	}

	if opts.ExternalDispatch {
		if w.loadState() != StateIdle {
			return "", fmt.Errorf("worker not idle (state=%s)", w.loadState())
		}
	}

	// Optional parent context switch. Restored on return so callers can
	// dispatch from any current scope. ExternalDispatch with empty parent
	// also re-roots to root scope for the duration of the call.
	var prevThread threadContext
	restoreThread := false
	if opts.ParentThreadItemID != "" {
		prevThread = w.thread
		restoreThread = true
		w.thread.itemID = opts.ParentThreadItemID
		w.thread.itemsArray = w.doc.GetThreadItemsArray(opts.ParentThreadItemID)
		if w.thread.itemsArray == nil {
			w.thread = prevThread
			return "", fmt.Errorf("thread item %s not found", opts.ParentThreadItemID)
		}
	} else if opts.ExternalDispatch {
		prevThread = w.thread
		restoreThread = true
		w.resetThreadContext()
	}
	if restoreThread {
		defer func() {
			w.thread = prevThread
		}()
	}

	if opts.ExternalDispatch {
		mc := w.doc.ResolveEffectiveModelConfig(opts.ParentThreadItemID)
		if mc == nil || mc.Model == "" {
			return "", fmt.Errorf("please select a model before creating a thread")
		}
	}

	// Create thread item with nested Y.Array (in the current target array).
	// Use the tracker (authorID origin) so the insertion is tracked by the
	// UndoManager and can be undone independently.
	targetArr := w.getTargetItemsYArray()
	insertIdx := w.getTargetItemsLength()
	nestedItems := w.tracker.InsertThreadIntoArray(targetArr, insertIdx, opts.Goal)

	// Get the thread's itemId and store tool_use coordinates (for LLM-created
	// threads) on the thread Y.Map.
	var threadItemID string
	ycrdtMu.Lock()
	raw := targetArr.Get(ycrdt.Number(insertIdx))
	if m, ok := raw.(*ycrdt.YMap); ok {
		threadItemID, _ = m.Get("itemId").(string)
		w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
			if opts.ResultSpec != "" {
				m.Set("resultSpec", opts.ResultSpec)
			}
			if opts.ExternalDispatch {
				m.Set("strategyCreated", true)
			} else {
				m.Set("llmCreated", true)
			}
			// Optional per-thread strategy/model overrides (user-defined
			// subthread commands). Stamped so getEffectiveStrategyId /
			// ResolveEffectiveModelConfig resolve them on the new thread.
			if opts.StrategyID != "" {
				m.Set("currentStrategyId", opts.StrategyID)
			}
			if opts.ModelConfigJSON != "" {
				var mc map[string]any
				if err := json.Unmarshal([]byte(opts.ModelConfigJSON), &mc); err == nil && len(mc) > 0 {
					m.Set("modelConfig", convertToYcrdt(mc))
				}
			}
			if opts.Delegated {
				m.Set("delegated", true)
			}
			if opts.ToolUseID != "" {
				m.Set("toolUseId", opts.ToolUseID)
				m.Set("toolName", opts.ToolName)
				if len(opts.ToolInput) > 0 {
					// Persist as a structured object the way conversationItemToYMap
					// stores every other json.RawMessage field. Storing the raw
					// bytes as a Go string would round-trip through yMapRawJSON
					// as a JSON-encoded *string literal*, which buildToolUseMap
					// then fails to unmarshal into map[string]any — the wire
					// payload reaches the provider with "input": null and the
					// model rejects/ignores the tool_use block.
					var parsed map[string]any
					if err := json.Unmarshal(opts.ToolInput, &parsed); err == nil {
						m.Set("toolInput", convertToYcrdt(parsed))
					}
				}
			}
		}, w.doc.authorID)
	}
	ycrdtMu.Unlock()

	// Seed the new thread's starting context by cloning the parent's standing
	// items (system prompt, agents files, memory) into the head of the child's
	// array, each with a fresh id. targetArr is the parent array (root array
	// when creating at root scope). Continuations already carry their seeds.
	if !opts.IsContinuation {
		w.doc.SeedThreadFromParent(targetArr, nestedItems)
	}

	// Insert user message into the child thread's items array, AFTER the seeds
	// so the starting context reads top-to-bottom and stays the leading run at
	// this depth. When a resultSpec is set, append it as an explicit return
	// contract at the point of action (the child's own first message),
	// mirroring the close-thread path's return_result instruction.
	if !opts.IsContinuation && opts.Prompt != "" {
		content := opts.Prompt
		if opts.ResultSpec != "" {
			content += "\n\n---\nWhen you finish, call return_result with: " + opts.ResultSpec
		}
		msg := ConversationItem{
			Type:      ItemTypeUser,
			ItemID:    generateItemID(),
			Content:   content,
			Timestamp: time.Now().Format(time.RFC3339),
		}
		w.doc.InsertMessageIntoArray(nestedItems, w.doc.GetItemsLengthFromArray(nestedItems), msg)
	}

	if opts.ExternalDispatch {
		w.requestLLM(threadItemID)
		w.needsReconcile = true
		w.drainReconcile()
	}

	return threadItemID, nil
}

// maxThreadDepth caps how deeply create_thread may nest threads. Root is depth
// 0, a thread directly under it depth 1; a thread at this depth may no longer
// spawn a child. It is a runaway backstop, not a workflow limit — the deepest
// legitimate nesting in practice is two or three levels — so an LLM that keeps
// delegating instead of doing the work itself is stopped before it recurses
// without bound. Guards only the LLM tool path, not user/orchestrator dispatch.
const maxThreadDepth = 3

// maxLiveThreads caps how many create_thread-spawned threads may be in flight
// (llmCreated, no result yet) across the whole document at once. Where
// maxThreadDepth bounds nesting along a single chain, this bounds fan-out across
// the whole tree: a model that keeps decomposing one task into fresh subthreads
// without ever deepening the chain stays within the depth cap but explodes in
// breadth (N children per level ≈ N^depth threads). This is the backstop the
// depth cap misses. It counts only in-flight threads, so it self-heals as
// children return_result — legitimate sequential delegation never approaches it,
// while a runaway fan-out trips it fast. Guards only the LLM tool path.
const maxLiveThreads = 16

// executeCreateThread handles the create_thread tool: parses tool input and
// dispatches via createThread. Called from processLLMResponse when the LLM
// emits a create_thread block.
func (w *ConversationWorker) executeCreateThread(toolUseID, toolName string, toolInput json.RawMessage) error {
	var input struct {
		Goal       string `json:"goal"`
		Prompt     string `json:"prompt"`
		ResultSpec string `json:"resultSpec"`
	}
	if err := json.Unmarshal(toolInput, &input); err != nil {
		return fmt.Errorf("failed to parse create_thread input: %w", err)
	}
	if input.Prompt == "" {
		return fmt.Errorf("create_thread: prompt is required")
	}

	// Runaway-recursion guard. The would-be child sits one level below the
	// current processing thread; refuse if that parent is already at the depth
	// cap. The refusal is emitted as a meta-tool-result so the parent's next
	// turn sees a tool_result paired with its own create_thread tool_use (not a
	// dangling tool_use the provider would reject) and is told to continue the
	// sub-task inline rather than spawn another thread.
	if depth := w.doc.threadDepth(w.thread.itemID); depth >= maxThreadDepth {
		msg := fmt.Sprintf("create_thread refused: thread nesting depth limit (%d) reached. "+
			"Do this sub-task inline in the current thread instead of spawning another thread.", maxThreadDepth)
		w.addMetaToolResult(toolUseID, toolName, toolInput, msg, true)
		return nil
	}

	// Runaway fan-out guard. The depth cap above bounds a single chain but not
	// breadth: a model that re-delegates the same task into ever more sibling
	// subthreads stays shallow yet explodes in count. Refuse once too many
	// create_thread children are already in flight, using the same paired
	// meta-tool-result so the parent turn isn't stranded. Self-heals: the count
	// drops as children return_result, so this throttles a runaway without
	// permanently disabling the tool.
	if live := w.doc.liveThreadCount(); live >= maxLiveThreads {
		msg := fmt.Sprintf("create_thread refused: too many threads (%d) are already in progress. "+
			"Do this sub-task inline in the current thread, or wait for running threads to finish "+
			"before spawning more.", live)
		w.addMetaToolResult(toolUseID, toolName, toolInput, msg, true)
		return nil
	}

	_, err := w.createThread(CreateThreadOptions{
		Goal:       input.Goal,
		Prompt:     input.Prompt,
		ResultSpec: input.ResultSpec,
		ToolUseID:  toolUseID,
		ToolName:   toolName,
		ToolInput:  toolInput,
	})
	return err
}

// handleCreateThread handles strategy-driven thread creation requests from the
// browser. Non-blocking: creates the thread item + user message, signals the
// reducer to dispatch, and returns the threadItemId via WS response.
func (w *ConversationWorker) handleCreateThread(payload json.RawMessage) {
	var msg CreateThreadMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse create-thread message: %v", err)
		return
	}
	threadItemID, err := w.createThread(CreateThreadOptions{
		Goal:               msg.Goal,
		Prompt:             msg.Prompt,
		IsContinuation:     msg.IsContinuation,
		ParentThreadItemID: msg.ThreadItemID,
		ExternalDispatch:   true,
	})
	if err != nil {
		w.send(map[string]any{
			"type":      "create-thread-response",
			"requestId": msg.RequestID,
			"error":     err.Error(),
		})
		return
	}
	w.send(map[string]any{
		"type":         "create-thread-response",
		"requestId":    msg.RequestID,
		"threadItemId": threadItemID,
	})
}

// dispatchCreateThread is the orchestrator entry point used by
// pendingRequests. Same semantics as handleCreateThread but returns the
// new thread's itemId directly (no WS response).
func (w *ConversationWorker) dispatchCreateThread(goal, prompt, parentThreadItemID string, isContinuation bool, strategyID, modelConfigJSON string) (string, error) {
	return w.createThread(CreateThreadOptions{
		Goal:               goal,
		Prompt:             prompt,
		IsContinuation:     isContinuation,
		ParentThreadItemID: parentThreadItemID,
		StrategyID:         strategyID,
		ModelConfigJSON:    modelConfigJSON,
		ExternalDispatch:   true,
	})
}
