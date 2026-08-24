//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"time"
)

// Subthread delegation lets a context-item tool (delegatesToSubthread in its
// MANIFEST) run one invocation as a child agent turn instead of a client-side
// tool-action. When the LLM calls such a tool, the worker asks the engine to
// build a SubthreadSpec (validate + buildSubthreadSpec, browser-side); a spec
// spawns a delegated child thread whose invocation message carries the tool_use
// coordinates (so the run's outcome flows back as THIS tool's tool_result via
// the existing create_thread machinery), while a null spec falls back to the
// ordinary tool-action. The child's working context never costs the parent a
// token.
//
// Nearly everything reuses create_thread: run records, hasIncompleteThreads
// parking, signalParentThread resume, resultSpec, maxThreadDepth, and sessions
// (a spec may name one, and then the call continues that child rather than
// spawning a sibling — see sessions.go). The only genuinely new wiring is the
// build-spec round-trip (here). A delegated child needs no open-end handling of
// its own: every run settles into a result, so the parent's stamped tool_use is
// never stranded.

// SubthreadSpecTimeout bounds the build-spec round-trip. On timeout the worker
// falls back to the ordinary client-side tool-action, so a slow/absent engine
// degrades to normal execution rather than wedging the turn.
var SubthreadSpecTimeout = 10 * time.Second

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
// itself spawned by delegation (its Y.Map carries delegated=true). Walks the
// parent chain under one lock (mirrors threadDepth). Prefer delegationBlocked —
// this is one of its two inputs, and callers almost always want the whole
// question rather than half of it.
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

// delegationBlocked answers, for one thread, the single question "may a tool
// call here run as a delegated subthread?" — returning the reason it may not, or
// "" when it may.
//
// It is the only place that question is decided, because two different things
// have to follow from one answer and they must never diverge:
//
//   - tryDelegateTool refuses to delegate, so a tool that also works inline
//     (WebFetch without a prompt still fetches the page) simply runs inline;
//   - filterToolsForThread withholds the tools flagged RequiresDelegation, which
//     have no inline path and so could only fail if the model called them.
//
// The two reasons are the runaway-recursion guards. A delegated thread (or any
// descendant of one) may not delegate again — that is what stops a sub-agent
// cascade, whatever a child's prompt asks it to do — and neither may a thread
// already at maxThreadDepth, since the child would sit one level below it.
//
// Callers must NOT hold ycrdtMu: both inputs take it themselves.
func (w *ConversationWorker) delegationBlocked(threadItemID string) string {
	if w.withinDelegatedThread(threadItemID) {
		return "inside a delegated thread"
	}
	if depth := w.doc.threadDepth(threadItemID); depth >= maxThreadDepth {
		return fmt.Sprintf("at the thread nesting cap (depth %d of %d)", depth, maxThreadDepth)
	}
	return ""
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

	// Delegation is not available here, so run the tool the ordinary way. Only
	// tools that HAVE an ordinary way reach this: filterToolsForThread withheld
	// the RequiresDelegation ones from this turn's list on the same answer,
	// because for those "run it inline" is not a degradation but a failure.
	if reason := w.delegationBlocked(w.thread.itemID); reason != "" {
		w.log.Info("[worker] %s may delegate but is %s — running inline", toolName, reason)
		return false
	}

	requestID := generateRequestID()
	defer w.subthreadSpecReply.arm(requestID)()
	w.dispatchBuildSubthreadSpec(requestID, toolUseID, toolName, toolInput)
	spec, ok := w.waitForSubthreadSpec(requestID, SubthreadSpecTimeout)
	if !ok || spec == nil {
		return false // null spec / error / timeout → ordinary tool-action
	}

	// A spec with nothing to ask is not a delegation: it would spawn a child
	// with no invocation message, so the run it starts has no record to stamp
	// and reports only through the thread's summary. Degrade to running the tool
	// inline, exactly as a null spec does.
	if spec.Prompt == "" {
		w.log.Info("[worker] %s built a spec with no prompt — running inline", toolName)
		return false
	}

	// A spec naming a session this tool already ran in the calling thread
	// invokes that child again instead of spawning a sibling; anything else
	// starts a new session under a name the result reports back.
	session := w.resolveSession(toolName, spec.SessionName)
	opts := CreateThreadOptions{
		Goal:        spec.Goal,
		RunGoal:     spec.Goal,
		Prompt:      spec.Prompt,
		ResultSpec:  spec.ResultSpec,
		ToolUseID:   toolUseID,
		ToolName:    toolName,
		ToolInput:   toolInput,
		SessionName: session.name,
		Delegated:   true,
		// A spec may pin the child's strategy and model. Empty leaves the child
		// inheriting from the parent, which is what every delegating tool that
		// does not own a strategy of its own gets.
		StrategyID:      spec.StrategyID,
		ModelConfigJSON: string(spec.ModelConfig),
	}

	// A busy session is answered, not queued or silently redirected. The
	// refusal is a paired tool_result rather than an inline fallback: running
	// the tool for real would answer a question the caller asked of a
	// conversation, from outside that conversation.
	if session.busy {
		w.addMetaToolResult(toolUseID, toolName, toolInput, sessionBusyMessage(session.name), true)
		return true
	}

	if session.resumeThreadID != "" {
		if err := w.resumeSession(session.resumeThreadID, opts); err != nil {
			w.log.Error("[worker] resuming session %s for %s failed: %v", session.name, toolName, err)
			return false
		}
		return true
	}

	if _, err := w.createThread(opts); err != nil {
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
	match := func(raw json.RawMessage) (*SubthreadSpec, bool) {
		var resp BuildSubthreadSpecResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, false
		}
		if resp.Error != "" {
			w.log.Info("[worker] build-subthread-spec (%s): engine reported %q — running inline", requestID, resp.Error)
			// Degrade to inline: a nil spec is the caller's "run the tool
			// normally" signal (tryDelegateTool treats spec == nil identically to
			// !ok), so stopping here with a nil spec is the same outcome.
			return nil, true
		}
		w.tape.Record("build-subthread-spec-response", map[string]any{"req": requestID, "delegated": resp.Spec != nil})
		return resp.Spec, true
	}
	onTimeout := func() {
		w.log.Info("[worker] build-subthread-spec timed out (req %s) — running tool inline", requestID)
		w.tape.Record("build-subthread-spec-timeout", map[string]any{"req": requestID})
	}
	return waitForEngineReply(w, w.subthreadSpecReply, timeout, match, onTimeout)
}
