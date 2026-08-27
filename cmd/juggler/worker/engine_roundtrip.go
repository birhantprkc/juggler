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
// targeted request, then block on that request's private reply channel. This
// file factors that shape out of the individual round-trip call sites.

// waitForEngineReply blocks until match returns (value, true) for a reply on the
// reply channel, or a cancel / the timeout / worker shutdown fires. Correlation
// is not match's job — the registry has already refused everything but this
// request's answer — so match decides answer MEANS: it returns (value, true) to
// stop and yield value, or (_, false) to keep waiting (a reply it cannot read at
// all).
//
// It waits on this run's own channels and nothing else. The worker's mailbox,
// its doc signal and its liveness ticker all belong to the run loop, which keeps
// serving them for the whole of a turn; a cancel reaches here as a state change
// plus a wake, which is the only thing a wait loop has ever done with one.
func waitForEngineReply[T any](
	r *run,
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
		case <-r.t.wake:
			if r.loadState() == StateCancelling {
				return zero, false
			}
		case <-timer.C:
			if onTimeout != nil {
				onTimeout()
			}
			return zero, false
		case <-r.done:
			return zero, false
		}
	}
}
