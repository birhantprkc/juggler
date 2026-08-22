//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Turn-level retry for transient CLI failures: when the claude CLI process
// dies without emitting a terminal stop reason (crash / quota-kill / dropped
// connection), juggler re-attempts the turn a bounded number of times — but
// only when nothing has been streamed to the UI yet, so a retry can never
// duplicate already-shown content.

package claudecode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// fastRetryBackoff shrinks the retry backoff to keep tests quick, restoring
// the production value on cleanup.
func fastRetryBackoff(t *testing.T) {
	t.Helper()
	old := cliRetryBackoff
	cliRetryBackoff = time.Millisecond
	t.Cleanup(func() { cliRetryBackoff = old })
}

// TestRetry_TransientCLIExitRecovers: the first spawn dies after init with no
// terminal result; the bounded retry re-spawns and the second attempt
// completes the turn. The turn must succeed (no error surfaced to the worker)
// and the trace must show at least two spawns.
func TestRetry_TransientCLIExitRecovers(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeFlakeFirst, "uuid-flake")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-flake"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("expected retry to recover the transient exit, got error: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("StopReason = %q, want end_turn", res.StopReason)
	}

	trace := readTrace(t, tracePath)
	if len(trace) < 2 {
		t.Fatalf("expected ≥2 spawns (one failed + one retry), got %d", len(trace))
	}
	c.dropSession(convID)
}

// TestRetry_TransientCLIExitGivesUp: every spawn dies after init. The retry
// must exhaust its bounded budget and surface the transient error (so the UI
// shows it) rather than looping forever. The number of spawns is capped at
// cliMaxRetries+1.
func TestRetry_TransientCLIExitGivesUp(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeAlwaysExit, "uuid-dead")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-dead"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback())
	if err == nil {
		t.Fatalf("expected an error after the retry budget is exhausted, got nil (res=%+v)", res)
	}
	if !strings.Contains(err.Error(), "exited unexpectedly") {
		t.Fatalf("error = %q, want the unexpected-exit transient error", err)
	}
	if res == nil || res.StopReason != "error" {
		t.Fatalf("expected StopReason=error result, got %+v", res)
	}

	trace := readTrace(t, tracePath)
	if got, want := len(trace), cliMaxRetries+1; got != want {
		t.Fatalf("spawned %d times, want exactly %d (one initial + %d retries)", got, want, cliMaxRetries)
	}
	c.dropSession(convID)
}

// TestRetry_OverloadedUpstreamSurfacesWithoutColdStart is the counterpart to
// the wedged-session test below, and the two together draw the line the client
// has to hold. Both look identical from a distance — a --resume that produces
// no answer — but the causes are opposite:
//
//   - wedged session: the CLI is silent, so ABANDON the uuid and cold-start.
//   - overloaded upstream: the CLI is healthy and streaming retry notices, so
//     the session and its prompt cache are fine. Cold-starting would throw away
//     a warm 100k-token cache and re-send a LARGER request into the very
//     upstream that is already refusing traffic. Report it instead.
func TestRetry_OverloadedUpstreamSurfacesWithoutColdStart(t *testing.T) {
	fastRetryBackoff(t)
	prevIdle, prevLadder := streamIdleTimeout, retryLadderCap
	// A silence window long enough that only the ladder cap can end this turn:
	// the notices never stop arriving, so the idle watchdog never fires.
	streamIdleTimeout = 30 * time.Second
	retryLadderCap = 300 * time.Millisecond
	t.Cleanup(func() { streamIdleTimeout, retryLadderCap = prevIdle, prevLadder })

	tracePath := installFakeClaude(t, fakeModeLadderOnResume, "uuid-ladder-resume")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_ladder_resume"
	ctx := context.Background()

	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "ladder--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	// Turn 1: bare fresh start; captures uuid-ladder-resume and succeeds.
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1 should succeed, got: %v", err)
	}
	c.activeSession.tearDownLiveCLI()

	// Turn 2: the resume finds an overloaded upstream and retries forever.
	start := time.Now()
	_, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("turn 2 should surface the overload, not hang or silently succeed")
	}
	if !strings.Contains(err.Error(), "overloaded") {
		t.Errorf("error should name the overloaded upstream, got: %v", err)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("turn 2 took %v — the ladder cap did not bound the wait", elapsed)
	}

	// The breaker must NOT have been charged: nothing about this session is
	// wedged, and a later genuine stall deserves its full allowance.
	if c.consecutiveStalls != 0 {
		t.Errorf("consecutiveStalls = %d, want 0 — an overloaded upstream is not evidence of a wedged session", c.consecutiveStalls)
	}
	// Every spawn stayed on the warm uuid; no cache-torching cold start.
	for i, rec := range readTrace(t, tracePath) {
		if i > 0 && rec.ResumeID != "uuid-ladder-resume" {
			t.Errorf("spawn #%d resumed %q — an overload must not trigger a cold start", i, rec.ResumeID)
		}
	}
	c.dropSession(convID)
}

// TestRetry_WedgedResumeColdStartsInsteadOfLockingUp models the production
// lock-up: a CLI-side session whose --resume stalls forever (a backed-up stdin
// queue / corrupt transcript). Re-resuming the same wedged uuid every turn
// leaves the user staring at "receiving…" indefinitely. After a bounded number
// of consecutive stalls the client must ABANDON the wedged uuid and cold-start
// fresh (a synthetic --resume under a NEW uuid rebuilt from juggler's own
// history), so the turn recovers instead of locking up.
func TestRetry_WedgedResumeColdStartsInsteadOfLockingUp(t *testing.T) {
	fastRetryBackoff(t)
	prevIdle := streamIdleTimeout
	// The wedged --resume emits nothing, so it stalls deterministically at ANY
	// idle window; but the SAME window also bounds the healthy cold-start's
	// first-output latency. Keep it well above CI scheduling jitter (a 150ms
	// window flaked on loaded runners — the fresh session's first text turn
	// hadn't arrived yet) so the recovery path isn't throttled into a false stall.
	streamIdleTimeout = time.Second
	t.Cleanup(func() { streamIdleTimeout = prevIdle })

	tracePath := installFakeClaude(t, fakeModeWedgeOnResume, "uuid-wedge")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv_wedge"
	ctx := context.Background()

	// Build the per-conversation folder so ScanConvDirs indexes it and the
	// sidecar persists/reloads across every retry attempt — exactly as in
	// production. Without this the test sidecar can't be reloaded and turn 2
	// would cold-start for the wrong reason (a test artifact, not the breaker).
	if err := os.MkdirAll(filepath.Join(c.workingDir, ".juggler", "wedge--"+convID), 0o755); err != nil {
		t.Fatalf("mkdir conv folder: %v", err)
	}

	// Turn 1: bare fresh start; captures uuid-wedge and succeeds.
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1 should succeed, got: %v", err)
	}

	// Tear down the live CLI so the next turn must FRESH --resume uuid-wedge —
	// exactly the production wedge shape (idle CLI reaped; next turn cold-resumes
	// the saved uuid, which stalls).
	c.activeSession.tearDownLiveCLI()

	// Turn 2: every --resume uuid-wedge stalls. The breaker must escalate to a
	// cold start so the turn SUCCEEDS rather than surfacing a stall error.
	start := time.Now()
	res, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello"), assistantMsg("turn 1"), userMsg("again")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 2 should recover via cold-start, got error: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("turn 2 StopReason = %q, want end_turn", res.StopReason)
	}
	// Two wedge stalls (~1 idle window + teardown grace each) precede the cold
	// start, so the deterministic cost is a few seconds. The bound only needs to
	// be far below the production LLMTimeout backstop to prove the breaker
	// escalated rather than riding the coarse timeout.
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("turn 2 took %v — breaker did not escalate promptly", elapsed)
	}

	// The recovery spawn must have abandoned the wedged uuid: the final spawn is
	// a synthetic --resume under a fresh uuid (not uuid-wedge, not bare).
	trace := readTrace(t, tracePath)
	last := trace[len(trace)-1]
	if last.ResumeID == "uuid-wedge" {
		t.Fatalf("recovery spawn still resumed the wedged uuid %q", last.ResumeID)
	}
	if last.ResumeID == "" {
		t.Fatalf("recovery spawn cold-started without synthetic resume (lost history)")
	}
	c.dropSession(convID)
}

// TestRetry_NoRetryAfterStreamedContent: the CLI streams a complete text
// block (the callback fires) and THEN dies without end_turn. Replaying the
// turn would re-stream that text, so the retry must be suppressed: exactly one
// spawn, and the error is surfaced.
func TestRetry_NoRetryAfterStreamedContent(t *testing.T) {
	fastRetryBackoff(t)
	tracePath := installFakeClaude(t, fakeModeStreamThenExit, "uuid-partial")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-partial"

	var streamed strings.Builder
	cb := func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeText {
			streamed.WriteString(chunk.Content)
		}
		return nil, nil
	}

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("hello")},
	}, cb)
	if err == nil {
		t.Fatalf("expected the unexpected-exit error (no retry after streamed content), got nil (res=%+v)", res)
	}
	if streamed.String() != "half an answer" {
		t.Fatalf("streamed text = %q, want %q", streamed.String(), "half an answer")
	}

	trace := readTrace(t, tracePath)
	if len(trace) != 1 {
		t.Fatalf("spawned %d times, want exactly 1 (retry must not replay streamed content)", len(trace))
	}
	c.dropSession(convID)
}
