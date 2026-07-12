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

// Subthread delegation lets a context-item tool (delegatesToSubthread in its
// MANIFEST) run one invocation as a child agent turn instead of a client-side
// tool-action. When the LLM calls such a tool, the worker asks the engine to
// build a SubthreadSpec (validate + buildSubthreadSpec, browser-side); a spec
// spawns a delegated child thread stamped with the tool_use coordinates (so the
// child's return_result flows back as THIS tool's tool_result via the existing
// create_thread machinery), while a null spec falls back to the ordinary
// tool-action. The child's working context never costs the parent a token.
//
// Nearly everything reuses create_thread: tool-use stamping, hasIncompleteThreads
// parking, signalParentThread resume, return_result, resultSpec, maxThreadDepth.
// The only genuinely new wiring is the build-spec round-trip (here) and the
// open-end resolution (resolveDelegatedThreadResult) that guarantees a delegated
// child ALWAYS yields a tool_result so the parent turn is never stranded.

// SubthreadSpecTimeout bounds the build-spec round-trip. On timeout the worker
// falls back to the ordinary client-side tool-action, so a slow/absent engine
// degrades to normal execution rather than wedging the turn.
var SubthreadSpecTimeout = 10 * time.Second

// SubthreadErrorTimeout bounds the onSubthreadError fallback round-trip. On
// timeout the worker writes the default error result.
var SubthreadErrorTimeout = 8 * time.Second

// collectDelegatingToolNames returns the set of tool names in tools whose
// definition carries DelegatesToSubthread. Rebuilt each turn from the tools the
// engine offered.
func collectDelegatingToolNames(tools []ToolDefinition) map[string]bool {
	var set map[string]bool
	for _, t := range tools {
		if t.DelegatesToSubthread {
			if set == nil {
				set = make(map[string]bool)
			}
			set[t.Name] = true
		}
	}
	return set
}

// withinDelegatedThread reports whether threadItemID or any ancestor thread was
// itself spawned by delegation (its Y.Map carries delegated=true). Delegating
// tools are disabled inside such a thread — they run inline and return raw
// content instead of spawning yet another child. This is the structural
// invariant that stops a recursive subthread cascade: a delegated sub-agent is
// never handed a tool that can start a further delegation, so nesting can't run
// away regardless of what the child's prompt asks it to do. Walks the parent
// chain under one lock (mirrors threadDepth).
func (w *ConversationWorker) withinDelegatedThread(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	items := w.doc.getItems()
	for tid := threadItemID; tid != ""; tid = w.doc.findParentThreadID(tid) {
		if m := findThreadYMap(items, tid); m != nil {
			if delegated, _ := m.Get("delegated").(bool); delegated {
				return true
			}
		}
	}
	return false
}

// tryDelegateTool attempts to run a delegating tool call as a subthread. It
// returns true when a delegated child thread was spawned (the parent then parks
// on hasIncompleteThreads and the reducer dispatches the child); false means the
// caller should run the tool the ordinary way via addToolAction — because the
// tool doesn't delegate, we're at the nesting-depth cap, the engine returned a
// null spec (conditional "not this time"), or the round-trip failed/timed out.
func (w *ConversationWorker) tryDelegateTool(toolUseID, toolName string, toolInput json.RawMessage) bool {
	if !w.turnDelegatingTools[toolName] {
		return false
	}

	// A delegated child sits one level below the current thread. At the depth
	// cap, don't spawn another level — fall back to running the tool inline so
	// the call still completes (mirrors executeCreateThread's depth guard, but
	// degrades to execution rather than refusing, since this is a real tool).
	if depth := w.doc.threadDepth(w.thread.itemID); depth >= maxThreadDepth {
		w.log.Info("[worker] %s may delegate but thread depth cap (%d) reached — running inline", toolName, maxThreadDepth)
		return false
	}

	requestID := generateRequestID()
	// Drop any stale reply buffered by a previously timed-out request so the
	// requestID match below can't trip over it (mirrors callLLM/maybeActivate).
	select {
	case <-w.subthreadSpecResultChan:
	default:
	}
	w.dispatchBuildSubthreadSpec(requestID, toolUseID, toolName, toolInput)
	spec, ok := w.waitForSubthreadSpec(requestID, SubthreadSpecTimeout)
	if !ok || spec == nil {
		return false // null spec / error / timeout → ordinary tool-action
	}

	if _, err := w.createThread(CreateThreadOptions{
		Goal:       spec.Goal,
		Prompt:     spec.Prompt,
		ResultSpec: spec.ResultSpec,
		ToolUseID:  toolUseID,
		ToolName:   toolName,
		ToolInput:  toolInput,
		Delegated:  true,
	}); err != nil {
		w.log.Error("[worker] delegated thread creation failed for %s: %v", toolName, err)
		return false
	}
	return true
}

// dispatchBuildSubthreadSpec sends a build-subthread-spec request to the engine
// only (targeted, never broadcast), so the decision runs exactly once. Mirrors
// dispatchStrategyHook.
func (w *ConversationWorker) dispatchBuildSubthreadSpec(requestID, toolUseID, toolName string, toolInput json.RawMessage) {
	data, err := json.Marshal(BuildSubthreadSpecRequest{
		Type:      "build-subthread-spec",
		RequestID: requestID,
		ToolUseID: toolUseID,
		ToolName:  toolName,
		ToolInput: toolInput,
	})
	if err != nil {
		w.log.Error("[worker] marshal build-subthread-spec (%s): %v", toolName, err)
		return
	}
	w.tape.Record("build-subthread-spec-dispatch", map[string]any{"tool": toolName, "req": requestID})
	w.callbacks.sendToEngine(data)
}

// waitForSubthreadSpec blocks until the engine answers requestID with a spec
// (or null), or the timeout elapses. Returns (spec, true) on a matching reply
// — spec may be nil, meaning "run the tool normally" — and (nil, false) on
// error/timeout/cancellation. Keeps servicing inbound + doc/batcher signals so
// the single run goroutine never deadlocks (mirrors waitForStrategyHook).
func (w *ConversationWorker) waitForSubthreadSpec(requestID string, timeout time.Duration) (*SubthreadSpec, bool) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case raw := <-w.subthreadSpecResultChan:
			var resp BuildSubthreadSpecResponse
			if err := json.Unmarshal(raw, &resp); err == nil && resp.RequestID == requestID {
				if resp.Error != "" {
					w.log.Info("[worker] build-subthread-spec (%s): engine reported %q — running inline", requestID, resp.Error)
					return nil, false
				}
				w.tape.Record("build-subthread-spec-response", map[string]any{"req": requestID, "delegated": resp.Spec != nil})
				return resp.Spec, true
			}
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return nil, false
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-timer.C:
			w.log.Info("[worker] build-subthread-spec timed out (req %s) — running tool inline", requestID)
			w.tape.Record("build-subthread-spec-timeout", map[string]any{"req": requestID})
			return nil, false
		case <-w.done:
			return nil, false
		}
	}
}

// resolveDelegatedThreadResult guarantees a delegated child that ended WITHOUT
// calling return_result still yields a tool_result, so the parent's stamped
// tool_use is never stranded (an unpaired tool_use is rejected by the provider).
// A child that closed via return_result already has a result and is skipped.
//
// Resolution order (spec §4.4): promote the child's clean trailing assistant
// text; else run the tool's onSubthreadError fallback (engine round-trip); else
// write a default message. Whatever it resolves is written as the thread result,
// which appendThreadMessages then emits as the paired tool_result and
// signalParentThread delivers to the parent.
func (w *ConversationWorker) resolveDelegatedThreadResult(threadItemID string) {
	if threadItemID == "" {
		return
	}

	// One lock window to read the thread's state AND its trailing text (a
	// concurrent sync could tombstone the YMap between separate windows).
	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		return
	}
	result, _ := threadYMap.Get("result").(string)
	delegated, _ := threadYMap.Get("delegated").(bool)
	toolName, _ := threadYMap.Get("toolName").(string)
	toolInput := yMapRawJSON(threadYMap, "toolInput")
	var trailing string
	if arr := findThreadItemsArray(w.doc.getItems(), threadItemID); arr != nil {
		trailing = selectThreadFallbackResult(w.doc.getItemsFromArrayLocked(arr))
	}
	ycrdtMu.Unlock()

	if !delegated || result != "" {
		return // not a delegated thread, or return_result already closed it
	}

	resolved := trailing
	if resolved == "" {
		// No clean trailing text (errored or barren end): give the tool a chance
		// to degrade gracefully via onSubthreadError. Round-trip runs WITHOUT the
		// lock held (it blocks servicing inbound).
		resolved = w.requestSubthreadErrorFallback(toolName, toolInput)
	}
	if resolved == "" {
		resolved = fmt.Sprintf("The delegated %s sub-agent ended without returning a result.", displayToolName(toolName))
	}

	// Write under the lock, re-resolving the pointer and re-checking the result
	// (a return_result could have landed via a serviced inbound message during
	// the fallback round-trip).
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	ym := findThreadYMap(w.doc.getItems(), threadItemID)
	if ym == nil {
		return
	}
	if existing, _ := ym.Get("result").(string); existing != "" {
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		ym.Set("result", resolved)
	}, w.doc.authorID)
	w.log.Info("[worker] resolved delegated thread %s result (%d chars)", threadItemID, len(resolved))
}

// requestSubthreadErrorFallback runs the delegating tool's onSubthreadError hook
// on the engine and returns the fallback tool_result text, or "" if the tool
// provides none (or the round-trip fails/times out).
func (w *ConversationWorker) requestSubthreadErrorFallback(toolName string, toolInput json.RawMessage) string {
	if toolName == "" {
		return ""
	}
	if !w.ensureEngineReady() {
		return ""
	}
	requestID := generateRequestID()
	select {
	case <-w.subthreadErrorResultChan:
	default:
	}
	reason := "the sub-agent ended without returning a result"
	data, err := json.Marshal(SubthreadErrorRequest{
		Type:      "subthread-error",
		RequestID: requestID,
		ToolName:  toolName,
		ToolInput: toolInput,
		Reason:    reason,
	})
	if err != nil {
		return ""
	}
	w.tape.Record("subthread-error-dispatch", map[string]any{"tool": toolName, "req": requestID})
	w.callbacks.sendToEngine(data)
	return w.waitForSubthreadError(requestID, SubthreadErrorTimeout)
}

// waitForSubthreadError blocks until the engine answers requestID with the
// fallback text, or the timeout elapses. Returns "" on no-fallback/timeout.
func (w *ConversationWorker) waitForSubthreadError(requestID string, timeout time.Duration) string {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case raw := <-w.subthreadErrorResultChan:
			var resp SubthreadErrorResponse
			if err := json.Unmarshal(raw, &resp); err == nil && resp.RequestID == requestID {
				return resp.Result
			}
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return ""
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-timer.C:
			w.tape.Record("subthread-error-timeout", map[string]any{"req": requestID})
			return ""
		case <-w.done:
			return ""
		}
	}
}

// displayToolName returns a human-friendly tool name for the default result
// message, falling back to a generic label for an empty name.
func displayToolName(toolName string) string {
	if toolName == "" {
		return "delegated tool"
	}
	return toolName
}
