//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"time"
)

// Engine round-trip helpers. Several worker→engine requests (run-strategy-hook,
// build-subthread-spec) share the same shape: register a request id, send the
// targeted request, then block on that request's private reply channel while
// servicing inbound messages and doc/batcher signals so the single run
// goroutine never deadlocks. This file factors that shape out of the
// individual round-trip call sites.

// waitForEngineReply blocks until match returns (value, true) for a reply on the
// reply channel, or the timeout / worker shutdown fires. While waiting it keeps
// servicing inbound worker messages (returning the zero value if a cancel
// arrives) and doc/batcher signals. Correlation is not match's job — the registry
// has already refused everything but this request's answer — so match decides
// answer MEANS: it returns (value, true) to stop and yield value, or (_, false)
// to keep waiting (a reply it cannot read at all).
//
// It deliberately does NOT service livenessC/detectFrozenGap — these short
// engine round-trips never did, unlike the LLM-call wait.
func waitForEngineReply[T any](
	w *ConversationWorker,
	reply <-chan json.RawMessage,
	timeout time.Duration,
	match func(json.RawMessage) (T, bool),
	onTimeout func(),
) (T, bool) {
	var zero T
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case raw := <-reply:
			if v, ok := match(raw); ok {
				return v, true
			}
		case msg := <-w.inbound:
			w.currentRun().handleMessageInWait(msg)
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
