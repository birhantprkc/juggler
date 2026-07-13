//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// StreamIdleTimeout bounds how long a streaming provider will wait for the next
// stream event before declaring the upstream connection dead and aborting the
// turn. It is the provider-boundary liveness guarantee: the SDK stream iterators
// (anthropic Messages, openai Responses/ChatCompletions, gemini
// GenerateContentStream) block on a socket read with no deadline of their own,
// so without this a half-open connection — server stalls mid-response, the
// machine sleeps and the TCP connection silently dies — would park the turn
// forever with no error and no recovery.
//
// It is an IDLE window, not an absolute deadline: every received event resets
// it, so a slow-but-progressing turn (a long cold start, extended reasoning)
// never trips it. The window must therefore exceed worst-case time-to-first-
// token on a large prompt; the providers' own keepalive/ping events reset it
// well before then in practice. A package var so tests can shrink it. Mirrors
// claudecode's own streamIdleTimeout, which already guards the CLI transport.
var StreamIdleTimeout = 180 * time.Second

// IdleWatchdog cancels a context when a streaming provider reports no progress
// within an idle window. The caller arms it around an SDK stream loop, calls
// Reset() on each received event, and Stop()s it when the loop exits. If the
// gap between resets (or from arming to the first event) exceeds the timeout,
// the watchdog cancels the stream's context — unblocking the SDK's pending
// socket read — and Fired() reports true so the caller can classify the
// resulting stream error as a transient stall rather than a caller cancel.
//
// Goroutine + channel, no mutex (per the project concurrency rule): one
// background goroutine owns the timer; Reset/Stop merely signal it. Reset and
// Stop are safe to call after the watchdog has already fired.
type IdleWatchdog struct {
	resetCh  chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once
	fired    atomic.Bool
}

// NewIdleWatchdog arms a watchdog that calls cancel after timeout elapses with
// no Reset. The returned watchdog's goroutine runs until Stop() is called or it
// fires, whichever comes first.
func NewIdleWatchdog(timeout time.Duration, cancel context.CancelFunc) *IdleWatchdog {
	w := &IdleWatchdog{
		resetCh: make(chan struct{}, 1),
		stopCh:  make(chan struct{}),
	}
	go w.run(timeout, cancel)
	return w
}

func (w *IdleWatchdog) run(timeout time.Duration, cancel context.CancelFunc) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-w.resetCh:
			// Drain a possibly-expired timer before re-arming. Only this
			// goroutine reads timer.C, so if Stop() reports the timer already
			// fired, the value is guaranteed still buffered.
			if !timer.Stop() {
				<-timer.C
			}
			timer.Reset(timeout)
		case <-timer.C:
			w.fired.Store(true)
			cancel()
			return
		case <-w.stopCh:
			return
		}
	}
}

// Reset restarts the idle window. Call it on each received stream event.
// Non-blocking: a pending reset signal is as good as another, so a full buffer
// is simply dropped.
func (w *IdleWatchdog) Reset() {
	select {
	case w.resetCh <- struct{}{}:
	default:
	}
}

// Stop tears down the watchdog goroutine (no-op if it already fired). Idempotent.
func (w *IdleWatchdog) Stop() {
	w.stopOnce.Do(func() { close(w.stopCh) })
}

// Fired reports whether the idle window elapsed and the context was cancelled —
// i.e. the stream stalled rather than the caller cancelling it.
func (w *IdleWatchdog) Fired() bool {
	return w.fired.Load()
}

// StallMarker and StallDroppedMarker are the two substrings every provider's
// idle-stall error carries. They form the contract the worker's transient-error
// classifier (isTransientMsg) matches on, so the message text is built here in
// one place rather than hand-written per provider.
const (
	StallMarker        = "stream stalled"
	StallDroppedMarker = "connection may have dropped"
)

// StallError builds the canonical idle-stall error a streaming provider returns
// when its IdleWatchdog fires. providerName is the lowercase provider label
// ("anthropic", "openai", "gemini") and idle is the elapsed idle window.
func StallError(providerName string, idle time.Duration) error {
	return fmt.Errorf("%s %s: no data for %s — %s", providerName, StallMarker, idle, StallDroppedMarker)
}
