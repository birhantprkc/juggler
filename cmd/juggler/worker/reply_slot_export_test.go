//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// inject hands a reply to the slot without arming it or matching an id — the one
// way past the correlation, and it exists only in tests. Declaring it in a
// _test.go file is the point: production code is compiled without it, so the
// only route in there remains deliver, with every rule applied.
//
// It is here because most worker tests stand in for the clients by queueing the
// answers a turn will need before that turn runs, rather than watching for the
// request and answering the id it carries. Those harnesses have no id to quote,
// so they cannot go through deliver. What they are doing is a bypass either way;
// this makes it say so at the call site.
//
// Blocks until the slot takes the payload or abort closes, returning false in
// the latter case. abort is explicit because a feeder goroutine must stop when
// the thing that started it says so — for most that is the worker's done, but a
// test that closes its own channel first would otherwise leak the goroutine past
// the end of the test.
func (s *replySlot) inject(abort <-chan struct{}, payload json.RawMessage) bool {
	select {
	case s.ch <- payload:
		return true
	case <-abort:
		return false
	}
}

// held reports how many replies the slot is holding: 0 or 1. A test asserts on
// it to show that a reply was taken, or that nothing was left behind for the
// next round-trip to find.
func (s *replySlot) held() int { return len(s.ch) }
