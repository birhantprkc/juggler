//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

// TestEventTapeDumpSeesPriorRecord pins the ordering contract that the
// compaction-tape assertions rely on: a Record() that happens-before a DumpAll()
// on the same goroutine MUST appear in that dump. Record() sends to the buffered
// `in` channel while DumpAll() sends to `dumps`; run() selects between them, so
// without draining `in` before answering a dump the select can service the dump
// first and silently omit the just-recorded entry. The tight loop makes that race
// statistically certain to fire at least once when the drain is absent.
func TestEventTapeDumpSeesPriorRecord(t *testing.T) {
	prev := tracingEnabled
	tracingEnabled = true
	t.Cleanup(func() { tracingEnabled = prev })

	tape := NewEventTape()
	for i := 0; i < 3000; i++ {
		tape.Record("probe", map[string]any{"i": i})
		got := tape.DumpAll()
		if len(got) == 0 {
			t.Fatalf("iteration %d: DumpAll returned no entries after a Record", i)
		}
		if last := got[len(got)-1].Summary["i"]; last != i {
			t.Fatalf("iteration %d: newest dumped entry i=%v, want %d (Record→DumpAll ordering violated)", i, last, i)
		}
	}
}
