//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Y-CRDT outbound update debouncer: coalesces a burst of small Yjs updates
// (e.g. one per character of a streamed message) into one merged broadcast
// per SyncThrottleMs window. The worker's run-loop selects on TimerChan;
// when it fires, it calls Flush (which drains the doc via doc.DrainUpdates()).
// Schedule is called from the same goroutine when the doc's UpdateSignal fires,
// to arm the timer without taking the global ycrdtMu per update.

package worker

import (
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// syncBatcher is owned by exactly one worker's run() goroutine — no locking
// needed. Construct with newSyncBatcher and route the worker's select to:
//
//	case <-doc.UpdateSignal():   batcher.Schedule()
//	case <-batcher.TimerChan():  batcher.Flush()
//
// TimerChan() returns nil when no batch is pending so the select never
// wakes spuriously.
type syncBatcher struct {
	pending  [][]byte
	timer    *time.Timer
	doc      *ConversationDocument // for drain + broadcast resolution at flush time
	throttle time.Duration
}

func newSyncBatcher(doc *ConversationDocument, throttle time.Duration) *syncBatcher {
	return &syncBatcher{doc: doc, throttle: throttle}
}

// Schedule arms the flush timer if it isn't already running, so any updates the
// doc has buffered are broadcast within one throttle window. It deliberately
// does NOT drain the doc: draining takes the global ycrdtMu, so doing it here
// (once per update signal, per worker) would pile contention onto that shared
// lock. Flush drains instead — once per broadcast window.
func (b *syncBatcher) Schedule() {
	if b.timer == nil {
		b.timer = time.NewTimer(b.throttle)
	}
}

// TimerChan returns the live timer channel, or nil when no batch is pending.
// Selecting on a nil channel blocks forever, which removes the case cleanly.
func (b *syncBatcher) TimerChan() <-chan time.Time {
	if b.timer == nil {
		return nil
	}
	return b.timer.C
}

// Flush drains any updates still buffered in the doc, merges the pending batch,
// and broadcasts a single combined update. Resets the timer. Safe to call when
// nothing is pending.
func (b *syncBatcher) Flush() {
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.pending = append(b.pending, b.doc.DrainUpdates()...)
	if len(b.pending) > 0 && b.doc.onSyncBroadcast != nil {
		merged := ycrdt.MergeUpdates(b.pending, ycrdt.NewUpdateDecoderV1, ycrdt.NewUpdateEncoderV1, false)
		b.doc.onSyncBroadcast(merged)
		b.pending = nil
	}
}
