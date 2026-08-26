//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// inject queues a test-only answer for the next registration. Production has no
// uncorrelated route into a reply registry; older worker harnesses intentionally
// use this bypass because they prepare replies before observing request ids.
func (s *replySlot) inject(abort <-chan struct{}, payload json.RawMessage) bool {
	result := make(chan bool, 1)
	select {
	case s.commands <- injectReply{payload: payload, abort: abort, result: result}:
		// Test harnesses deliberately queue replies before starting the request.
		// Acceptance is therefore asynchronous: the registry will either hand this
		// payload to the oldest unanswered registration or retain it for the next
		// one. Waiting for that registration here would deadlock callers that queue
		// context and tools replies serially before dispatching the turn.
		return true
	case <-abort:
		return false
	case <-s.done:
		return false
	}
}

// held reports the number of accepted replies currently buffered across all
// registrations.
func (s *replySlot) held() int {
	result := make(chan int)
	s.commands <- countReplies{result: result}
	return <-result
}
