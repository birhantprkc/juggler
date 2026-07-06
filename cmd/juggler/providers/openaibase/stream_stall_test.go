//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// blockingBody is a response body whose Read parks until the HTTP request's
// context is cancelled — simulating an upstream that accepted the request,
// returned 200, then went silent mid-stream (half-open connection / server
// stalled / machine slept). The openai SDK threads the streaming ctx into the
// request, so when the idle watchdog cancels that ctx, this Read unblocks.
type blockingBody struct{ ctx context.Context }

func (b blockingBody) Read(p []byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

func (b blockingBody) Close() error { return nil }

// stallingClient returns an openaibase client whose transport answers 200 with
// an event-stream body that never sends a byte and never closes on its own.
func stallingClient(t *testing.T) *Client {
	t.Helper()
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       blockingBody{ctx: r.Context()},
			Request:    r,
		}, nil
	})}
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-4o", // non-codex → Chat Completions path
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// TestStreamStall_SurfacesTransientError proves the provider-boundary liveness
// guarantee end to end: a silent stream is aborted by the idle watchdog and
// surfaced as a transient "stream stalled" error (which the worker's
// isTransientMsg classifier retries) rather than parking forever on the socket
// read.
func TestStreamStall_SurfacesTransientError(t *testing.T) {
	orig := utils.StreamIdleTimeout
	utils.StreamIdleTimeout = 50 * time.Millisecond
	t.Cleanup(func() { utils.StreamIdleTimeout = orig })

	c := stallingClient(t)

	done := make(chan error, 1)
	go func() {
		_, err := c.streamMessage(context.Background(), provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "hello"}},
		}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a stall error, got nil")
		}
		msg := strings.ToLower(err.Error())
		if !strings.Contains(msg, "stall") && !strings.Contains(msg, "connection may have dropped") {
			t.Fatalf("error %q is not classifiable as a transient stall", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("streamMessage parked on the silent stream — the idle watchdog did not abort it")
	}
}

// TestStreamStall_CallerCancelNotMisclassified guards the other side: when the
// CALLER cancels (user interrupt, system wake), the watchdog has not fired, so
// the error must NOT be dressed up as a transient stall — surfacing it as
// transient would make the worker auto-retry a deliberately-cancelled turn.
func TestStreamStall_CallerCancelNotMisclassified(t *testing.T) {
	orig := utils.StreamIdleTimeout
	utils.StreamIdleTimeout = 10 * time.Second // long — the caller cancel wins the race
	t.Cleanup(func() { utils.StreamIdleTimeout = orig })

	c := stallingClient(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.streamMessage(ctx, provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "hello"}},
		}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
		done <- err
	}()

	// Cancel as the caller would (interrupt / wake). Whether this lands before
	// NewStreaming (caught by the ctx.Err() guard) or after (unblocks the body
	// read with context.Canceled), the watchdog never fires — so neither path
	// may produce a "stall" error.
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a cancellation error, got nil")
		}
		if strings.Contains(strings.ToLower(err.Error()), "stall") {
			t.Fatalf("caller cancel was misclassified as a stall: %q", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("streamMessage did not return after caller cancel")
	}
}
