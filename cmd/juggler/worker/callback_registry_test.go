//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// Starvation tests for the per-worker callbackRegistry — the fan-out hop that
// carries every worker broadcast and ack into each client's WSClient send
// buffer. The property pinned here: one client whose callback blocks (a viewer
// with a full 256-deep WS send buffer under pool load) must never stall
// delivery to any OTHER client, and must never stall the registry actor
// itself. This is the same bug class as the viewerGroup goroutine-per-broadcast
// reordering, on the worker's outbound path: when the registry actor invoked
// callbacks inline, a single wedged viewer blocked the worker's entire
// broadcast/ack pipeline — observed in the pool as "Ack timeout for ping" even
// at a 30s timeout.

import (
	"fmt"
	"testing"
	"time"
)

const registryTestTimeout = 10 * time.Second

// wedgeClient registers a callback for clientID that blocks until release is
// closed, and signals entered (once) when the first delivery is in progress.
func wedgeClient(r *callbackRegistry, clientID string) (entered chan struct{}, release chan struct{}) {
	entered = make(chan struct{}, 1)
	release = make(chan struct{})
	r.set(clientID, func([]byte) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	})
	return entered, release
}

// expectInOrder asserts that ch yields exactly want (in order), ignoring any
// occurrence of skip (delivery order of the wedge-triggering broadcast relative
// to the fast client is map-iteration dependent).
func expectInOrder(t *testing.T, ch chan string, want []string, skip string) {
	t.Helper()
	deadline := time.After(registryTestTimeout)
	for _, expected := range want {
		for {
			select {
			case got := <-ch:
				if got == skip {
					continue
				}
				if got != expected {
					t.Fatalf("out-of-order delivery: got %q, want %q", got, expected)
				}
			case <-deadline:
				t.Fatalf("starved waiting for %q — a wedged peer blocked delivery to a healthy client", expected)
			}
			break
		}
	}
}

// TestCallbackRegistry_WedgedClientDoesNotStallBroadcasts pins the core
// starvation property: with one client wedged mid-delivery, broadcasts must
// still reach every other client, in order.
func TestCallbackRegistry_WedgedClientDoesNotStallBroadcasts(t *testing.T) {
	r := newCallbackRegistry()
	entered, release := wedgeClient(r, "slow")
	fast := make(chan string, 64)
	r.set("fast", func(b []byte) { fast <- string(b) })

	r.broadcast([]byte("wedge"))
	<-entered // the slow client is now blocked inside its callback

	var want []string
	for i := 1; i <= 20; i++ {
		msg := fmt.Sprintf("m%d", i)
		want = append(want, msg)
		r.broadcast([]byte(msg))
	}
	expectInOrder(t, fast, want, "wedge")

	close(release)
	r.stop()
}

// TestCallbackRegistry_AckNotStalledByWedgedPeer pins the ack path (sendTo):
// a request-scoped reply to a healthy client must be delivered even while a
// different client is wedged mid-broadcast. This is the exact shape of the
// pool's ping/clear-undo-stacks ack timeouts.
func TestCallbackRegistry_AckNotStalledByWedgedPeer(t *testing.T) {
	r := newCallbackRegistry()
	entered, release := wedgeClient(r, "slow")
	fast := make(chan string, 64)
	r.set("fast", func(b []byte) { fast <- string(b) })

	r.broadcast([]byte("wedge"))
	<-entered

	r.sendTo("fast", []byte("ack"))
	expectInOrder(t, fast, []string{"ack"}, "wedge")

	close(release)
	r.stop()
}

// TestCallbackRegistry_RegistryOpsNotStalledByWedgedClient pins that the
// actor itself stays responsive while a client is wedged: set/remove/get must
// complete, and a client registered during the wedge must receive subsequent
// broadcasts. Under the old inline-delivery actor, get() would block forever
// here (and once the cap-100 op channel filled, the worker run loop itself
// blocked in sendWS).
func TestCallbackRegistry_RegistryOpsNotStalledByWedgedClient(t *testing.T) {
	r := newCallbackRegistry()
	entered, release := wedgeClient(r, "slow")

	r.broadcast([]byte("wedge"))
	<-entered

	late := make(chan string, 64)
	r.set("late", func(b []byte) { late <- string(b) })
	gotCh := make(chan func([]byte), 1)
	go func() { gotCh <- r.get("late") }()
	select {
	case got := <-gotCh:
		if got == nil {
			t.Fatal("get() returned nil for a just-registered client")
		}
	case <-time.After(registryTestTimeout):
		t.Fatal("get() stalled behind a wedged client's callback")
	}
	r.broadcast([]byte("after"))
	expectInOrder(t, late, []string{"after"}, "wedge")

	r.remove("late")
	close(release)
	r.stop()
}

// TestCallbackRegistry_ReplacedCallbackKeepsQueuedDeliveries pins re-set
// semantics: replacing a live client's callback (manager re-registers on every
// inbound message) must neither drop messages already accepted for that client
// nor reorder them — earlier messages reach the old callback, later ones the
// new, in enqueue order.
func TestCallbackRegistry_ReplacedCallbackKeepsQueuedDeliveries(t *testing.T) {
	r := newCallbackRegistry()
	first := make(chan string, 64)
	release := make(chan struct{})
	delivering := make(chan struct{}, 1)
	r.set("c", func(b []byte) {
		select {
		case delivering <- struct{}{}:
		default:
		}
		<-release
		first <- string(b)
	})

	r.broadcast([]byte("m1"))
	<-delivering // m1 delivery is in progress on the first callback
	r.broadcast([]byte("m2"))
	r.broadcast([]byte("m3"))

	second := make(chan string, 64)
	r.set("c", func(b []byte) { second <- string(b) })
	r.broadcast([]byte("m4"))

	close(release)
	expectInOrder(t, first, []string{"m1", "m2", "m3"}, "")
	expectInOrder(t, second, []string{"m4"}, "")

	r.stop()
}
