//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package mailbox provides the ordered, never-blocking delivery primitives
// that juggler's actor goroutines use to fan out to clients.
//
// The rule it encodes: an actor must NEVER invoke a potentially-blocking
// consumer inline. A client whose WebSocket send buffer is full blocks its
// send for as long as it stays slow; if the actor calls that send directly,
// one slow client stalls every other client's deliveries and everything else
// the actor serializes (acks, joins, state changes). Any new actor→consumer
// path should be built on these primitives rather than hand-rolling delivery.
//
// Queue[T] is an unbounded FIFO with a single pump goroutine: Push hands off
// in one goroutine hop regardless of consumer backlog and never drops.
// Mailbox[T] couples a Queue with a delivery goroutine — the only caller of
// the possibly-blocking deliver func — so a slow consumer delays only its own
// deliveries while preserving per-consumer FIFO order.
package mailbox

// Queue is an order-preserving FIFO with no capacity limit, backed by a
// single pump goroutine that holds an in-memory slice. It exists so message
// intake can never silently drop: a fixed-capacity channel forces a choice
// between blocking the producer and discarding the message, and for actor
// pipelines both are wrong — blocking a shared actor stalls every consumer it
// serves, and a discarded message (a yjs-sync carrying an approval, say) is
// lost for good. Push enqueues onto the internal slice in one goroutine hop;
// the consumer reads Out() at its own pace.
//
// Single consumer only: reads from Out() need no further coordination.
// Lifetime is tied to done: when it closes, the pump exits and any
// still-buffered values are discarded — by then the consumer is gone and
// nobody is waiting on them.
type Queue[T any] struct {
	in   chan T
	out  chan T
	done <-chan struct{}
}

// NewQueue creates a queue whose pump goroutine runs until done closes.
func NewQueue[T any](done <-chan struct{}) *Queue[T] {
	q := &Queue[T]{
		in:   make(chan T),
		out:  make(chan T),
		done: done,
	}
	go q.run()
	return q
}

func (q *Queue[T]) run() {
	var buf []T
	for {
		if len(buf) == 0 {
			// Nothing to deliver — only accept new items (or shut down).
			select {
			case v := <-q.in:
				buf = append(buf, v)
			case <-q.done:
				return
			}
		} else {
			select {
			case v := <-q.in:
				buf = append(buf, v)
			case q.out <- buf[0]:
				buf = buf[1:]
				if len(buf) == 0 {
					buf = nil // release the backing array so it can be GC'd
				}
			case <-q.done:
				return
			}
		}
	}
}

// Push enqueues v. It blocks only for the pump's next receive (one goroutine
// hop), never for the consumer's processing time, and never after done closes
// — so it neither stalls the caller on a busy consumer nor panics during
// shutdown.
func (q *Queue[T]) Push(v T) {
	select {
	case q.in <- v:
	case <-q.done:
	}
}

// Out returns the consumption channel. Single consumer only.
func (q *Queue[T]) Out() <-chan T { return q.out }

// Mailbox is one consumer's ordered delivery pipeline. Enqueue never blocks
// on the consumer (one goroutine hop into the queue's pump); the delivery
// goroutine drains the FIFO and invokes deliver, absorbing however long the
// consumer takes. deliver runs on a single goroutine, so it may safely hold
// mutable state in its closure (the worker's callback-swap does). Stop
// releases both goroutines and discards anything undelivered — correct for a
// departing consumer, whose messages have nobody waiting. A delivery
// goroutine blocked inside a wedged deliver call exits as soon as that call
// returns (for WSClient sends, when the client's connection closes).
type Mailbox[T any] struct {
	q    *Queue[T]
	done chan struct{}
	// stopTok holds one token; the Stop call that takes it closes done.
	// Subsequent (or concurrent) Stops find it empty and no-op, so Stop is
	// idempotent without a mutex — teardown paths that can overlap (a
	// per-consumer remove racing a whole-actor stop) never double-close.
	stopTok chan struct{}
}

// NewMailbox creates a mailbox delivering through deliver on a dedicated
// goroutine.
func NewMailbox[T any](deliver func(T)) *Mailbox[T] {
	done := make(chan struct{})
	m := &Mailbox[T]{q: NewQueue[T](done), done: done, stopTok: make(chan struct{}, 1)}
	m.stopTok <- struct{}{}
	go func() {
		for {
			select {
			case v := <-m.q.out:
				deliver(v)
			case <-done:
				return
			}
		}
	}()
	return m
}

// Enqueue appends v to the ordered queue without blocking on the consumer.
func (m *Mailbox[T]) Enqueue(v T) { m.q.Push(v) }

// Stop releases the mailbox's goroutines, discarding undelivered values.
// Idempotent and safe to call concurrently.
func (m *Mailbox[T]) Stop() {
	select {
	case <-m.stopTok:
		close(m.done)
	default:
	}
}
