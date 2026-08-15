//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"time"
)

// Engine round-trip helpers. Several worker→engine requests (run-strategy-hook,
// build-subthread-spec) share the same shape: drain any stale
// reply, send a targeted request stamped with a fresh request ID, then block on
// a dedicated 1-buffered reply channel while still servicing inbound messages
// and doc/batcher signals so the single run goroutine never deadlocks. This file
// factors that shape out of the individual round-trip call sites.

// drainStaleReply discards any reply left buffered on ch by a prior timed-out
// engine round-trip, so the next requestID match can't trip over it (mirrors
// the drain callLLM does on llmResponseChan before a new call).
func drainStaleReply(ch <-chan json.RawMessage) {
	select {
	case <-ch:
	default:
	}
}

// waitForEngineReply blocks until match returns (value, true) for a reply on ch,
// or the timeout / worker shutdown fires. While waiting it keeps servicing
// inbound worker messages (returning the zero value if a cancel arrives) and
// doc/batcher signals, exactly like the hand-rolled engine-hook wait loops it
// replaces. match is called for every reply on ch: it returns (value, true) to
// stop and yield value, or (_, false) to keep waiting (e.g. a reply whose
// requestID doesn't match ours). onTimeout, when non-nil, runs the caller's
// timeout logging/tape before the zero value is returned.
//
// It deliberately does NOT service livenessC/detectFrozenGap — these short
// engine round-trips never did, unlike the LLM-call wait — so behavior is
// preserved exactly.
func waitForEngineReply[T any](
	w *ConversationWorker,
	ch <-chan json.RawMessage,
	timeout time.Duration,
	match func(json.RawMessage) (T, bool),
	onTimeout func(),
) (T, bool) {
	var zero T
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case raw := <-ch:
			if v, ok := match(raw); ok {
				return v, true
			}
		case msg := <-w.inbound:
			w.handleMessageInWait(msg)
			if w.loadState() == StateCancelling {
				return zero, false
			}
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-timer.C:
			if onTimeout != nil {
				onTimeout()
			}
			return zero, false
		case <-w.done:
			return zero, false
		}
	}
}
