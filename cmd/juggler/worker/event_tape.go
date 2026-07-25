//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"os"
	"time"
)

// EventTapeEntry is one timestamped event recorded by a ConversationWorker
// for cross-correlation with JS-side iframe tapes when a test fails. Mirrors
// web/js/utils/event-tape.js TapeEntry. Kept lean: no nested objects beyond
// a small Summary map so dumps are cheap to serialise.
type EventTapeEntry struct {
	TS      int64          `json:"ts"`      // Unix milliseconds, matches JS Date.now().
	Kind    string         `json:"kind"`    // Short category, e.g. "yjs-apply", "mock-pop".
	Summary map[string]any `json:"summary"` // Small payload, JSON-safe.
}

// EventTape is a per-worker ring buffer. Single goroutine consumes Record
// requests off `in` and dump requests off `dumps`; the goroutine owns the
// underlying slice so no mutex is required (per CLAUDE.md: goroutines and
// channels, not sync.Mutex). No-ops when JUGGLER_TRACE is unset — the
// goroutine isn't even started in that case.
type EventTape struct {
	enabled bool
	in      chan EventTapeEntry
	dumps   chan chan []EventTapeEntry
}

const eventTapeCapacity = 2000

// tracingEnabled returns true when JUGGLER_TRACE is set to a non-empty value.
// Resolved once at process startup; subsequent env mutations are ignored to
// keep the per-Record hot path branch-free after construction.
var tracingEnabled = os.Getenv("JUGGLER_TRACE") != ""

// NewEventTape constructs a fresh tape. Capacity is fixed; entries beyond it
// overwrite the oldest. The owner goroutine is spawned only when tracing is
// enabled — disabled tapes have nil channels and Record returns immediately.
func NewEventTape() *EventTape {
	if !tracingEnabled {
		return &EventTape{}
	}
	t := &EventTape{
		enabled: true,
		// `in` is buffered so a burst of Record calls from the worker
		// actor goroutine doesn't block on the tape goroutine reading.
		// 256 covers the typical observer-tick fan-out comfortably.
		in:    make(chan EventTapeEntry, 256),
		dumps: make(chan chan []EventTapeEntry, 4),
	}
	go t.run()
	return t
}

// run owns the ring buffer. Single reader of `in` and `dumps` so the buffer
// needs no synchronisation primitive.
func (t *EventTape) run() {
	buf := make([]EventTapeEntry, eventTapeCapacity)
	var head, size int

	appendEntry := func(e EventTapeEntry) {
		if size < eventTapeCapacity {
			buf[size] = e
			size++
		} else {
			buf[head] = e
			head = (head + 1) % eventTapeCapacity
		}
	}
	snapshot := func() []EventTapeEntry {
		out := make([]EventTapeEntry, 0, size)
		if size < eventTapeCapacity {
			out = append(out, buf[:size]...)
		} else {
			out = append(out, buf[head:]...)
			out = append(out, buf[:head]...)
		}
		return out
	}

	for {
		select {
		case e, ok := <-t.in:
			if !ok {
				return
			}
			appendEntry(e)
		case reply := <-t.dumps:
			// Drain every record already queued on `in` before answering. A
			// Record() that happens-before this DumpAll() on the same goroutine
			// completes its `in <- e` send before the later `dumps <- reply`, so
			// the entry is guaranteed to be sitting in `in`'s buffer here — but
			// the select above could otherwise service this dump first and omit
			// it. This non-blocking drain makes DumpAll observe all prior Records,
			// which the compaction-tape assertions depend on.
			for drained := false; !drained; {
				select {
				case e, ok := <-t.in:
					if !ok {
						drained = true
						break
					}
					appendEntry(e)
				default:
					drained = true
				}
			}
			reply <- snapshot()
		}
	}
}

// Record appends one entry. No-op when tracing is disabled or the goroutine
// hasn't been spawned. Non-blocking: if the buffer is full, the entry is
// dropped rather than blocking the worker actor goroutine — tape losses are
// acceptable, blocking the worker is not.
func (t *EventTape) Record(kind string, summary map[string]any) {
	if t == nil || !t.enabled {
		return
	}
	entry := EventTapeEntry{
		TS:      time.Now().UnixMilli(),
		Kind:    kind,
		Summary: summary,
	}
	select {
	case t.in <- entry:
	default:
		// Buffer full; drop to avoid back-pressuring the worker.
	}
}

// DumpAll returns entries in chronological order. Sends a request channel
// and blocks (briefly) for the reply. Used by the test diagnostic endpoint
// to splice the worker's view into the JS-side failure block.
func (t *EventTape) DumpAll() []EventTapeEntry {
	if t == nil || !t.enabled {
		return nil
	}
	reply := make(chan []EventTapeEntry, 1)
	t.dumps <- reply
	return <-reply
}
