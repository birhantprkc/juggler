//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"fmt"
	"runtime"
	"testing"
	"time"
)

// testWedgedClient builds a client that accepts nothing: its send channel is
// unbuffered and nobody reads it, so a Send blocks until the client is closed.
// This is the peer that has stopped draining, in miniature.
func testWedgedClient(id string) *WSClient {
	return &WSClient{
		ID:     id,
		Role:   ClientRoleViewer,
		info:   ClientInfo{Origin: "remote"},
		send:   make(chan wsMessage),
		closed: make(chan struct{}),
	}
}

// hubProbe is a broadcast payload carrying a sequence number, so a test can say
// which message it is waiting for.
func hubProbe(n int) map[string]any { return map[string]any{"type": "probe", "n": n} }

// awaitProbe reads from c until probe n arrives, failing if it takes longer than
// deadline. Other traffic (clients-changed, say) is skipped.
func awaitProbe(t *testing.T, c *WSClient, n int, deadline time.Duration) {
	t.Helper()
	limit := time.After(deadline)
	for {
		select {
		case msg := <-c.send:
			if m, ok := msg.json.(map[string]any); ok && m["type"] == "probe" && m["n"] == n {
				return
			}
		case <-limit:
			t.Fatalf("probe %d did not reach the healthy client within %v", n, deadline)
		}
	}
}

// TestClientHub_WedgedClientDoesNotDelayBroadcast pins the property the hub's
// per-client mailboxes exist for: a client that has stopped draining holds up
// nothing but its own deliveries. Several probes are broadcast in a row because
// a hub sending inline would still get one message past the healthy client if
// the map iteration reached it first — it cannot get past the second, since the
// actor is by then stuck inside the wedged client's Send.
func TestClientHub_WedgedClientDoesNotDelayBroadcast(t *testing.T) {
	h := newClientHub()

	wedged := testWedgedClient("wedged")
	healthy := testRoleClient("healthy", ClientRoleViewer, "local")
	h.register(wedged)
	h.register(healthy)

	// Closing the wedged client first releases its delivery goroutine, so the
	// shutdown notice below is not sent into a channel nobody reads.
	t.Cleanup(func() {
		wedged.Close()
		h.shutdown()
	})

	const probes = 5
	for i := 0; i < probes; i++ {
		h.broadcast(hubProbe(i))
	}
	for i := 0; i < probes; i++ {
		awaitProbe(t, healthy, i, 2*time.Second)
	}

	// The wedged client is still on its very first delivery — the clients-changed
	// from its own registration, long before any probe — which is what makes the
	// result above the mailboxes working rather than a lucky iteration order.
	select {
	case msg := <-wedged.send:
		m, ok := msg.json.(map[string]any)
		if !ok || m["type"] != "clients-changed" {
			t.Fatalf("wedged client was past its first message: %#v", msg.json)
		}
	case <-time.After(time.Second):
		t.Fatal("nothing was ever offered to the wedged client")
	}
}

// TestClientHub_PreservesPerClientOrder pins FIFO delivery to a single client:
// broadcasts must arrive in the order the hub produced them, or a later snapshot
// can be overtaken by an earlier one.
func TestClientHub_PreservesPerClientOrder(t *testing.T) {
	h := newClientHub()
	c := testRoleClient("ordered", ClientRoleViewer, "local")
	h.register(c)
	t.Cleanup(h.shutdown)

	const probes = 100
	for i := 0; i < probes; i++ {
		h.broadcast(hubProbe(i))
	}
	for i := 0; i < probes; i++ {
		awaitProbe(t, c, i, 2*time.Second)
	}
}

// waitForGoroutines polls until the live goroutine count drops to want or the
// budget runs out, returning what it last saw. Polling rather than sleeping
// once: goroutine exit is asynchronous, and the count is only meaningful after
// it has settled.
func waitForGoroutines(want int, within time.Duration) int {
	deadline := time.Now().Add(within)
	for {
		got := runtime.NumGoroutine()
		if got <= want || time.Now().After(deadline) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestClientHub_UnregisterLeavesNoGoroutines pins that a departing client takes
// its delivery pipeline with it. A mailbox costs two goroutines, so a hub that
// forgot to stop them would leak a pair per connection — and viewers connect and
// disconnect for the life of the process.
func TestClientHub_UnregisterLeavesNoGoroutines(t *testing.T) {
	h := newClientHub()
	t.Cleanup(h.shutdown)

	// One registration first, so the hub's own goroutine and any lazily started
	// runtime machinery are already up, and the count has somewhere settled to
	// return to before the run that is actually measured.
	before := runtime.NumGoroutine()
	warmup := testRoleClient("warmup", ClientRoleViewer, "local")
	h.register(warmup)
	h.unregister(warmup)
	h.viewerCount() // synchronizes with the actor: the unregister above is done
	baseline := waitForGoroutines(before, time.Second)

	const clients = 20
	for i := 0; i < clients; i++ {
		c := testRoleClient(fmt.Sprintf("c%d", i), ClientRoleViewer, "local")
		h.register(c)
		h.unregister(c)
	}
	h.viewerCount()

	if got := waitForGoroutines(baseline, 2*time.Second); got > baseline {
		t.Fatalf("goroutines after %d register/unregister cycles = %d, want no more than %d",
			clients, got, baseline)
	}
}

// TestClientHub_UnregisterRacesBroadcast pins that a client leaving while a
// broadcast is in flight is safe — the shape that happens whenever a viewer
// closes its laptop mid-turn. Worth running under -race.
func TestClientHub_UnregisterRacesBroadcast(t *testing.T) {
	h := newClientHub()
	t.Cleanup(h.shutdown)

	const clients = 8
	leaving := make([]*WSClient, clients)
	for i := range leaving {
		leaving[i] = testRoleClient(fmt.Sprintf("r%d", i), ClientRoleViewer, "local")
		h.register(leaving[i])
	}

	done := make(chan struct{}, clients+1)
	go func() {
		for i := 0; i < 200; i++ {
			h.broadcast(hubProbe(i))
		}
		done <- struct{}{}
	}()
	for _, c := range leaving {
		go func() {
			h.unregister(c)
			done <- struct{}{}
		}()
	}

	for i := 0; i < clients+1; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("hub stalled with an unregister racing a broadcast")
		}
	}
	if got := h.viewerCount(); got != 0 {
		t.Fatalf("viewerCount() = %d after every viewer left, want 0", got)
	}
}

// TestClientHub_ShutdownNoticeReachesClients pins the one delivery the hub makes
// inline: the shutdown notice must be queued on the client before the close, or
// the client goes down without hearing why.
func TestClientHub_ShutdownNoticeReachesClients(t *testing.T) {
	h := newClientHub()
	c := testRoleClient("bye", ClientRoleViewer, "local")
	h.register(c)
	h.shutdown()

	select {
	case <-c.closed:
	default:
		t.Fatal("client was not closed by shutdown")
	}

	var sawNotice bool
	for {
		select {
		case msg := <-c.send:
			if m, ok := msg.json.(map[string]any); ok && m["type"] == "server_shutdown" {
				sawNotice = true
			}
			continue
		default:
		}
		break
	}
	if !sawNotice {
		t.Fatal("shutdown closed the client without queueing the server_shutdown notice")
	}
}
