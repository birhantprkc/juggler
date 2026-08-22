//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// setCLIConcurrency swaps the process-wide turn throttle for one of capacity n
// for the duration of a test, restoring the original on cleanup. Safe because
// the claudecode package tests run sequentially (no t.Parallel).
func setCLIConcurrency(t *testing.T, n int) {
	t.Helper()
	old := cliTurnSlots
	cliTurnSlots = newTurnSemaphore(n)
	t.Cleanup(func() { cliTurnSlots = old })
}

func TestResolveCLIMaxConcurrency(t *testing.T) {
	cases := []struct {
		env  string
		want int
	}{
		{"", defaultCLIMaxConcurrency},
		{"  ", defaultCLIMaxConcurrency}, // unparseable → default
		{"0", defaultCLIMaxConcurrency},  // non-positive → default
		{"-3", defaultCLIMaxConcurrency},
		{"x", defaultCLIMaxConcurrency},
		{"1", 1},
		{"12", 12},
	}
	for _, tc := range cases {
		if got := resolveCLIMaxConcurrency(tc.env); got != tc.want {
			t.Errorf("resolveCLIMaxConcurrency(%q) = %d, want %d", tc.env, got, tc.want)
		}
	}
}

// TestTurnSemaphore_BoundsAndUnblocks: a sem of capacity 2 admits two holders,
// blocks the third, and admits it the moment a holder releases.
func TestTurnSemaphore_BoundsAndUnblocks(t *testing.T) {
	sem := newTurnSemaphore(2)
	ctx := context.Background()

	r1, err := sem.acquire(ctx)
	if err != nil {
		t.Fatalf("acquire 1: %v", err)
	}
	r2, err := sem.acquire(ctx)
	if err != nil {
		t.Fatalf("acquire 2: %v", err)
	}
	if sem.inFlight() != 2 {
		t.Fatalf("inFlight = %d, want 2", sem.inFlight())
	}

	// Third acquire must block while the sem is full.
	got := make(chan func(), 1)
	go func() {
		r, _ := sem.acquire(ctx)
		got <- r
	}()
	select {
	case <-got:
		t.Fatal("third acquire succeeded past capacity 2")
	case <-time.After(50 * time.Millisecond):
	}

	// Releasing a slot must unblock the waiter promptly.
	r1()
	select {
	case r3 := <-got:
		r3()
	case <-time.After(time.Second):
		t.Fatal("release did not unblock the queued acquire")
	}
	r2()

	// Idempotent release: a second call must not over-free a slot.
	r1()
	if sem.inFlight() != 0 {
		t.Fatalf("after releases inFlight = %d, want 0 (double-release over-freed)", sem.inFlight())
	}
}

// TestTurnSemaphore_CancelWhileQueuedDoesNotHang is the deadlock-safety escape
// hatch: a turn cancelled while queued for a slot returns ctx.Err() instead of
// hanging — so even a cap of 1 can never wedge a cancellable turn.
func TestTurnSemaphore_CancelWhileQueuedDoesNotHang(t *testing.T) {
	sem := newTurnSemaphore(1)
	hold, err := sem.acquire(context.Background())
	if err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := sem.acquire(ctx)
		errc <- err
	}()

	// Confirm it is genuinely blocked, then cancel.
	select {
	case <-errc:
		t.Fatal("acquire succeeded despite a full semaphore")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()

	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued acquire returned %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock the queued acquire — would hang")
	}
	hold()
}

// TestTurnSemaphore_PausedTurnHoldsNoSlot is the load-bearing end-to-end
// property: a turn that pauses at a tool_use boundary (the shape of a turn
// that spawned subthreads and is awaiting their results) must release its slot
// when streamMessage returns — otherwise a parent could hold a slot its
// children need and deadlock under a small cap. With a cap of 1 we run such a
// turn and assert the sole slot is free afterwards.
func TestTurnSemaphore_PausedTurnHoldsNoSlot(t *testing.T) {
	setCLIConcurrency(t, 1)
	installFakeClaude(t, fakeModeToolUse, "uuid-park")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-park"

	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("do a tool")},
	}, nopCallback())
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if res.StopReason != "tool_use" {
		t.Fatalf("StopReason = %q, want tool_use", res.StopReason)
	}

	// The CLI is still alive and parked inside the tool call, but the turn
	// returned — so its slot must be free for the next (sub)conversation.
	if got := cliTurnSlots.inFlight(); got != 0 {
		t.Fatalf("slot still held after the turn paused (inFlight=%d) — a parked parent would block its subthreads", got)
	}

	c.dropSession(convID) // tears down the parked CLI
}
