//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestStreamStallsOnSilentCLI models a subprocess whose upstream connection
// was dropped (e.g. across a system sleep): the CLI emits its init line and
// then goes silent forever without ever producing a terminal stop reason.
// Without an idle timeout the read loop blocks until the worker's coarse
// LLMTimeout backstop; with it, the stream fails fast with a clear stall
// error so the turn can be surfaced and retried.
func TestStreamStallsOnSilentCLI(t *testing.T) {
	installFakeClaude(t, fakeModeNoResult, "uuid-stall")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-stall"

	// Shrink the idle window so the test runs fast; restore after.
	prev := streamIdleTimeout
	streamIdleTimeout = 200 * time.Millisecond
	defer func() { streamIdleTimeout = prev }()

	start := time.Now()
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       []provider.Message{userMsg("hello")},
	}, nopCallback())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a stall error from a silent CLI, got nil")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "stall") {
		t.Errorf("expected a stall error, got: %v", err)
	}
	// Idle timeout (200ms) + teardownGracePeriod (500ms) + slack. Anything
	// near the LLMTimeout backstop means the idle timer never fired.
	if elapsed > 5*time.Second {
		t.Fatalf("stall detection took %v — idle timeout was not enforced", elapsed)
	}

	c.dropSession(convID)
}

// TestStreamFailsOnEndlessRetryNotices models a CLI wedged in a permanent
// in-band backoff ladder: the upstream keeps answering 529, so the CLI emits
// system/api_retry notices forever and never produces content or a terminal
// stop reason.
//
// Those notices are liveness, not progress. Each one re-arms the silence
// watchdog, so that watchdog alone can never end this turn — a separate cap on
// how long a turn may spend retrying must, or the turn parks until the worker's
// 30-minute LLMTimeout backstop while the UI still claims to be receiving.
func TestStreamFailsOnEndlessRetryNotices(t *testing.T) {
	installFakeClaude(t, fakeModeRetryLadder, "uuid-ladder")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-ladder"

	// A silence window far longer than the notice interval, so this test can
	// only pass via the retry-ladder cap — never by the CLI falling silent.
	prevIdle, prevLadder, prevBackoff := streamIdleTimeout, retryLadderCap, cliRetryBackoff
	streamIdleTimeout = 30 * time.Second
	retryLadderCap = 300 * time.Millisecond
	cliRetryBackoff = 10 * time.Millisecond
	defer func() {
		streamIdleTimeout, retryLadderCap, cliRetryBackoff = prevIdle, prevLadder, prevBackoff
	}()

	// A hard ceiling so a regression fails the test instead of hanging it.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	start := time.Now()
	_, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID,
		SystemPrompt:   "sys",
		Messages:       []provider.Message{userMsg("hello")},
	}, nopCallback())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a stall error from a CLI stuck retrying, got nil")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("turn made no progress for %v and was never failed — the retry ladder is unbounded; only the test's own ctx deadline ended it", elapsed)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "stall") {
		t.Errorf("expected a stall error, got: %v", err)
	}
	// Ladder cap (300ms) per attempt, across 1+cliMaxRetries attempts, plus
	// teardown grace. Anything near the ctx ceiling means the cap never fired.
	if elapsed > 10*time.Second {
		t.Fatalf("stall detection took %v — the retry-ladder cap was not enforced", elapsed)
	}

	c.dropSession(convID)
}
