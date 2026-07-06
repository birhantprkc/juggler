//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Pure regime classification: given a stored session and an incoming
// request, decide which dispatch path StreamMessage will take.

package claudecode

import (
	"fmt"

	provider "juggler/cmd/juggler/providers/registry"
)

// continuationCovers reports whether req.Messages contains a tool-result
// for every pending tool ID. Pure predicate — does not consult liveness.
// Consumed by classifyRegime alongside hasLiveCLI and the user-interjection
// check.
func continuationCovers(sess *activeSession, messages []provider.Message) bool {
	if sess == nil || len(sess.pendingTools) == 0 {
		return false
	}
	pending := make(map[string]bool, len(sess.pendingTools))
	for _, t := range sess.pendingTools {
		pending[t.ID] = true
	}
	found := 0
	for _, msg := range messages {
		if msg.Type == "tool-result" && pending[msg.ToolUseID] {
			found++
		}
	}
	return found == len(sess.pendingTools)
}

// userInterjectedAfterPendingTools reports whether req.Messages contains any
// non-tool-result content positioned after the most recent tool-result for
// one of the session's pending tool IDs. That trailing content (typically a
// user message the user typed while tools were running) cannot be delivered
// through continueSession's MCP-only fast path — it would be silently
// dropped — so the caller must route through resume-with-delta instead.
func userInterjectedAfterPendingTools(sess *activeSession, messages []provider.Message) bool {
	if sess == nil || len(sess.pendingTools) == 0 || len(messages) == 0 {
		return false
	}
	pending := make(map[string]bool, len(sess.pendingTools))
	for _, t := range sess.pendingTools {
		pending[t.ID] = true
	}
	lastMatchingToolResult := -1
	for i, msg := range messages {
		if msg.Type == "tool-result" && pending[msg.ToolUseID] {
			lastMatchingToolResult = i
		}
	}
	if lastMatchingToolResult < 0 {
		return false // continuationCovers would have already returned false
	}
	for i := lastMatchingToolResult + 1; i < len(messages); i++ {
		if messages[i].Type != "tool-result" {
			return true
		}
	}
	return false
}

// deltaCarriesToolResult reports whether any message in messages[start:end] is a
// tool-result. A tool_result reaches the CLI exactly two ways: live, over the MCP
// control stream (regimeContinue), or paired into resumed history by the
// synthetic-resume rebuild (regimeStartFresh). It can NEVER be delivered as a
// stdin user-message delta — the resumed transcript ends on a dangling assistant
// tool_use the CLI answered over its (by-then-closed) control stream, so a stdin
// tool_result has no open tools/call to bind to and is silently dropped. So a
// delta carrying a tool_result must never route to regimeResumeDelta.
func deltaCarriesToolResult(messages []provider.Message, start, end int) bool {
	for i := start; i < end && i < len(messages); i++ {
		if messages[i].Type == "tool-result" {
			return true
		}
	}
	return false
}

// streamRegime tags which dispatch path StreamMessage will (or would) take
// for a given (session, request) pair.
type streamRegime int

const (
	_ streamRegime = iota

	// regimeStartFresh spawns a brand-new -p invocation with full history.
	// Used for first turns, model changes, or any prefix divergence.
	regimeStartFresh

	// regimeContinue feeds tool_results to the parked CLI via MCP.
	// Requires a live CLI, results for every pendingTool, and no user
	// content past the matching tool-results.
	regimeContinue

	// regimeResumeDelta spawns/reuses `claude --resume <uuid>` and pipes
	// messages[DeltaStart:DeltaEnd] via stdin. If SoftReset is true, the
	// parked CLI is killed first (clearing pendingTools); the resumed
	// session re-reads its saved transcript so the cache stays warm.
	regimeResumeDelta

	// regimeResumeAppendResult handles a tool_result-bearing delta when the
	// live CLI is gone (cancel-while-parked then interject, or answer after a
	// restart): the leading tool_results close the dangling tool_use the warm
	// transcript ends on. Rather than cold-rebuild under a fresh uuid, append
	// the paired results into the CLI's OWN warm session file and re-resume the
	// same uuid, piping only the non-tool_result tail on stdin. The unchanged
	// prefix cache-hits. DeltaStart/DeltaEnd bracket the whole delta;
	// pairedResultResumeSplit re-derives the file-vs-stdin boundary at dispatch.
	regimeResumeAppendResult
)

// regimeDecision is the output of classifyRegime: enough information to
// dispatch (StreamMessage) the request.
type regimeDecision struct {
	Regime     streamRegime
	DeltaStart int  // valid for regimeResumeDelta
	DeltaEnd   int  // valid for regimeResumeDelta
	SoftReset  bool // valid for regimeResumeDelta: kill parked CLI first
	// NoNewMsgs is the steady-state warm case: every message in req.Messages
	// is already covered by sentCount. Reported via regimeStartFresh because
	// StreamMessage cold-starts in this state.
	NoNewMsgs bool
	// Reason is a short diagnostic for the cold-start log. Set on
	// regimeStartFresh.
	Reason string
}

// classifyRegime is a pure predicate: given the stored session and the
// incoming request, decide which dispatch regime applies. Single source of
// truth that StreamMessage consumes for routing. liveCLI lets the caller
// short-circuit regimeContinue when the parked subprocess is gone — pass
// sess.hasLiveCLI() at dispatch time (a dead CLI degrades to
// regimeResumeDelta with SoftReset, which is still warm).
func classifyRegime(sess *activeSession, currentModel, systemPrompt string, messages []provider.Message, liveCLI bool) regimeDecision {
	if sess == nil || sess.sessionUUID == "" {
		return regimeDecision{Regime: regimeStartFresh, Reason: "no-session"}
	}
	if continuationCovers(sess, messages) && liveCLI && !userInterjectedAfterPendingTools(sess, messages) {
		return regimeDecision{Regime: regimeContinue}
	}
	// claude --resume against a different model does not share cache.
	if sess.model != "" && sess.model != currentModel {
		return regimeDecision{Regime: regimeStartFresh, Reason: "model-changed"}
	}
	start, end, ok, reason := canResumeWithDelta(sess, systemPrompt, messages)
	if !ok {
		return regimeDecision{
			Regime:    regimeStartFresh,
			Reason:    reason,
			NoNewMsgs: reason == "no-new-msgs",
		}
	}
	// A delta carrying a tool_result cannot be piped on stdin (see
	// deltaCarriesToolResult). We only reach here when regimeContinue was
	// unavailable — typically the live CLI that parked the tools/call is gone
	// (app restart, crash, watchdog re-exec) so pendingTools didn't survive, or
	// it parked but the user interjected. Routing such a delta through
	// regimeResumeDelta would --resume the old transcript (ending on a dangling
	// assistant tool_use answered over the now-closed control stream) and feed the
	// tool_result as a stdin user message with no open tools/call to attach to —
	// the answer is silently lost ("permission stream closed"). Route to a fresh
	// synthetic resume instead: moveTrailingToolResultsToHistory pairs the
	// tool_result into the rebuilt history so the model actually sees it.
	if deltaCarriesToolResult(messages, start, end) {
		// If the delta's leading tool_results close the dangling tool_use the
		// warm transcript ends on, we can pair them into the warm session file
		// and re-resume warm instead of cold-rebuilding (see
		// regimeResumeAppendResult). Otherwise the result can't be safely placed
		// in the warm file, so fall back to a fresh synthetic resume.
		if _, ok := pairedResultResumeSplit(messages, start, end); ok {
			return regimeDecision{
				Regime:     regimeResumeAppendResult,
				DeltaStart: start,
				DeltaEnd:   end,
			}
		}
		return regimeDecision{Regime: regimeStartFresh, Reason: "delta-tool-result"}
	}
	return regimeDecision{
		Regime:     regimeResumeDelta,
		DeltaStart: start,
		DeltaEnd:   end,
		SoftReset:  len(sess.pendingTools) > 0,
	}
}

// pairedResultResumeSplit reports whether the delta messages[deltaStart:deltaEnd]
// can be warm-appended. The resume anchor is captured at the park BEFORE the CLI
// emits its tool_use, so the assistant turn the CLI parked on is the HEAD of the
// delta (already durably in the warm session file), not part of the committed
// prefix. The delta must therefore look like:
//
//	[ assistant turn (text / thinking / tool_use) ]   ← already in the warm file
//	[ tool_results closing every dangling tool_use ]  ← appended into the file
//	[ non-tool_result tail (the user's interjection) ] ← piped on stdin (may be empty)
//
// On success it returns tailStart: the index splitting the leading content from
// the stdin tail. It fails when the delta's assistant head carries no tool_use,
// when a tool_result doesn't close one, when some tool_use is left unanswered, or
// when a tool_result trails the non-result content — any of which makes a clean
// warm append impossible, so the caller cold-starts fresh instead.
func pairedResultResumeSplit(messages []provider.Message, deltaStart, deltaEnd int) (tailStart int, ok bool) {
	if deltaStart < 0 || deltaEnd > len(messages) {
		return 0, false
	}
	// Phase 1: the parked assistant turn (already committed to the warm file).
	// Collect the tool_use it is dangling on.
	dangling := map[string]bool{}
	i := deltaStart
	for ; i < deltaEnd; i++ {
		if provider.MessageTypeToRole(messages[i].Type) != "assistant" {
			break
		}
		if messages[i].Type == "tool-use" && messages[i].ToolUseID != "" {
			dangling[messages[i].ToolUseID] = true
		}
	}
	if len(dangling) == 0 {
		return 0, false
	}
	// Phase 2: the tool_results closing every dangling tool_use.
	answered := make(map[string]bool, len(dangling))
	for ; i < deltaEnd; i++ {
		if messages[i].Type != "tool-result" {
			break
		}
		if !dangling[messages[i].ToolUseID] {
			return 0, false // a result that doesn't close a dangling call
		}
		answered[messages[i].ToolUseID] = true
	}
	if len(answered) != len(dangling) {
		return 0, false // not every dangling tool_use got a result
	}
	// Phase 3: the stdin tail must carry no further tool_result.
	for j := i; j < deltaEnd; j++ {
		if messages[j].Type == "tool-result" {
			return 0, false
		}
	}
	return i, true
}

// canResumeWithDelta reports whether a stored sessionUUID can be reused for
// the new request: the new (systemPrompt, messages[:sentCount]) prefix must
// match the prefix the CLI was last fed. This is what enables prompt cache
// reuse across juggler turns. Returns the (deltaStart, deltaEnd) range in
// messages on success. On failure, returns ok=false plus a short reason
// string for cold-start telemetry: "no-uuid", "shrunk", "diverged",
// "no-new-msgs". The system prompt participates in "diverged" — it's not
// a privileged input, it's just one more thing in the request body.
func canResumeWithDelta(sess *activeSession, systemPrompt string, messages []provider.Message) (int, int, bool, string) {
	if sess == nil || sess.sessionUUID == "" {
		return 0, 0, false, "no-uuid"
	}
	if sess.sentCount > len(messages) {
		// Conversation shrunk — must be a divergent history (branch switch / undo).
		return 0, 0, false, "shrunk"
	}
	if hashRequestPrefix(systemPrompt, messages, sess.sentCount) != sess.sentHash {
		return 0, 0, false, "diverged"
	}
	if sess.sentCount == len(messages) {
		// No new messages to send; treat as divergent so caller starts fresh.
		return 0, 0, false, "no-new-msgs"
	}
	return sess.sentCount, len(messages), true, ""
}

// diagnoseDivergence returns a short, human-readable description of the FIRST
// prefix element that no longer matches what the CLI was last fed, for the
// cold-start log. Pure; relies on the per-element fingerprints captured by the
// previous finalizeTurn (captureSentPrefix). The system prompt is the head of
// the cached prefix, so it is reported before any message. Returns "" when the
// session lacks fingerprint metadata (e.g. restored from a pre-upgrade sidecar)
// or when no single element localises the difference, so the caller falls back
// to the bare reason string.
func diagnoseDivergence(sess *activeSession, systemPrompt string, messages []provider.Message) string {
	if sess == nil || (sess.sentSystemHash == 0 && len(sess.sentMsgHashes) == 0) {
		return ""
	}
	if sess.sentSystemHash != 0 && hashSystemPrompt(systemPrompt) != sess.sentSystemHash {
		return "system prompt changed (a context item or the env block rendered differently)"
	}
	if sess.sentCount > len(messages) {
		return fmt.Sprintf("history shrank from %d to %d messages", sess.sentCount, len(messages))
	}
	limit := len(sess.sentMsgHashes)
	if limit > len(messages) {
		limit = len(messages)
	}
	for i := 0; i < limit; i++ {
		if hashMessage(&messages[i]) != sess.sentMsgHashes[i] {
			return fmt.Sprintf("message[%d] (type=%s) changed", i, messages[i].Type)
		}
	}
	return ""
}
