//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
)

// TestClaimLLM_NullStateClaimsSuccessfully: claiming from a fresh worker
// (no prior processingState) transitions activity from null to
// ActivityCallingLLM.
func TestClaimLLM_NullStateClaimsSuccessfully(t *testing.T) {
	w := NewConversationWorker("test-claim-null", "user:test")

	if w.isLLMClaimed() {
		t.Fatal("fresh worker: expected isLLMClaimed=false")
	}
	if !w.claimLLM("") {
		t.Fatal("fresh worker: expected claim to succeed")
	}
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
}

// TestClaimLLM_DoubleClaimFails: a second claim against the same
// conversation while the first is still held must return false.
func TestClaimLLM_DoubleClaimFails(t *testing.T) {
	w := NewConversationWorker("test-claim-double", "user:test")

	if !w.claimLLM("") {
		t.Fatal("first claim: expected success")
	}
	if w.claimLLM("") {
		t.Fatal("second claim: expected failure while first is held")
	}
}

// TestReleaseLLM_ClearsClaim: after release, isLLMClaimed reports false
// and a subsequent claim succeeds.
func TestReleaseLLM_ClearsClaim(t *testing.T) {
	w := NewConversationWorker("test-release", "user:test")

	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
	w.releaseLLM()
	if w.isLLMClaimed() {
		t.Fatal("after release: expected isLLMClaimed=false")
	}
	if !w.claimLLM("") {
		t.Fatal("claim after release: expected success")
	}
}

// TestSendStatusIdleClearsActivity: the normal end-of-loop sendStatus
// path must also clear the doc-native claim, so releaseLLM is redundant
// on the happy path.
func TestSendStatusIdleClearsActivity(t *testing.T) {
	w := NewConversationWorker("test-idle-clears", "user:test")

	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
	w.currentRun().sendStatus("idle", "")
	if w.isLLMClaimed() {
		t.Fatal("after sendStatus(idle): expected isLLMClaimed=false")
	}
}

// TestSendStatusNonIdleSetsActivity: any non-idle sendStatus (preparing,
// streaming, processing_tools) writes activity so the claim tracks the
// loop's phases.
func TestSendStatusNonIdleSetsActivity(t *testing.T) {
	cases := []string{"preparing", "streaming", "processing_tools"}
	for _, status := range cases {
		t.Run(status, func(t *testing.T) {
			w := NewConversationWorker("test-status-"+status, "user:test")
			w.currentRun().sendStatus(status, "")
			if !w.isLLMClaimed() {
				t.Errorf("after sendStatus(%q): expected isLLMClaimed=true", status)
			}
		})
	}
}

// TestSendStatusErrorReleasesClaim: the terminal-error statuses (error,
// validation-error) are resting states, NOT active operations — they must
// release the doc-native claim like idle, never hold it. Regression test for
// the wedge where a no-model send wrote activity="calling_llm" via
// sendStatus("validation-error", …) and never released it: every subsequent
// send was then parked in the pending queue (getActivity != none) and every
// Continue was silently dropped, even after a model was selected.
func TestSendStatusErrorReleasesClaim(t *testing.T) {
	for _, status := range []string{"error", "validation-error"} {
		t.Run(status, func(t *testing.T) {
			w := NewConversationWorker("test-err-"+status, "user:test")
			w.currentRun().sendStatus(status, "boom")
			if w.getActivity() != ActivityNone {
				t.Fatalf("after sendStatus(%q): expected activity=%q (claim released), got %q", status, ActivityNone, w.getActivity())
			}
			if w.isLLMClaimed() {
				t.Fatalf("after sendStatus(%q): expected isLLMClaimed=false", status)
			}
		})
	}
}

// TestClaimLLM_ReloadScenario: worker dies mid-operation → fresh worker
// starts, reads stale processingState from disk → sendStatus("idle") on
// init clears the stale claim → next claim succeeds.
func TestClaimLLM_ReloadScenario(t *testing.T) {
	w := NewConversationWorker("test-reload", "user:test")
	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("initial claim: expected isLLMClaimed=true")
	}

	w.currentRun().sendStatus("idle", "")
	if w.isLLMClaimed() {
		t.Fatal("after init sendStatus(idle): expected stale claim cleared")
	}

	if !w.claimLLM("") {
		t.Fatal("post-reload claim: expected success")
	}
}

// TestRequestLLM_SetsAwaitingActivity: requestLLM transitions activity
// from null → "awaiting_llm".
func TestRequestLLM_SetsAwaitingActivity(t *testing.T) {
	w := NewConversationWorker("test-request", "user:test")

	if !w.requestLLM("") {
		t.Fatal("requestLLM: expected success from null activity")
	}
	if w.getActivity() != ActivityAwaitingLLM {
		t.Fatalf("after requestLLM: expected activity=%q, got %q", ActivityAwaitingLLM, w.getActivity())
	}
	// "awaiting_llm" is NOT "claimed" — the reducer should still act.
	if w.isLLMClaimed() {
		t.Fatal("awaiting_llm should NOT report isLLMClaimed=true")
	}
}

// TestRequestLLM_FailsWhenBusy: requestLLM returns false if activity
// is already non-null.
func TestRequestLLM_FailsWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-request-busy", "user:test")

	w.claimLLM("")
	if w.requestLLM("") {
		t.Fatal("requestLLM during calling_llm: expected failure")
	}

	w2 := NewConversationWorker("test-request-double", "user:test")
	w2.requestLLM("")
	if w2.requestLLM("") {
		t.Fatal("double requestLLM: expected failure")
	}
}

// TestClaimLLM_FromAwaitingSucceeds: claimLLM should transition from
// "awaiting_llm" → "calling_llm" (the reducer dispatching the LLM call).
func TestClaimLLM_FromAwaitingSucceeds(t *testing.T) {
	w := NewConversationWorker("test-claim-awaiting", "user:test")

	w.requestLLM("")
	if w.getActivity() != ActivityAwaitingLLM {
		t.Fatal("precondition: expected awaiting_llm")
	}

	if !w.claimLLM("") {
		t.Fatal("claimLLM from awaiting: expected success")
	}
	if w.getActivity() != ActivityCallingLLM {
		t.Fatalf("after claim: expected activity=%q, got %q", ActivityCallingLLM, w.getActivity())
	}
}

// TestSendStatusIdleClearsAwaiting: sendStatus("idle") clears any
// activity value, including "awaiting_llm" (crash recovery path).
func TestSendStatusIdleClearsAwaiting(t *testing.T) {
	w := NewConversationWorker("test-idle-awaiting", "user:test")

	w.requestLLM("")
	w.currentRun().sendStatus("idle", "")
	if w.getActivity() != ActivityNone {
		t.Fatalf("after sendStatus(idle): expected activity cleared, got %q", w.getActivity())
	}
}
