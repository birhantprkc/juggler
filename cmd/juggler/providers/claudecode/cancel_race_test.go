//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"os"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// waitForFakeCLIUp blocks until the fake CLI has emitted its first line to the
// trace file — a deterministic signal that the subprocess spawned and the turn
// is now in flight with a live activeSession. Polls a real condition (no fixed
// sleep); fails the test if the CLI never comes up.
func waitForFakeCLIUp(t *testing.T, tracePath string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if fi, err := os.Stat(tracePath); err == nil && fi.Size() > 0 {
			return
		}
		time.Sleep(time.Millisecond) // tight poll of a real condition, not a timing bodge
	}
	t.Fatal("fake CLI never emitted its first trace line — turn did not get in flight")
}

// TestCancel_RacesInFlightTurn reproduces the production SIGSEGV: while a turn
// is streaming (the worker's callLLM goroutine inside streamMessage), the
// conversationCache actor goroutine runs conv.Cancel for the same conversation
// — exactly what happens when the user cancels / a new message arrives mid-turn
// (message_handlers.go cancels the turn ctx AND calls cancelLLMSession). Both
// goroutines touch c.activeSession with no synchronization, so the captured
// crash was a nil-deref on activeSession.pendingTools; under -race it is a clean
// data-race report. Must be race-free and crash-free after the single-owner fix.
//
// Run with: go test -race -run TestCancel_RacesInFlightTurn ./cmd/juggler/providers/claudecode
func TestCancel_RacesInFlightTurn(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeNoResult, "uuid-cancel-race")
	c := mkClient(t, "claude-sonnet-4-6") // root-thread session
	convID := "conv-cancel-race"

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		// fakeModeNoResult blocks after init, so this turn stays in
		// flight (live activeSession) until interrupted.
		_, _ = c.streamMessage(ctx, provider.MessageRequest{
			ConversationID: convID, SystemPrompt: "sys",
			Messages: []provider.Message{userMsg("hello")},
		}, nopCallback())
	}()

	waitForFakeCLIUp(t, tracePath)

	// The exact production pair, concurrently: the worker cancels the
	// turn's context AND the conversation actor cancels the session.
	go cancel()
	c.cancelSession()

	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("streamMessage did not return after concurrent cancel — wedged")
	}
}
