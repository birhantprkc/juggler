//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
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
