//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestClassifyRegime_ToolResultDeltaWithoutLiveCLIAppendsWarm locks in warm-append
// resume for the lost-answer wedge: a tool was parked awaiting the user (e.g. an
// AskUserQuestion), the live CLI then went away (app quit+restart, crash,
// watchdog re-exec, or a user cancel that tore the parked CLI down), and the
// user's answer arrives as a fresh request.
//
// continuationCovers is false (pendingTools is in-memory only and didn't survive)
// and regimeContinue (the live MCP control stream) is unavailable. The delta
// messages[sentCount:] is exactly the tool_result. It must NOT route to
// regimeResumeDelta: that path pipes the tool_result as a stdin user message to a
// CLI whose resumed transcript ends on a dangling assistant tool_use, so the
// answer has no open tools/call to attach to and is silently lost.
//
// The warm session file on disk already ends on that dangling tool_use, so the
// result can be paired into it by appending one entry and the same warm uuid
// re-resumed — cache stays warm. That is regimeResumeAppendResult.
func TestClassifyRegime_ToolResultDeltaWithoutLiveCLIAppendsWarm(t *testing.T) {
	sys := "sys"

	// What the CLI was actually fed at the park: just the user prompt. The
	// anchor is captured BEFORE the CLI emits its tool_use, so sentCount stops
	// here — the assistant tool_use lands in the warm file but not in sentCount.
	fed := []provider.Message{
		userMsg("please ask me a question"),
	}
	// Session as reconstructed after the live CLI went away: the resume
	// anchor survives, but pendingTools (in-memory only) is gone.
	sess := &activeSession{
		sessionUUID: "uuid-restart",
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix(sys, fed, len(fed)),
		// model "" so the model-changed branch is skipped.
	}

	// The user answers: the doc now also holds the assistant tool_use the CLI
	// parked on (head of the delta) and its result. No live CLI.
	answered := append(append([]provider.Message{}, fed...),
		toolUseMsg("q1", "AskUserQuestion"),
		toolResultMsg("q1", "the user's answer"))

	dec := classifyRegime(sess, "", sys, answered, false /* no live CLI */)
	if dec.Regime != regimeResumeAppendResult {
		t.Fatalf("tool_result delta with no live CLI must warm-append (regimeResumeAppendResult); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
	if dec.DeltaStart != len(fed) || dec.DeltaEnd != len(answered) {
		t.Fatalf("delta range = [%d,%d), want [%d,%d)", dec.DeltaStart, dec.DeltaEnd, len(fed), len(answered))
	}
}

// TestClassifyRegime_CancelInterjectAppendsWarm is the user-reported bug: a tool
// is parked awaiting approval, the user hits Escape (which tears down the parked
// CLI and clears pendingTools but keeps the warm anchor), then types a NEW
// message. The worker's doc keeps the assistant tool_use and a cancelled
// tool-result, so the delta is [cancelled-result, user-message].
//
// This must warm-append, not cold-rebuild: the leading cancelled tool_result
// closes the dangling tool_use in the warm file (file append), and the trailing
// user message is the stdin tail. Cache stays warm; no full re-ingest.
func TestClassifyRegime_CancelInterjectAppendsWarm(t *testing.T) {
	sys := "sys"
	// Fed at the park: just the user prompt. The anchor stops here.
	fed := []provider.Message{
		userMsg("do the thing"),
	}
	sess := &activeSession{
		sessionUUID: "uuid-cancel",
		sentCount:   len(fed),
		sentHash:    hashRequestPrefix(sys, fed, len(fed)),
	}
	// The doc now holds the assistant tool_use the CLI parked on (delta head);
	// cancel marks call_1 cancelled, then the user interjects a fresh message.
	interjected := append(append([]provider.Message{}, fed...),
		toolUseMsg("call_1", "bash"),
		toolResultMsg("call_1", "Cancelled"),
		userMsg("actually do this other thing instead"))

	dec := classifyRegime(sess, "", sys, interjected, false /* no live CLI */)
	if dec.Regime != regimeResumeAppendResult {
		t.Fatalf("cancel-then-interject must warm-append (regimeResumeAppendResult); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
	// The split: the assistant tool_use head + cancelled result are paired into
	// the warm file; the user message is the stdin tail.
	tailStart, ok := pairedResultResumeSplit(interjected, dec.DeltaStart, dec.DeltaEnd)
	if !ok {
		t.Fatalf("pairedResultResumeSplit returned ok=false for the warm-append case")
	}
	// fed(1) + tool_use(1) + result(1) = 3; the user tail begins at index 3.
	if tailStart != 3 {
		t.Fatalf("tailStart = %d, want 3 (assistant head + result, then the user tail)", tailStart)
	}
}

// TestClassifyRegime_UnpairedToolResultStaysFresh guards the narrowness of the
// warm-append path: a tool_result-bearing delta whose result does NOT close the
// warm transcript's dangling tool_use (here the prefix ends on a plain assistant
// turn, so there is no dangling tool_use to pair) cannot be safely appended and
// must fall back to a fresh synthetic resume.
func TestClassifyRegime_UnpairedToolResultStaysFresh(t *testing.T) {
	sys := "sys"
	// Prefix ends on a plain assistant message — no dangling tool_use.
	committed := []provider.Message{
		userMsg("hello"),
		assistantMsg("hi"),
	}
	sess := &activeSession{
		sessionUUID: "uuid-nodangle",
		sentCount:   len(committed),
		sentHash:    hashRequestPrefix(sys, committed, len(committed)),
	}
	// A stray tool_result for some unrelated id arrives in the delta.
	stray := append(append([]provider.Message{}, committed...),
		toolResultMsg("ghost", "orphan result"))

	dec := classifyRegime(sess, "", sys, stray, false /* no live CLI */)
	if dec.Regime != regimeStartFresh || dec.Reason != "delta-tool-result" {
		t.Fatalf("unpaired tool_result delta must start fresh (delta-tool-result); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
}

// TestClassifyRegime_PlainUserDeltaStillResumesWarm guards that the fix is
// narrow: a delta that carries NO tool_result (an ordinary new user turn after a
// restart) still resumes warm via regimeResumeDelta. Only tool_result-bearing
// deltas that pair a dangling tool_use are diverted to warm-append.
func TestClassifyRegime_PlainUserDeltaStillResumesWarm(t *testing.T) {
	sys := "sys"
	committed := []provider.Message{
		userMsg("hello"),
		assistantMsg("hi"),
	}
	sess := &activeSession{
		sessionUUID: "uuid-warm",
		sentCount:   len(committed),
		sentHash:    hashRequestPrefix(sys, committed, len(committed)),
	}
	extended := append(append([]provider.Message{}, committed...), userMsg("next question"))

	dec := classifyRegime(sess, "", sys, extended, false /* no live CLI */)
	if dec.Regime != regimeResumeDelta {
		t.Fatalf("plain user delta must resume warm (regimeResumeDelta); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
}
