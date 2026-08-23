//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
)

// TestEngineReadyGate_NilAllowsTurn: with no gate installed (tests/test-pool,
// where the engine is an always-on iframe), readiness is implicitly true.
func TestEngineReadyGate_NilAllowsTurn(t *testing.T) {
	s := newTestServerState(t)
	if !s.ensureEngineReady() {
		t.Fatal("no gate installed: expected ensureEngineReady=true")
	}
}

// TestEngineReadyGate_SetControlsReadiness: an installed gate governs readiness,
// and clearing it (nil) restores the always-ready default.
func TestEngineReadyGate_SetControlsReadiness(t *testing.T) {
	s := newTestServerState(t)

	s.SetEngineReadyGate(func() bool { return false })
	if s.ensureEngineReady() {
		t.Fatal("failing gate: expected ensureEngineReady=false")
	}

	s.SetEngineReadyGate(func() bool { return true })
	if !s.ensureEngineReady() {
		t.Fatal("passing gate: expected ensureEngineReady=true")
	}

	s.SetEngineReadyGate(nil)
	if !s.ensureEngineReady() {
		t.Fatal("cleared gate: expected ensureEngineReady=true")
	}
}

// TestLLMCaller_FailsFastWhenEngineDown: the turn dispatch must call the gate
// first and, when the engine cannot be brought up, fail with a clear
// engine-not-available error instead of proceeding to drop tool requests.
func TestLLMCaller_FailsFastWhenEngineDown(t *testing.T) {
	s := newTestServerState(t)

	var called atomic.Int32
	s.SetEngineReadyGate(func() bool { called.Add(1); return false })

	caller := s.createLLMCaller()
	_, err := caller(context.Background(), json.RawMessage(`{}`), nil)

	if called.Load() != 1 {
		t.Fatalf("expected gate called exactly once, got %d", called.Load())
	}
	if err == nil || !strings.Contains(err.Error(), "engine is not available") {
		t.Fatalf("expected engine-not-available error, got %v", err)
	}
}

// TestLLMCaller_ProceedsPastReadyGate: when the gate reports ready, the turn
// proceeds past it (any later failure is NOT the engine-not-available error).
func TestLLMCaller_ProceedsPastReadyGate(t *testing.T) {
	s := newTestServerState(t)
	// The providers-ready gate sits downstream of the engine gate under test,
	// and newTestServerState leaves it a nil channel — which awaitProvidersReady
	// can only escape by timing out. Open it so the call falls through to the
	// credential lookup that ends it.
	s.providersReady = make(chan struct{})
	s.shutdownChan = make(chan struct{})
	s.markProvidersReady()

	var called atomic.Int32
	s.SetEngineReadyGate(func() bool { called.Add(1); return true })

	caller := s.createLLMCaller()
	_, err := caller(context.Background(), json.RawMessage(`{}`), nil)

	if called.Load() != 1 {
		t.Fatalf("expected gate called exactly once, got %d", called.Load())
	}
	// It got past the gate, so whatever error surfaces (e.g. missing
	// credentials) must NOT be the engine-readiness failure.
	if err != nil && strings.Contains(err.Error(), "engine is not available") {
		t.Fatalf("turn should have proceeded past the ready gate, got %v", err)
	}
}
