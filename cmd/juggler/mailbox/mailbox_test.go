//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mailbox

import (
	"fmt"
	"testing"
	"time"
)

const testTimeout = 10 * time.Second

// TestMailbox_OrderAndNonBlocking pins the package contract: Enqueue never
// blocks on the consumer, and the consumer sees values in exact enqueue order
// even while wedged mid-delivery.
func TestMailbox_OrderAndNonBlocking(t *testing.T) {
	got := make(chan string, 64)
	release := make(chan struct{})
	first := true
	m := NewMailbox(func(v string) {
		if first {
			first = false
			<-release // wedge the consumer on its first delivery
		}
		got <- v
	})

	var want []string
	for i := 0; i < 20; i++ {
		v := fmt.Sprintf("m%d", i)
		want = append(want, v)
		done := make(chan struct{})
		go func() { m.Enqueue(v); close(done) }()
		select {
		case <-done:
		case <-time.After(testTimeout):
			t.Fatalf("Enqueue(%q) blocked on a wedged consumer", v)
		}
	}

	close(release)
	deadline := time.After(testTimeout)
	for _, expected := range want {
		select {
		case v := <-got:
			if v != expected {
				t.Fatalf("out of order: got %q, want %q", v, expected)
			}
		case <-deadline:
			t.Fatalf("starved waiting for %q", expected)
		}
	}
	m.Stop()
}

// TestMailbox_StopDiscardsAndReleases pins Stop semantics: undelivered values
// are discarded, Enqueue after Stop is a harmless no-op, and the goroutines
// exit (verified indirectly — a post-stop Enqueue returns immediately even
// though no pump is receiving).
func TestMailbox_StopDiscardsAndReleases(t *testing.T) {
	delivered := make(chan int, 64)
	m := NewMailbox(func(v int) { delivered <- v })
	m.Stop()

	done := make(chan struct{})
	go func() { m.Enqueue(1); close(done) }()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("Enqueue blocked after Stop")
	}
	select {
	case v := <-delivered:
		t.Fatalf("value %d delivered after Stop", v)
	case <-time.After(50 * time.Millisecond):
		// Nothing delivered — expected. The short window is a best-effort
		// negative check, not a synchronization point.
	}
}

// TestMailbox_StopIsIdempotent pins that Stop is safe to call repeatedly,
// including concurrently. Mailboxes are stopped from actor teardown paths
// that can overlap (a per-client remove racing a whole-registry stop); a
// double-close panic there would take down the entire process.
func TestMailbox_StopIsIdempotent(t *testing.T) {
	m := NewMailbox(func(int) {})
	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			m.Stop()
			done <- struct{}{}
		}()
	}
	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-time.After(testTimeout):
			t.Fatal("Stop blocked")
		}
	}
	m.Stop() // and again, sequentially
}

// TestQueue_NeverDrops pins the Queue contract directly: every pushed value
// comes out, in order, regardless of consumer pacing.
func TestQueue_NeverDrops(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	q := NewQueue[int](done)

	const n = 10000
	go func() {
		for i := 0; i < n; i++ {
			q.Push(i)
		}
	}()

	deadline := time.After(testTimeout)
	for i := 0; i < n; i++ {
		select {
		case v := <-q.Out():
			if v != i {
				t.Fatalf("out of order: got %d, want %d", v, i)
			}
		case <-deadline:
			t.Fatalf("starved waiting for %d", i)
		}
	}
}
