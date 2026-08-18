//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// A replySlot is the worker's end of one request/reply round-trip with its
// clients: the worker sends a request stamped with a fresh id, then blocks until
// the answer to THAT request arrives.
//
// Every such round-trip needs the same things to be correct — the one-deep
// channel the answer lands on, the id of the request in flight, the discipline
// of taking exactly one answer to it, and the refusal to read an answer meant
// for an earlier one. Held apart, as separate pieces of state in separate files,
// a round-trip implementing only some of them is indistinguishable from one
// implementing all of them, and the missing rules are invisible until a turn
// runs on another thread's answer. Held together here, they are not something a
// new round-trip has to remember: nothing outside this file can put a value on
// the channel, and the one way in applies all of them.
//
// Why they are needed at all: a worker request is BROADCAST, so every connected
// client answers it. One answer belongs to the turn that asked; the rest are
// duplicates that must go nowhere. The channel holds one, so an accepted
// duplicate is read by the NEXT turn as its own answer — and that turn's real
// answer, arriving to a full slot, is dropped. What these round-trips carry is
// per-thread (a tool list is filtered through the strategy of the thread whose
// turn it is), so a leftover is not a harmless copy of the same thing: it is a
// different thread's answer, and the turn runs on it.
//
// arm, disarm, deliver and answersCurrent all run on the worker's single
// event-loop goroutine — deliver from the inbound dispatch, the rest from the
// run loop — so none of this state needs a lock. Nothing here is touched from
// another goroutine, which is the property that keeps it that way.
type replySlot struct {
	// name is the request type this slot answers, for test diagnostics.
	name string
	ch   chan json.RawMessage
	// armed is the id of the request in flight, "" between round-trips.
	armed string
	// answered records that the answer to the armed request has been taken, so
	// the duplicates arriving behind it from the other clients are refused.
	answered bool
}

// newReplySlot builds the slot for a named request type and registers it on the
// worker, so a test can enumerate every round-trip the worker actually has
// rather than a list someone must remember to extend.
func (w *ConversationWorker) newReplySlot(name string) *replySlot {
	s := &replySlot{name: name, ch: make(chan json.RawMessage, 1)}
	w.replySlots = append(w.replySlots, s)
	return s
}

// arm opens the slot for the answer to requestID and returns the function that
// shuts it again. Write it as `defer slot.arm(id)()` at the site that sends the
// request, so the round-trip is bounded by the call that started it.
func (s *replySlot) arm(requestID string) func() {
	s.armed, s.answered = requestID, false
	return func() { s.armed, s.answered = "", false }
}

// deliver offers an inbound reply to the slot, which takes it only if it answers
// the request in flight and that request has not been answered already.
// Everything else is dropped in silence, because a duplicate from another client
// is the ordinary case rather than a fault. A reply carrying no id cannot be
// attributed to a request and is refused rather than guessed at — which is why
// every client reply stamps the id it answers.
func (s *replySlot) deliver(payload json.RawMessage) {
	if s.armed == "" || s.answered {
		return
	}
	var head struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(payload, &head) != nil || head.RequestID != s.armed {
		return
	}
	select {
	case s.ch <- payload:
		s.answered = true
	default:
	}
}

// answersCurrent reports whether a payload just taken from the slot really
// answers the request in flight, and a wait loop must ask before using one.
//
// Correlating on the way in is not sufficient by itself: a round-trip that ended
// without reading its answer — cancelled mid-turn, or abandoned when the other
// half of a paired wait timed out — leaves that answer in the channel, and the
// next request's reader would otherwise take it. Rejecting it here costs that
// reader one more turn of the loop and needs no clearing-up pass, which is worth
// more than it sounds: a pass that discarded leftovers could not tell one from a
// reply a test had queued in advance.
//
// A payload with no id is not attributable to any request. Only a test bypass
// produces one, so it is allowed through rather than stranding those harnesses.
func (s *replySlot) answersCurrent(payload json.RawMessage) bool {
	var head struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(payload, &head) != nil || head.RequestID == "" {
		return true
	}
	return head.RequestID == s.armed
}

// out is the receive end, for a wait loop's select.
func (s *replySlot) out() <-chan json.RawMessage { return s.ch }
