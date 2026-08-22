//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestStreamSessionStallErrorClassifiesSilence proves the stall half of the
// classification: the watchdog fires while the caller's context is still alive,
// so StallError names this provider and carries both marker substrings the
// worker's transient classifier matches on.
func TestStreamSessionStallErrorClassifiesSilence(t *testing.T) {
	orig := StreamIdleTimeout
	StreamIdleTimeout = 20 * time.Millisecond
	t.Cleanup(func() { StreamIdleTimeout = orig })

	sess, streamCtx := NewStreamSession(context.Background(), "zai", nil)
	defer sess.Close()

	<-streamCtx.Done() // the watchdog cancels it after the idle window

	stall := sess.StallError()
	if stall == nil {
		t.Fatal("expected a stall error after the idle window elapsed")
	}
	for _, want := range []string{"zai", StallMarker, StallDroppedMarker} {
		if !strings.Contains(stall.Error(), want) {
			t.Errorf("stall error %q is missing %q", stall, want)
		}
	}
}

// TestStreamSessionStallErrorIgnoresCallerCancel guards the other side: when the
// CALLER cancels, the watchdog never fired, so there is no stall to report.
// Dressing a deliberate interrupt up as transient would make the worker
// auto-retry the turn the user just stopped.
func TestStreamSessionStallErrorIgnoresCallerCancel(t *testing.T) {
	orig := StreamIdleTimeout
	StreamIdleTimeout = 10 * time.Second // long — the caller cancel wins
	t.Cleanup(func() { StreamIdleTimeout = orig })

	ctx, cancel := context.WithCancel(context.Background())
	sess, streamCtx := NewStreamSession(ctx, "gemini", nil)
	defer sess.Close()

	cancel()
	<-streamCtx.Done()

	if stall := sess.StallError(); stall != nil {
		t.Fatalf("caller cancel was misclassified as a stall: %v", stall)
	}
}

// TestStreamSessionResetHoldsOffTheWatchdog proves Reset really re-arms the
// idle window: a stream that keeps producing events past the timeout is not a
// stall, however long it runs in total.
func TestStreamSessionResetHoldsOffTheWatchdog(t *testing.T) {
	orig := StreamIdleTimeout
	StreamIdleTimeout = 60 * time.Millisecond
	t.Cleanup(func() { StreamIdleTimeout = orig })

	sess, streamCtx := NewStreamSession(context.Background(), "anthropic", nil)
	defer sess.Close()

	for range 8 {
		time.Sleep(15 * time.Millisecond)
		sess.Reset()
	}

	select {
	case <-streamCtx.Done():
		t.Fatal("watchdog fired despite steady Resets")
	default:
	}
	if stall := sess.StallError(); stall != nil {
		t.Fatalf("a progressing stream reported a stall: %v", stall)
	}
}

// TestStreamSessionProgressFeedsTheEmitter checks the session's third job: the
// callback sees throttled progress chunks. Also covers the nil-callback path,
// which every provider hits when a caller streams without a callback.
func TestStreamSessionProgressFeedsTheEmitter(t *testing.T) {
	var chunks []provider.StreamChunk
	sess, _ := NewStreamSession(context.Background(), "openai", func(c provider.StreamChunk) (*provider.ToolResult, error) {
		chunks = append(chunks, c)
		return nil, nil
	})
	defer sess.Close()

	sess.Progress(strings.Repeat("x", 400))
	if len(chunks) != 1 {
		t.Fatalf("expected one progress chunk, got %d", len(chunks))
	}
	if chunks[0].Type != provider.ContentBlockTypeProgress {
		t.Errorf("chunk type = %q, want %q", chunks[0].Type, provider.ContentBlockTypeProgress)
	}
	if got := chunks[0].Metadata["outputTokens"]; got != 100 {
		t.Errorf("outputTokens = %v, want 100", got)
	}

	quiet, _ := NewStreamSession(context.Background(), "openai", nil)
	defer quiet.Close()
	quiet.Progress("no callback, no panic")
}

// TestStreamSessionCloseIsIdempotent covers the deferred-Close contract: a
// provider that closes early and then unwinds through its defer must not panic
// or leave the watchdog goroutine running.
func TestStreamSessionCloseIsIdempotent(t *testing.T) {
	sess, streamCtx := NewStreamSession(context.Background(), "openai", nil)
	sess.Close()
	sess.Close()
	if streamCtx.Err() == nil {
		t.Fatal("Close did not cancel the derived context")
	}
}
