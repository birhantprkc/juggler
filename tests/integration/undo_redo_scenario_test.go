//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"fmt"
	"juggler/cmd/juggler/worker"
	"testing"
)

// =============================================================================
// UNDO/REDO SCENARIO FRAMEWORK
//
// Each scenario is a sequence of steps. Every mutating step (insert, delete,
// undo, redo) MUST declare the full expected document state in `want`.
// verifyFullState checks BOTH the item count AND the content of every item —
// a count-only check cannot catch wrong-order bugs.
//
// opExtDel and opDelete both call tracker.DeleteMessages, which calls
// StopCapturing() before the transaction. Each call is therefore its own
// independent undo group regardless of timing.
// =============================================================================

type opKind string

const (
	opInsert  opKind = "insert"  // tracker direct insert
	opDelete  opKind = "delete"  // tracker direct delete
	opExtDel  opKind = "extdel"  // external delete (browser path)
	opReplace opKind = "replace" // tracker replace (index→new content)
	opUndo    opKind = "undo"    // tracker.Undo()
	opRedo    opKind = "redo"    // tracker.Redo()
	opSlow    opKind = "slow"    // StopCapturing — forces a new undo group boundary
)

type scenarioStep struct {
	op      opKind
	index   int      // insert: position; delete/extdel: current index in doc
	id      string   // insert: itemId
	content string   // insert: content value
	typ     string   // insert: item type (default "user")
	want    []string // full expected doc state after this op (nil = no-check, only for opSlow)
}

type undoScenario struct {
	name  string
	steps []scenarioStep
}

// ss is a shorthand for []string{...}, keeping scenario tables readable.
// Always returns a non-nil slice so want != nil even for the empty-document case.
func ss(items ...string) []string {
	if len(items) == 0 {
		return []string{}
	}
	return items
}

// Step constructors — keep scenarios concise.

func ins(idx int, id, content string, want []string) scenarioStep {
	return scenarioStep{op: opInsert, index: idx, id: id, content: content, typ: worker.ItemTypeUser, want: want}
}

func insTyped(idx int, id, content, typ string, want []string) scenarioStep {
	return scenarioStep{op: opInsert, index: idx, id: id, content: content, typ: typ, want: want}
}

func del(idx int, want []string) scenarioStep {
	return scenarioStep{op: opDelete, index: idx, want: want}
}

func extdel(idx int, want []string) scenarioStep {
	return scenarioStep{op: opExtDel, index: idx, want: want}
}

func undoStep(want []string) scenarioStep {
	return scenarioStep{op: opUndo, want: want}
}

func redoStep(want []string) scenarioStep {
	return scenarioStep{op: opRedo, want: want}
}

func repl(idx int, newContent string, want []string) scenarioStep {
	return scenarioStep{op: opReplace, index: idx, content: newContent, want: want}
}

func slow() scenarioStep { return scenarioStep{op: opSlow} }

// verifyFullState asserts the complete document state: count AND every item's content.
func verifyFullState(t *testing.T, items []worker.ConversationItem, want []string, label string) {
	t.Helper()
	if len(items) != len(want) {
		t.Errorf("%s: item count = %d, want %d", label, len(items), len(want))
		for i, item := range items {
			t.Logf("  actual[%d]: content=%q id=%q type=%s", i, item.Content, item.ItemID, item.Type)
		}
		for i, w := range want {
			t.Logf("  want[%d]:   content=%q", i, w)
		}
		return
	}
	for i, wantContent := range want {
		if items[i].Content != wantContent {
			t.Errorf("%s: item[%d].Content = %q, want %q", label, i, items[i].Content, wantContent)
		}
	}
}

// runUndoScenario executes a scenario using direct doc+tracker (no worker goroutine).
// This gives deterministic control over timing and grouping.
func runUndoScenario(t *testing.T, sc undoScenario) {
	t.Helper()
	t.Run(sc.name, func(t *testing.T) {
		t.Parallel()

		doc := worker.NewConversationDocument("sc-"+sc.name, "user:test")
		defer doc.Destroy()
		tracker := worker.NewOperationTracker(doc)

		for i, s := range sc.steps {
			stepDesc := fmt.Sprintf("[%s] step %d (%s)", sc.name, i+1, s.op)

			switch s.op {
			case opInsert:
				typ := s.typ
				if typ == "" {
					typ = worker.ItemTypeUser
				}
				tracker.InsertMessage(s.index, worker.ConversationItem{
					Type:    typ,
					ItemID:  s.id,
					Content: s.content,
				})

			case opDelete:
				tracker.DeleteMessages([]int{s.index})

			case opExtDel:
				items := doc.GetItems()
				if s.index < 0 || s.index >= len(items) {
					t.Fatalf("%s: extdel index %d out of bounds (len=%d)", stepDesc, s.index, len(items))
					return
				}
				tracker.DeleteMessages([]int{s.index})

			case opReplace:
				items := doc.GetItems()
				if s.index < 0 || s.index >= len(items) {
					t.Fatalf("%s: replace index %d out of bounds (len=%d)", stepDesc, s.index, len(items))
					return
				}
				updated := items[s.index]
				updated.Content = s.content
				if err := tracker.ReplaceMessage(s.index, updated); err != nil {
					t.Fatalf("%s: ReplaceMessage error: %v", stepDesc, err)
				}

			case opUndo:
				tracker.Undo()

			case opRedo:
				tracker.Redo()

			case opSlow:
				tracker.StopCapturing()
				// opSlow may omit want — it only separates undo groups
				if s.want == nil {
					continue
				}
			}

			if s.want == nil && s.op != opSlow {
				t.Fatalf("%s: want is required for all non-slow steps", stepDesc)
				return
			}
			if s.want != nil {
				verifyFullState(t, doc.GetItems(), s.want, stepDesc)
			}
		}
	})
}

// =============================================================================
// SCENARIO TABLE
// =============================================================================

var undoScenarios = []undoScenario{

	// =========================================================================
	// GROUP 1: Basic insert / undo / redo
	// =========================================================================

	{
		name: "S01_single_insert_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			slow(),
			undoStep(ss()),
			slow(),
			redoStep(ss("A")),
		},
	},

	{
		name: "S02_three_inserts_slow_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			slow(),
			ins(1, "b", "B", ss("A", "B")),
			slow(),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			undoStep(ss("A", "B")),
			slow(),
			undoStep(ss("A")),
			slow(),
			undoStep(ss()),
			slow(),
			redoStep(ss("A")),
			slow(),
			redoStep(ss("A", "B")),
			slow(),
			redoStep(ss("A", "B", "C")),
		},
	},

	// =========================================================================
	// GROUP 2: Single delete / undo / redo
	// =========================================================================

	{
		name: "S04_delete_middle_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			del(1, ss("A", "C")), // delete B at idx 1
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			redoStep(ss("A", "C")),
		},
	},

	{
		name: "S05_delete_first_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			del(0, ss("B", "C")), // delete A at idx 0
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			redoStep(ss("B", "C")),
		},
	},

	{
		name: "S06_delete_last_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			del(2, ss("A", "B")), // delete C at idx 2
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			redoStep(ss("A", "B")),
		},
	},

	// =========================================================================
	// GROUP 3: 2-item deletion — reverse and forward order, slow separate groups
	// =========================================================================

	{
		name: "S07_two_items_reverse_delete_slow",
		// Delete last then second-to-last, undo each, redo each.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			slow(),
			del(3, ss("A", "B", "C")), // delete D (last)
			slow(),
			del(2, ss("A", "B")), // delete C (now last)
			slow(),
			undoStep(ss("A", "B", "C")), // restore C
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			redoStep(ss("A", "B", "C")), // re-delete D (Op1 was first)
			slow(),
			redoStep(ss("A", "B")), // re-delete C (Op2)
		},
	},

	{
		name: "S08_two_items_forward_delete_slow",
		// Delete second-to-last then last.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			slow(),
			del(2, ss("A", "B", "D")), // delete C (at idx 2, D shifts to idx 2)
			slow(),
			del(2, ss("A", "B")), // delete D (now at idx 2)
			slow(),
			undoStep(ss("A", "B", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore C
			slow(),
			redoStep(ss("A", "B", "D")), // re-delete C
			slow(),
			redoStep(ss("A", "B")), // re-delete D
		},
	},

	// =========================================================================
	// GROUP 4: 3-item reverse-order delete — THE BUG SCENARIO (direct path)
	// =========================================================================

	{
		name: "S09_three_items_reverse_delete_slow",
		// Delete E, D, C in reverse order (last-to-first), then undo and redo each.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			del(4, ss("A", "B", "C", "D")), // delete E
			slow(),
			del(3, ss("A", "B", "C")), // delete D
			slow(),
			del(2, ss("A", "B")), // delete C
			slow(),
			undoStep(ss("A", "B", "C")), // restore C
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore E
			slow(),
			redoStep(ss("A", "B", "C", "D")), // re-delete E (first deleted)
			slow(),
			redoStep(ss("A", "B", "C")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete C
		},
	},

	{
		name: "S10_three_items_forward_delete_slow",
		// Delete C, D, E in forward order (first-to-last of the triplet), then undo/redo.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			del(2, ss("A", "B", "D", "E")), // delete C (D,E shift left)
			slow(),
			del(2, ss("A", "B", "E")), // delete D (now at idx 2)
			slow(),
			del(2, ss("A", "B")), // delete E (now at idx 2)
			slow(),
			undoStep(ss("A", "B", "E")), // restore E at idx 2
			slow(),
			undoStep(ss("A", "B", "D", "E")), // restore D at idx 2
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore C at idx 2
			slow(),
			redoStep(ss("A", "B", "D", "E")), // re-delete C
			slow(),
			redoStep(ss("A", "B", "E")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete E
		},
	},

	{
		name: "S11_three_items_random_delete_slow",
		// Delete D first, then C, then E.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			del(3, ss("A", "B", "C", "E")), // delete D (E shifts to idx 3)
			slow(),
			del(2, ss("A", "B", "E")), // delete C (E shifts to idx 2)
			slow(),
			del(2, ss("A", "B")), // delete E (now at idx 2)
			slow(),
			undoStep(ss("A", "B", "E")), // restore E
			slow(),
			undoStep(ss("A", "B", "C", "E")), // restore C
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore D
		},
	},

	// =========================================================================
	// GROUP 5: 3-item extdel sequences — verify ORDER not just count
	// Each extdel is its own undo group (StopCapturing inside DeleteMessages).
	// =========================================================================

	{
		name: "S12_extdel_reverse_order",
		// Delete E→D→C (reverse order). Each extdel is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(4, ss("A", "B", "C", "D")), // delete E
			extdel(3, ss("A", "B", "C")),      // delete D
			extdel(2, ss("A", "B")),           // delete C
			slow(),
			undoStep(ss("A", "B", "C")), // restore C (last deleted)
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore E
			slow(),
			redoStep(ss("A", "B", "C", "D")), // re-delete E
			slow(),
			redoStep(ss("A", "B", "C")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete C
		},
	},

	{
		name: "S13_extdel_forward_order",
		// Delete C→D→E (forward order). Each extdel is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(2, ss("A", "B", "D", "E")), // delete C (D,E shift)
			extdel(2, ss("A", "B", "E")),      // delete D (now at idx 2)
			extdel(2, ss("A", "B")),           // delete E (now at idx 2)
			slow(),
			undoStep(ss("A", "B", "E")), // restore E (last deleted)
			slow(),
			undoStep(ss("A", "B", "D", "E")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore C
			slow(),
			redoStep(ss("A", "B", "D", "E")), // re-delete C
			slow(),
			redoStep(ss("A", "B", "E")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete E
		},
	},

	{
		name: "S14_extdel_all_items_reverse",
		// Delete all 5 items in reverse order. Each extdel is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(4, ss("A", "B", "C", "D")),
			extdel(3, ss("A", "B", "C")),
			extdel(2, ss("A", "B")),
			extdel(1, ss("A")),
			extdel(0, ss()),
			slow(),
			undoStep(ss("A")), // restore A (last deleted)
			slow(),
			undoStep(ss("A", "B")), // restore B
			slow(),
			undoStep(ss("A", "B", "C")), // restore C
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore E
		},
	},

	// =========================================================================
	// GROUP 6: External/browser-path deletes — slow separate groups
	// This is the exact user bug scenario (each delete is a separate UI click).
	// =========================================================================

	{
		name: "S15_extdel_reverse_order_slow_THE_BUG_SCENARIO",
		// THE BUG: delete E, D, C via browser path (slow) → undo × 3 → wrong order.
		// Each undo step must restore exactly one item at the correct position.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(4, ss("A", "B", "C", "D")), // delete E (separate group)
			slow(),
			extdel(3, ss("A", "B", "C")), // delete D (separate group)
			slow(),
			extdel(2, ss("A", "B")), // delete C (separate group)
			slow(),
			undoStep(ss("A", "B", "C")), // restore C (last deleted)
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore E
			slow(),
			redoStep(ss("A", "B", "C", "D")), // re-delete E
			slow(),
			redoStep(ss("A", "B", "C")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete C
		},
	},

	{
		name: "S16_extdel_forward_order_slow",
		// Delete C, D, E via browser path (slow, forward order) → undo × 3 → redo × 3.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(2, ss("A", "B", "D", "E")), // delete C
			slow(),
			extdel(2, ss("A", "B", "E")), // delete D (now at idx 2)
			slow(),
			extdel(2, ss("A", "B")), // delete E (now at idx 2)
			slow(),
			undoStep(ss("A", "B", "E")), // restore E
			slow(),
			undoStep(ss("A", "B", "D", "E")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore C
			slow(),
			redoStep(ss("A", "B", "D", "E")), // re-delete C
			slow(),
			redoStep(ss("A", "B", "E")), // re-delete D
			slow(),
			redoStep(ss("A", "B")), // re-delete E
		},
	},

	{
		name: "S17_extdel_three_items_reverse",
		// Delete E→D→C via extdel (reverse order). Each is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(4, ss("A", "B", "C", "D")),
			extdel(3, ss("A", "B", "C")),
			extdel(2, ss("A", "B")),
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			undoStep(ss("A", "B", "C", "D")),
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")),
			slow(),
			redoStep(ss("A", "B", "C", "D")),
			slow(),
			redoStep(ss("A", "B", "C")),
			slow(),
			redoStep(ss("A", "B")),
		},
	},

	// =========================================================================
	// GROUP 7: Mixed item types (assistant, thread, user)
	// =========================================================================

	{
		name: "S18_mixed_types_reverse_delete_slow",
		// [A, B, ASST(assistant), THR(thread), MSG(user)] — delete MSG→THR→ASST.
		// Verifies that item type does not affect undo ordering.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			insTyped(2, "asst", "ASST", worker.ItemTypeAssistant, ss("A", "B", "ASST")),
			insTyped(3, "thr", "THR", worker.ItemTypeThread, ss("A", "B", "ASST", "THR")),
			ins(4, "msg", "MSG", ss("A", "B", "ASST", "THR", "MSG")),
			slow(),
			del(4, ss("A", "B", "ASST", "THR")), // delete MSG
			slow(),
			del(3, ss("A", "B", "ASST")), // delete THR
			slow(),
			del(2, ss("A", "B")), // delete ASST
			slow(),
			undoStep(ss("A", "B", "ASST")), // restore ASST
			slow(),
			undoStep(ss("A", "B", "ASST", "THR")), // restore THR
			slow(),
			undoStep(ss("A", "B", "ASST", "THR", "MSG")), // restore MSG
			slow(),
			redoStep(ss("A", "B", "ASST", "THR")), // re-delete MSG
			slow(),
			redoStep(ss("A", "B", "ASST")), // re-delete THR
			slow(),
			redoStep(ss("A", "B")), // re-delete ASST
		},
	},

	{
		name: "S19_mixed_types_extdel_reverse",
		// Delete MSG→THR→ASST via extdel. Each is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			insTyped(2, "asst", "ASST", worker.ItemTypeAssistant, ss("A", "B", "ASST")),
			insTyped(3, "thr", "THR", worker.ItemTypeThread, ss("A", "B", "ASST", "THR")),
			ins(4, "msg", "MSG", ss("A", "B", "ASST", "THR", "MSG")),
			slow(),
			extdel(4, ss("A", "B", "ASST", "THR")), // delete MSG
			extdel(3, ss("A", "B", "ASST")),        // delete THR
			extdel(2, ss("A", "B")),                // delete ASST
			slow(),
			undoStep(ss("A", "B", "ASST")), // restore ASST (last deleted)
			slow(),
			undoStep(ss("A", "B", "ASST", "THR")), // restore THR
			slow(),
			undoStep(ss("A", "B", "ASST", "THR", "MSG")), // restore MSG
			slow(),
			redoStep(ss("A", "B", "ASST", "THR")), // re-delete MSG
			slow(),
			redoStep(ss("A", "B", "ASST")), // re-delete THR
			slow(),
			redoStep(ss("A", "B")), // re-delete ASST
		},
	},

	// =========================================================================
	// GROUP 8: Boundary conditions
	// =========================================================================

	{
		name: "S20_single_item_delete_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			slow(),
			del(0, ss()),
			slow(),
			undoStep(ss("A")),
			slow(),
			redoStep(ss()),
		},
	},

	{
		name: "S21_delete_all_reverse_slow_undo_all",
		// Delete 5 items from last to first (slow), undo each individually.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			del(4, ss("A", "B", "C", "D")),
			slow(),
			del(3, ss("A", "B", "C")),
			slow(),
			del(2, ss("A", "B")),
			slow(),
			del(1, ss("A")),
			slow(),
			del(0, ss()),
			slow(),
			undoStep(ss("A")),
			slow(),
			undoStep(ss("A", "B")),
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			undoStep(ss("A", "B", "C", "D")),
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")),
		},
	},

	{
		name: "S22_extdel_all_reverse",
		// Delete all 5 in reverse order (E→A). Each extdel is its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			extdel(4, ss("A", "B", "C", "D")),
			extdel(3, ss("A", "B", "C")),
			extdel(2, ss("A", "B")),
			extdel(1, ss("A")),
			extdel(0, ss()),
			slow(),
			undoStep(ss("A")), // restore A (last deleted)
			slow(),
			undoStep(ss("A", "B")),
			slow(),
			undoStep(ss("A", "B", "C")),
			slow(),
			undoStep(ss("A", "B", "C", "D")),
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")),
		},
	},

	{
		name: "S23_single_tracker_delete_call_multi_index",
		// tracker.DeleteMessages([4,3,2]) is a single call → single undo group.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			ins(3, "d", "D", ss("A", "B", "C", "D")),
			ins(4, "e", "E", ss("A", "B", "C", "D", "E")),
			slow(),
			// Single tracker.DeleteMessages call with multiple indices = single undo group.
			del(4, ss("A", "B", "C", "D")), // internally calls DeleteMessages([4])
			del(3, ss("A", "B", "C")),      // separate call = separate group
			del(2, ss("A", "B")),           // separate call = separate group
			slow(),
			undoStep(ss("A", "B", "C")), // restore C (last deleted)
			slow(),
			undoStep(ss("A", "B", "C", "D")), // restore D
			slow(),
			undoStep(ss("A", "B", "C", "D", "E")), // restore E
			slow(),
			redoStep(ss("A", "B", "C", "D")),
			slow(),
			redoStep(ss("A", "B", "C")),
			slow(),
			redoStep(ss("A", "B")),
		},
	},

	// =========================================================================
	// GROUP 9: Branching (undo then new insert clears redo)
	// =========================================================================

	{
		name: "S24_branch_undo_insert_clears_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			slow(),
			ins(1, "b", "B", ss("A", "B")),
			slow(),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			undoStep(ss("A", "B")), // undo C
			slow(),
			// Insert D — this clears redo stack (can't redo C anymore)
			ins(2, "d", "D", ss("A", "B", "D")),
			slow(),
			// Redo is no-op (stack cleared)
			redoStep(ss("A", "B", "D")),
			slow(),
			undoStep(ss("A", "B")), // undo D
			slow(),
			undoStep(ss("A")), // undo B
			slow(),
			undoStep(ss()), // undo A
		},
	},

	// =========================================================================
	// GROUP 10: Mixed insert + delete sequences
	// =========================================================================

	{
		name: "S25_interleaved_insert_delete_undo_sequence",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			slow(),
			ins(1, "b", "B", ss("A", "B")),
			slow(),
			del(1, ss("A")), // delete B
			slow(),
			ins(1, "c", "C", ss("A", "C")),
			slow(),
			ins(2, "d", "D", ss("A", "C", "D")),
			slow(),
			undoStep(ss("A", "C")), // undo D insert
			slow(),
			undoStep(ss("A")), // undo C insert
			slow(),
			undoStep(ss("A", "B")), // undo B delete (B restored)
			slow(),
			undoStep(ss("A")), // undo B insert
			slow(),
			undoStep(ss()), // undo A insert
		},
	},

	{
		name: "S26_delete_first_repeatedly",
		// Delete idx 0 repeatedly — tests that items are restored at position 0, not appended.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			del(0, ss("B", "C")), // delete A
			slow(),
			del(0, ss("C")), // delete B (now at 0)
			slow(),
			del(0, ss()), // delete C (now at 0)
			slow(),
			undoStep(ss("C")), // restore C at idx 0
			slow(),
			undoStep(ss("B", "C")), // restore B at idx 0
			slow(),
			undoStep(ss("A", "B", "C")), // restore A at idx 0
		},
	},
	// =========================================================================
	// GROUP 11: Replace operations
	// =========================================================================

	{
		name: "S27_replace_undo_redo",
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			ins(2, "c", "C", ss("A", "B", "C")),
			slow(),
			repl(1, "B-new", ss("A", "B-new", "C")),
			slow(),
			undoStep(ss("A", "B", "C")), // undo restores old content
			slow(),
			redoStep(ss("A", "B-new", "C")), // redo re-applies new content
		},
	},

	{
		name: "S28_replace_clears_redo",
		// Undo a prior insert, then replace — the replace must clear the redo stack.
		steps: []scenarioStep{
			ins(0, "a", "A", ss("A")),
			ins(1, "b", "B", ss("A", "B")),
			slow(),
			undoStep(ss("A")), // undo B insert; redo-stack now has [insert-B]
			slow(),
			repl(0, "A-new", ss("A-new")), // replace clears redo stack
			slow(),
			redoStep(ss("A-new")), // redo is no-op (stack cleared)
			slow(),
			undoStep(ss("A")), // undo replace restores old content
			slow(),
			undoStep(ss()), // undo A insert
		},
	},

	{
		name: "S29_replace_multiple_independent_groups",
		// Each replace of a non-auxiliary type starts its own undo group.
		steps: []scenarioStep{
			ins(0, "a", "orig", ss("orig")),
			slow(),
			repl(0, "v1", ss("v1")),
			slow(),
			repl(0, "v2", ss("v2")),
			slow(),
			undoStep(ss("v1")), // undo v2
			slow(),
			undoStep(ss("orig")), // undo v1
			slow(),
			redoStep(ss("v1")), // redo v1
			slow(),
			redoStep(ss("v2")), // redo v2
		},
	},

	// =========================================================================
	// GROUP 12: Auxiliary-as-first-operation
	// =========================================================================

	{
		name: "S30_auxiliary_first_op_forms_own_group",
		// When an auxiliary type is the very first operation, allAuxiliary returns true
		// so StopCapturing is not called. The item still forms its own undo group
		// because the UndoManager creates a new group for the first transaction.
		steps: []scenarioStep{
			insTyped(0, "t1", "thinking-content", "thinking", ss("thinking-content")),
			slow(),
			undoStep(ss()),
			slow(),
			redoStep(ss("thinking-content")),
		},
	},

	{
		name: "S31_auxiliary_after_user_groups_with_previous",
		// Auxiliary items merge with the preceding undo group, not a new one.
		// Undo of the auxiliary item should restore both it and the user message.
		steps: []scenarioStep{
			ins(0, "u", "User", ss("User")),
			insTyped(1, "t", "Thinking", "thinking", ss("User", "Thinking")),
			slow(),
			undoStep(ss()), // both items undone as one group
			slow(),
			redoStep(ss("User", "Thinking")),
		},
	},
}

// TestUndoScenario runs all scenarios from the table as subtests.
func TestUndoScenario(t *testing.T) {
	for _, sc := range undoScenarios {
		runUndoScenario(t, sc)
	}
}
