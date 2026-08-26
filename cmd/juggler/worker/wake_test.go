//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestSystemWakeInterruptsInFlightLLM verifies the recovery path for a
// request orphaned by a system sleep: when the OS reports the system woke,
// an in-flight LLM call is cancelled immediately (rather than waiting out
// the LLMTimeout backstop) and the turn fails with a clear, retryable
// message. Models the real failure: the provider's connection is dropped
// across sleep, so the call would otherwise block forever on a read.
func TestSystemWakeInterruptsInFlightLLM(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	providerStarted := make(chan struct{})
	// A provider whose connection died across sleep: it blocks until the
	// per-turn ctx is cancelled, then returns ctx.Err() — exactly what the
	// claudecode read loop does on ctx.Done().
	w.llmCallFunc = func(ctx context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		close(providerStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	}

	go func() {
		<-providerStarted
		w.currentRun().interruptInFlightLLMForWake()
	}()

	start := time.Now()
	_, err := w.currentRun().callLLM(nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected callLLM to return an error after a system-wake interrupt, got nil")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("callLLM took %v — wake interrupt did not unblock it (it rode the LLMTimeout)", elapsed)
	}
	low := strings.ToLower(err.Error())
	if !strings.Contains(low, "sleep") && !strings.Contains(low, "wake") {
		t.Errorf("expected a sleep/wake interruption message, got: %v", err)
	}
}

// TestManagerSystemDidWakeFansOut verifies the Manager forwards a system-wake
// notification to every worker it owns, cancelling each worker's in-flight
// LLM context. Asserts the manager→worker plumbing independent of provider
// details by installing a sentinel cancel func.
func TestManagerSystemDidWakeFansOut(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	w := manager.GetOrCreate("conv-wake", "user:test")

	cancelled := make(chan struct{})
	var cf context.CancelFunc = func() { close(cancelled) }
	w.turn.cancelLLM.Store(&cf)

	manager.SystemDidWake()

	select {
	case <-cancelled:
		// Manager reached the worker and invoked its in-flight cancel.
	case <-time.After(2 * time.Second):
		t.Fatal("Manager.SystemDidWake did not cancel the worker's in-flight LLM context")
	}
}
