//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

// TestForkParked_ClonedWorkerRestsWithIncompleteTool is the end-to-end guard for
// forking a conversation mid-turn. It exercises both halves without mocks:
// snapshotParked (the race-free copy) and reconcileProcessingStateOnLoad (the
// load-time suppression). A source worker held mid-turn with a pending
// tool-action is snapshotted; a fresh worker loads that snapshot and reconciles.
// The clone must PRESERVE the in-flight tool yet load idle — never auto-resume —
// because a fork should appear stopped. The marker is one-shot, so a subsequent
// reload re-drives like normal crash recovery.
func TestForkParked_ClonedWorkerRestsWithIncompleteTool(t *testing.T) {
	// Source: mid-turn — a pending tool-action with the LLM claim held.
	src := NewConversationWorker("conv-fork-src", "user:test")
	defer src.doc.Destroy()
	src.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StatePending,
	})
	src.claimLLM("") // turn in flight

	snap := src.snapshotParked()

	// The live source must be untouched by the fork.
	if src.doc.GetMetadata(metaForkParked) != nil {
		t.Fatal("snapshot stamped the marker on the LIVE source doc")
	}
	if !src.isLLMClaimed() {
		t.Fatal("snapshot disturbed the source's in-flight claim")
	}

	// Clone: a fresh worker loads the snapshot and runs the load-time reconcile.
	clone := NewConversationWorker("conv-fork-clone", "user:test")
	defer clone.doc.Destroy()
	if err := clone.doc.LoadFromState(snap); err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	clone.currentRun().reconcileProcessingStateOnLoad()

	// Carries the tool item, but RESTS — no auto-resume.
	if _, ok := clone.findThreadWithIncompleteTool(); !ok {
		t.Fatal("clone lost the in-flight tool-action item")
	}
	if got := clone.getActivity(); got != ActivityNone {
		t.Fatalf("forked clone must load idle, got activity=%q", got)
	}

	// Marker is one-shot: a later normal reload re-drives as usual.
	clone.currentRun().reconcileProcessingStateOnLoad()
	if got := clone.getActivity(); got != ActivityAwaitingLLM {
		t.Fatalf("after marker consumed, reload should re-drive, got %q", got)
	}
}

// TestSnapshotParkedState_OnlyWhenRunLoopBusy pins the gate: the parked-snapshot
// path is taken ONLY for a source whose turn owns the run loop (where a flush
// would block). A merely-loaded idle source — including one parked on a pending
// approval — must fall through (ok=false) so its clone re-drives on load as usual,
// and an unloaded source reports nothing.
func TestSnapshotParkedState_OnlyWhenRunLoopBusy(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()

	w := m.GetOrCreate("conv-gate", "user:test")
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", State: StatePending,
	})

	// Idle (e.g. approval-parked) source: no parked snapshot.
	if _, ok := m.SnapshotParkedState("conv-gate"); ok {
		t.Fatal("idle source must not take the parked-snapshot path")
	}

	// A turn owns the run loop: snapshot + mark instead of a would-block flush.
	w.storeState(StateProcessing)
	snap, ok := m.SnapshotParkedState("conv-gate")
	if !ok {
		t.Fatal("running source: expected a parked snapshot")
	}
	probe := NewConversationDocument("probe", "user:test")
	defer probe.Destroy()
	if err := probe.LoadFromState(snap); err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if b, _ := probe.GetMetadata(metaForkParked).(bool); !b {
		t.Fatal("running-source snapshot must carry the forkParked marker")
	}

	// Unloaded source: nothing to snapshot.
	if _, ok := m.SnapshotParkedState("no-such-conv"); ok {
		t.Fatal("unloaded source must not report a snapshot")
	}
}

// TestReconcileOnLoad_IncompleteTool_ReDrivesWhenNotForked pins the
// crash-recovery re-drive that fork suppression must NOT break: a plainly-loaded
// conversation (no fork marker) with a non-terminal tool-action re-arms
// awaiting_llm so the follow-up LLM turn fires once the tool completes.
func TestReconcileOnLoad_IncompleteTool_ReDrivesWhenNotForked(t *testing.T) {
	w := NewConversationWorker("conv-recover", "user:test")
	defer w.doc.Destroy()
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", State: StatePending,
	})

	w.currentRun().reconcileProcessingStateOnLoad()

	if got := w.getActivity(); got != ActivityAwaitingLLM {
		t.Fatalf("crash-recovery re-drive: expected awaiting_llm, got %q", got)
	}
}
