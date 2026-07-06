//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"
	"time"
)

// newReadyTestServer builds the minimal Server skeleton the providers-ready
// gate needs, with the gate left OPEN (no refresh completed yet).
func newReadyTestServer() *Server {
	return &Server{
		providersReady: make(chan struct{}),
		shutdownChan:   make(chan struct{}),
	}
}

// TestAwaitProvidersReadyBlocksUntilSignalled is the core regression: a
// default-model lookup that arrives before the first provider refresh must wait
// for it rather than read the still-empty cache. We assert the call does NOT
// return while the gate is open, then returns once it is marked ready.
func TestAwaitProvidersReadyBlocksUntilSignalled(t *testing.T) {
	s := newReadyTestServer()

	done := make(chan struct{})
	go func() {
		s.awaitProvidersReady(context.Background())
		close(done)
	}()

	// Gate still open: the wait must not have completed.
	select {
	case <-done:
		t.Fatal("awaitProvidersReady returned before providers were ready")
	case <-time.After(50 * time.Millisecond):
	}

	s.markProvidersReady()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("awaitProvidersReady did not return after markProvidersReady")
	}
}

// TestAwaitProvidersReadyReturnsWhenAlreadyReady covers the steady state: once
// the first refresh has completed the gate never blocks again.
func TestAwaitProvidersReadyReturnsWhenAlreadyReady(t *testing.T) {
	s := newReadyTestServer()
	s.markProvidersReady()

	done := make(chan struct{})
	go func() {
		s.awaitProvidersReady(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("awaitProvidersReady blocked even though providers were ready")
	}
}

// TestAwaitProvidersReadyHonoursContext ensures a cancelled request context
// unblocks the wait so a disconnected client never pins the goroutine.
func TestAwaitProvidersReadyHonoursContext(t *testing.T) {
	s := newReadyTestServer()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		s.awaitProvidersReady(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("awaitProvidersReady ignored a cancelled context")
	}
}

// TestMarkProvidersReadyIdempotent verifies repeated completions (startup plus
// every later credential-change refresh) never double-close the gate.
func TestMarkProvidersReadyIdempotent(t *testing.T) {
	s := newReadyTestServer()
	s.markProvidersReady()
	s.markProvidersReady() // must not panic on a second close
}
