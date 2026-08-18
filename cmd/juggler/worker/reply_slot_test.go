//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// TestEveryReplySlotRefusesWhatIsNotItsAnswer walks every request/reply
// round-trip the worker actually has and holds each to the same rules.
//
// It iterates w.replySlots — the slots as constructed — rather than a list
// written out here, so a round-trip added later is covered from the moment it
// exists, with nobody having to know these rules to get them. That is the whole
// point of the type: the reason a tool list once reached the wrong thread was
// that each round-trip carried its own correlation, or didn't, and no test could
// tell which. A slot built any other way than newReplySlot has a nil channel and
// wedges on its first wait, so there is no quiet way out of the registry either.
func TestEveryReplySlotRefusesWhatIsNotItsAnswer(t *testing.T) {
	w := NewConversationWorker("conv-slots", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	if len(w.replySlots) == 0 {
		t.Fatal("the worker registered no reply slots; this test would pass by vacuum")
	}

	for _, slot := range w.replySlots {
		t.Run(slot.name, func(t *testing.T) {
			answer := func(requestID string) json.RawMessage {
				payload, _ := json.Marshal(map[string]any{"requestId": requestID, "answers": slot.name})
				return payload
			}

			// Nothing was asked, so nothing is an answer.
			slot.deliver(answer("req-1"))
			if slot.held() != 0 {
				t.Fatal("an unarmed slot took a reply")
			}

			disarm := slot.arm("req-1")

			slot.deliver(answer("some-other-request"))
			if slot.held() != 0 {
				t.Fatal("took a reply belonging to another request")
			}

			slot.deliver(json.RawMessage(`{"result":"no id here"}`))
			if slot.held() != 0 {
				t.Fatal("took a reply that names no request")
			}

			slot.deliver(answer("req-1"))
			if slot.held() != 1 {
				t.Fatal("refused the answer to the request in flight")
			}

			// The turn reads its answer; the other clients are still answering
			// the same broadcast behind it.
			<-slot.out()
			slot.deliver(answer("req-1"))
			if slot.held() != 0 {
				t.Fatal("took a second answer to a request already answered")
			}

			disarm()
			slot.deliver(answer("req-1"))
			if slot.held() != 0 {
				t.Fatal("took a reply after the round-trip had ended")
			}

			// A round-trip that ends without reading its answer leaves it behind.
			// The next request must not read it as its own.
			endWithoutReading := slot.arm("req-2")
			slot.deliver(answer("req-2"))
			endWithoutReading()

			defer slot.arm("req-3")()
			if slot.answersCurrent(<-slot.out()) {
				t.Fatal("an abandoned round-trip's answer was accepted as the next request's")
			}
		})
	}
}
