//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// TestRemoveReleasesProviderSession pins the fix for the mid-turn-bin wedge.
// Binning or deleting a conversation removes its worker; that teardown MUST
// release the provider-side LLM session. Otherwise a warm or mid-turn claudecode
// CLI for the now-gone conversation survives, streams its tool_use into a
// workerless void (nobody is left to drive execution), and the tool wedges at
// "running" until a manual cancel. Removal releases the session unconditionally —
// warm-preserving, and no longer gated on the racy in-flight-ctx check that
// missed the turn-boundary window in the original bug.
func TestRemoveReleasesProviderSession(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	released := make(chan string, 1)
	m.SetCancelLLMSession(func(convID string) { released <- convID })

	m.GetOrCreate("conv-bin", "user:test")
	m.Remove("conv-bin")

	select {
	case got := <-released:
		if got != "conv-bin" {
			t.Fatalf("Remove released wrong conversation: got %q, want %q", got, "conv-bin")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Remove did not release the provider session for the removed conversation (orphaned-CLI wedge)")
	}
}

// TestManagerAnyActive: AnyActive() is the doc-native "is a turn in flight"
// signal. It must be false with no workers, false for an idle worker, true
// while a worker holds an LLM claim, and false again once the claim is
// released.
func TestManagerAnyActive(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	if m.AnyActive() {
		t.Fatal("no workers: expected AnyActive=false")
	}

	w := m.GetOrCreate("conv-active", "user:test")
	if m.AnyActive() {
		t.Fatal("idle worker: expected AnyActive=false")
	}

	if !w.claimLLM("") {
		t.Fatal("precondition: claimLLM should succeed on an idle worker")
	}
	if !m.AnyActive() {
		t.Fatal("after claimLLM: expected AnyActive=true")
	}

	w.releaseLLM("")
	if m.AnyActive() {
		t.Fatal("after releaseLLM: expected AnyActive=false")
	}
}

func TestManagerActiveConversationIDs(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	idle := m.GetOrCreate("conv-idle", "user:test")
	activeB := m.GetOrCreate("conv-b", "user:test")
	activeA := m.GetOrCreate("conv-a", "user:test")
	if !activeB.claimLLM("") || !activeA.claimLLM("") {
		t.Fatal("precondition: claimLLM should succeed")
	}
	defer activeB.releaseLLM("")
	defer activeA.releaseLLM("")
	_ = idle

	got := m.ActiveConversationIDs()
	want := []string{"conv-a", "conv-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ActiveConversationIDs() = %v, want %v", got, want)
	}
}

// TestManagerActive_ApprovalParkedExcluded: a turn parked solely on a pending
// tool approval is NOT "active". It holds the doc-native LLM claim (activity !=
// none) but nothing is executing — quitting/restarting leaves the approval
// intact — so AnyActive/ActiveConversationIDs must exclude it. This is what
// stops the desktop quit guard warning when a conversation is only waiting for
// the user to approve a tool. Add an executing (StateApproved) sibling and it
// flips back to active, proving the exclusion is approval-parked-only.
func TestManagerActive_ApprovalParkedExcluded(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	w := m.GetOrCreate("conv-parked", "user:test")

	// A lone pending tool-action: the turn is blocked solely on approval.
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-pending",
		ToolUseID: "tu-pending",
		ToolName:  "bash",
		State:     StatePending,
	})

	// requestLLM holds the claim (activity == awaiting_llm) just as a real
	// parked turn does after the LLM emits a tool_use needing approval.
	if !w.requestLLM("") {
		t.Fatal("precondition: requestLLM should succeed on an idle worker")
	}
	if w.getActivity() == ActivityNone {
		t.Fatal("precondition: the claim must be held (activity != none)")
	}

	if m.AnyActive() {
		t.Fatal("parked on approval: expected AnyActive=false (nothing is running)")
	}
	if ids := m.ActiveConversationIDs(); len(ids) != 0 {
		t.Fatalf("parked on approval: expected no active IDs, got %v", ids)
	}

	// Add a genuinely-executing tool: now real work is in flight, so the
	// conversation is active again even though a pending approval remains.
	w.doc.InsertMessage(1, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-approved",
		ToolUseID: "tu-approved",
		ToolName:  "bash",
		State:     StateApproved,
	})
	if !m.AnyActive() {
		t.Fatal("executing tool present: expected AnyActive=true")
	}
	if ids := m.ActiveConversationIDs(); !reflect.DeepEqual(ids, []string{"conv-parked"}) {
		t.Fatalf("executing tool present: expected [conv-parked], got %v", ids)
	}

	w.releaseLLM("")
}

// TestManagerActive_SubThreadApprovalParkedExcluded pins the desktop
// quit-guard false-positive: a conversation whose OPEN (resultless) sub-thread
// is itself parked solely on a pending tool approval (e.g. an AskUserQuestion
// awaiting the user's answer) must NOT count as active. Quitting/restarting
// leaves the sub-thread's approval intact, so nothing is interrupted. Before the
// fix, scanApprovalBlock treated any resultless sub-thread as executing, so the
// parent looked busy and the quit guard warned. Adding genuinely-executing work
// inside the sub-thread flips it back to active, proving the exclusion is
// approval-parked-only and still detects real in-flight sub-thread work.
func TestManagerActive_SubThreadApprovalParkedExcluded(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	w := m.GetOrCreate("conv-sub-parked", "user:test")

	// An open sub-thread whose only non-terminal work is a pending approval.
	nested, err := json.Marshal([]ConversationItem{
		{
			Type:      ItemTypeToolAction,
			ItemID:    "ta-sub-pending",
			ToolUseID: "tu-sub-pending",
			ToolName:  "AskUserQuestion",
			State:     StatePending,
		},
	})
	if err != nil {
		t.Fatalf("marshal nested items: %v", err)
	}
	w.doc.InsertMessage(0, ConversationItem{
		Type:   ItemTypeThread,
		ItemID: "t-sub",
		Items:  nested,
	})

	if !w.requestLLM("") {
		t.Fatal("precondition: requestLLM should succeed on an idle worker")
	}
	if w.getActivity() == ActivityNone {
		t.Fatal("precondition: the claim must be held (activity != none)")
	}

	if m.AnyActive() {
		t.Fatal("sub-thread parked on approval: expected AnyActive=false (nothing is running)")
	}
	if ids := m.ActiveConversationIDs(); len(ids) != 0 {
		t.Fatalf("sub-thread parked on approval: expected no active IDs, got %v", ids)
	}

	// Add a genuinely-executing tool INSIDE the sub-thread: real work is now in
	// flight there, so the conversation is active again even though the pending
	// approval remains.
	subArr := w.doc.GetThreadItemsArray("t-sub")
	if subArr == nil {
		t.Fatal("precondition: sub-thread nested array should exist")
	}
	w.doc.InsertMessageIntoArray(subArr, 1, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-sub-approved",
		ToolUseID: "tu-sub-approved",
		ToolName:  "bash",
		State:     StateApproved,
	})
	if !m.AnyActive() {
		t.Fatal("executing tool inside sub-thread: expected AnyActive=true")
	}
	if ids := m.ActiveConversationIDs(); !reflect.DeepEqual(ids, []string{"conv-sub-parked"}) {
		t.Fatalf("executing tool inside sub-thread: expected [conv-sub-parked], got %v", ids)
	}

	w.releaseLLM("")
}

// TestManagerAnyActive_AwaitingCounts: a worker in "awaiting_llm" (tools
// dispatched, LLM re-dispatch pending) is still active — the engine is needed
// to execute those tools, so teardown must not fire.
func TestManagerAnyActive_AwaitingCounts(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	w := m.GetOrCreate("conv-awaiting", "user:test")

	// "awaiting_llm" is only a resting state while a tool in the thread is
	// non-terminal (decideNextAction rests until the tool completes). On an
	// empty root thread the reducer defines awaiting_llm as idle
	// (ActionGoIdle) and the worker goroutine would clear it concurrently
	// with the assertion below — so give the thread an in-flight tool, the
	// exact production shape this test pins.
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-await",
		ToolUseID: "tu-await",
		ToolName:  "bash",
		State:     StateRunning,
	})

	if !w.requestLLM("") {
		t.Fatal("precondition: requestLLM should succeed on an idle worker")
	}
	if !m.AnyActive() {
		t.Fatal("awaiting_llm: expected AnyActive=true")
	}

	// Clear the claim via releaseLLM (a pure ycrdtMu-guarded doc transaction,
	// safe from this goroutine) rather than sendStatus, which drives the
	// syncBatcher and is private to the worker's run-loop goroutine.
	w.releaseLLM("")
	if m.AnyActive() {
		t.Fatal("after releaseLLM: expected AnyActive=false")
	}
}
