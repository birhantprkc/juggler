//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"testing"
	"time"
)

// A test server must never wait on the providers-ready gate.
//
// Nothing in a test run populates the provider cache — the suite mocks the
// list — so the only thing that opens the gate is RefreshProviders, and its
// only startup caller is StartBackgroundServices, which runs after the engine
// connects. A test server that never reaches it keeps the gate shut for its
// whole life, and then every conversation the browser suite creates spends
// ProvidersReadyTimeout inside its create request: the handler resolves the
// default model before it seeds the doc, and with no stored default (the
// harness gives each subprocess an empty JUGGLER_CONFIG_DIR) that lookup waits
// out the gate. Twelve seconds per conversation is most of a browser test's
// budget and several of them for a suite that creates one per case.
func TestTestModeNeverWaitsOnTheProvidersGate(t *testing.T) {
	s := &Server{
		providerRefresh: providerRefresh{providersReady: make(chan struct{})},
		shutdownChan:    make(chan struct{}),
	}
	s.testMode = true

	start := time.Now()
	s.awaitProvidersReady(context.Background())
	elapsed := time.Since(start)

	if elapsed > time.Second {
		t.Fatalf("awaitProvidersReady took %v on a test server, against a %v timeout — a test run opens this gate only if background services get to RefreshProviders, so a lookup that waits here waits the whole timeout, once per conversation created",
			elapsed.Round(time.Millisecond), ProvidersReadyTimeout)
	}
	if !s.providersReadyNow() {
		t.Fatal("the gate is still shut after a test-mode lookup: /api/providers keeps reporting ready:false, and the next lookup pays the timeout again")
	}
}
