//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"fmt"
	"testing"

	"juggler/cmd/juggler/worker"
)

// =============================================================================
// YJS INVARIANT PROPERTY FRAMEWORK
//
// A property-style suite that proves a named invariant holds under four modes
// of state change:
//
//   modeLocal     — apply ops, check after each.
//   modeUndoRedo  — apply ops, undo back to start, redo to end, check at every
//                   undo/redo step matches the corresponding apply-time state.
//   modePeerSync  — mirror every applied op onto a second doc via state-update
//                   transport, check the invariant on the peer.
//   modeReload    — after the full sequence, serialise the doc, destroy it,
//                   load a fresh one from the bytes, check the invariant holds
//                   on the reloaded doc.
// =============================================================================

type invariantMode string

const (
	modeLocal    invariantMode = "local"
	modeUndoRedo invariantMode = "undo_redo"
	modePeerSync invariantMode = "peer_sync"
	modeReload   invariantMode = "reload"
)

// invariantOpKind is a deliberately small subset of opKind — the property
// suite only mutates items in ways that round-trip cleanly through all modes.
type invariantOpKind string

const (
	invInsert invariantOpKind = "insert"
	invDelete invariantOpKind = "delete"
)

type invariantStep struct {
	op      invariantOpKind
	index   int      // insert: position; delete: current index
	id      string   // insert: itemId (also content for the demo invariant)
	content string   // insert: content
	want    []string // expected doc items[].Content after this op (mode-dependent assertion)
}

func invIns(idx int, id, content string, want []string) invariantStep {
	return invariantStep{op: invInsert, index: idx, id: id, content: content, want: want}
}

func invDel(idx int, want []string) invariantStep {
	return invariantStep{op: invDelete, index: idx, want: want}
}

// invariant is the predicate under test. It receives the doc and the expected
// content array for the current step, and returns nil if the property holds.
type invariant func(doc *worker.ConversationDocument, want []string) error

// itemsMatchExpected asserts "doc.GetItems() content sequence equals the step's
// want slice". It catches insertion-order regressions and validates the
// property runner itself.
func itemsMatchExpected(doc *worker.ConversationDocument, want []string) error {
	items := doc.GetItems()
	if len(items) != len(want) {
		return fmt.Errorf("len(items)=%d, want=%d", len(items), len(want))
	}
	for i, w := range want {
		if items[i].Content != w {
			return fmt.Errorf("items[%d].Content=%q, want %q", i, items[i].Content, w)
		}
	}
	return nil
}

type invariantScenario struct {
	name      string
	invariant invariant
	steps     []invariantStep
}

// runInvariantScenario executes the scenario under every mode. A failure in
// any mode reports the mode in the error so root cause is one read away.
func runInvariantScenario(t *testing.T, sc invariantScenario) {
	t.Helper()
	t.Run(sc.name, func(t *testing.T) {
		t.Parallel()
		for _, mode := range []invariantMode{modeLocal, modeUndoRedo, modePeerSync, modeReload} {
			mode := mode
			t.Run(string(mode), func(t *testing.T) {
				runInvariantMode(t, sc, mode)
			})
		}
	})
}

func runInvariantMode(t *testing.T, sc invariantScenario, mode invariantMode) {
	t.Helper()

	docID := fmt.Sprintf("inv-%s-%s", sc.name, mode)
	doc := worker.NewConversationDocument(docID, "user:test")
	defer doc.Destroy()
	tracker := worker.NewOperationTracker(doc)

	// Peer-sync mode keeps a mirror doc that receives state updates after
	// each mutation. The invariant is checked on the peer, not the origin.
	var peer *worker.ConversationDocument
	if mode == modePeerSync {
		peer = worker.NewConversationDocument(docID+"-peer", "user:peer")
		defer peer.Destroy()
	}

	for i, s := range sc.steps {
		stepDesc := fmt.Sprintf("[%s/%s] step %d (%s)", sc.name, mode, i+1, s.op)

		switch s.op {
		case invInsert:
			tracker.InsertMessage(s.index, worker.ConversationItem{
				Type:    worker.ItemTypeUser,
				ItemID:  s.id,
				Content: s.content,
			})
		case invDelete:
			tracker.DeleteMessages([]int{s.index})
		}

		switch mode {
		case modeLocal:
			if err := sc.invariant(doc, s.want); err != nil {
				t.Errorf("%s: %v", stepDesc, err)
			}
		case modePeerSync:
			// Push doc → peer after every mutation. ToState is a
			// monotonic full-state encoding; applying it
			// repeatedly is idempotent.
			if err := peer.ApplyUpdate(doc.ToState()); err != nil {
				t.Fatalf("%s: peer ApplyUpdate: %v", stepDesc, err)
			}
			if err := sc.invariant(peer, s.want); err != nil {
				t.Errorf("%s (peer): %v", stepDesc, err)
			}
		case modeUndoRedo, modeReload:
			// These modes check the invariant after the full sequence, not
			// after every step — skip per-step.
		}
	}

	switch mode {
	case modeUndoRedo:
		// Walk backwards via undo to the empty state, checking the invariant
		// against the snapshot at each prior step. Then redo forward,
		// checking that each redo arrives at the same state as the apply.
		snapshots := make([][]string, 0, len(sc.steps)+1)
		snapshots = append(snapshots, nil) // pre-step state (no want)
		for _, s := range sc.steps {
			snapshots = append(snapshots, s.want)
		}
		// Undo back: each Undo reverts to snapshots[len-1-k].
		for k := len(sc.steps); k >= 1; k-- {
			if !tracker.Undo() {
				t.Fatalf("[%s/%s] Undo at k=%d returned false", sc.name, mode, k)
			}
			prev := snapshots[k-1]
			if prev == nil {
				prev = []string{}
			}
			if err := sc.invariant(doc, prev); err != nil {
				t.Errorf("[%s/%s] after undo to step %d: %v", sc.name, mode, k-1, err)
			}
		}
		// Redo forward.
		for k := 1; k <= len(sc.steps); k++ {
			if !tracker.Redo() {
				t.Fatalf("[%s/%s] Redo at k=%d returned false", sc.name, mode, k)
			}
			if err := sc.invariant(doc, snapshots[k]); err != nil {
				t.Errorf("[%s/%s] after redo to step %d: %v", sc.name, mode, k, err)
			}
		}
	case modeReload:
		// Serialise, build a fresh doc from the bytes, check invariant matches
		// the final step's want.
		state := doc.ToState()
		reloaded := worker.NewConversationDocument(docID+"-reload", "user:reload")
		defer reloaded.Destroy()
		if err := reloaded.LoadFromState(state); err != nil {
			t.Fatalf("[%s/%s] LoadFromState: %v", sc.name, mode, err)
		}
		final := []string{}
		if n := len(sc.steps); n > 0 && sc.steps[n-1].want != nil {
			final = sc.steps[n-1].want
		}
		if err := sc.invariant(reloaded, final); err != nil {
			t.Errorf("[%s/%s] after reload: %v", sc.name, mode, err)
		}
	}
}

// =============================================================================
// SCENARIOS
// =============================================================================

var invariantScenarios = []invariantScenario{
	{
		name:      "I01_insert_three_then_delete_middle",
		invariant: itemsMatchExpected,
		steps: []invariantStep{
			invIns(0, "a", "A", []string{"A"}),
			invIns(1, "b", "B", []string{"A", "B"}),
			invIns(2, "c", "C", []string{"A", "B", "C"}),
			invDel(1, []string{"A", "C"}),
		},
	},
	{
		name:      "I02_prepend_chain",
		invariant: itemsMatchExpected,
		steps: []invariantStep{
			invIns(0, "a", "A", []string{"A"}),
			invIns(0, "b", "B", []string{"B", "A"}),
			invIns(0, "c", "C", []string{"C", "B", "A"}),
		},
	},
}

func TestYjsInvariants(t *testing.T) {
	for _, sc := range invariantScenarios {
		runInvariantScenario(t, sc)
	}
}
