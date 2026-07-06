//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// TestMockRateLimitTriggersRetry asserts that a RateLimit MockResponse causes
// the worker's callLLMWithRetry loop to retry after the announced wait, and
// the subsequent success response is delivered as the assistant message.
func TestMockRateLimitTriggersRetry(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	seq := ts.SetMockSequence(
		helpers.RateLimit(50*time.Millisecond, "429 rate limited"),
		helpers.PlainResponse(helpers.TextResponse("After retry")),
	)

	triggerSendMessage(ts, "Hi")

	err := helpers.WaitForDocumentCondition(t, ts.Worker, 5*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "assistant" && item.Content == "After retry" {
				return true
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Assistant response after retry did not appear: %v", err)
	}

	if seq.CallCount() != 2 {
		t.Fatalf("Expected 2 LLM calls (rate-limit + retry), got %d", seq.CallCount())
	}
}

// TestMockTransientErrorTriggersRetry asserts that a transient transport
// failure (e.g. the claude CLI stream stalling because the upstream connection
// dropped) is retried by callLLMWithRetry rather than surfaced as a hard error,
// and the subsequent success response is delivered as the assistant message.
func TestMockTransientErrorTriggersRetry(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	seq := ts.SetMockSequence(
		helpers.ErrorMock("claude CLI stream stalled: no output for 2m0s (connection may have dropped, e.g. across system sleep)"),
		helpers.PlainResponse(helpers.TextResponse("After retry")),
	)

	triggerSendMessage(ts, "Hi")

	err := helpers.WaitForDocumentCondition(t, ts.Worker, 8*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "assistant" && item.Content == "After retry" {
				return true
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Assistant response after transient-error retry did not appear: %v", err)
	}

	if seq.CallCount() != 2 {
		t.Fatalf("Expected 2 LLM calls (transient error + retry), got %d", seq.CallCount())
	}
}

// TestMockStreamedTextEmitsChunks asserts that a StreamedText MockResponse
// delivers each chunk as a separate StreamChunk and the worker assembles them
// into the final assistant message.
func TestMockStreamedTextEmitsChunks(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	ts.SetMockSequence(helpers.StreamedText("Hello, ", "streaming ", "world!"))

	triggerSendMessage(ts, "Hi")

	err := helpers.WaitForDocumentCondition(t, ts.Worker, 5*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "assistant" && item.Content == "Hello, streaming world!" {
				return true
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Streamed assistant text did not assemble correctly: %v", err)
	}
}

// TestMockStreamedToolUseDeliversFinalArgs asserts that even when tool_use
// input arrives as partial JSON deltas, the final tool-action item carries
// the complete parsed arguments — i.e. the worker's tool_use finalization
// uses the call's terminal LLMResponse, not the mid-stream chunks.
func TestMockStreamedToolUseDeliversFinalArgs(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	ts.SetMockSequence(
		helpers.StreamedToolUse(
			"tu-1", "test_tool",
			[]string{`{"pa`, `th":`, ` "foo`, `.txt"}`},
			map[string]any{"path": "foo.txt"},
		),
		helpers.PlainResponse(helpers.TextResponse("done")),
	)

	triggerSendMessage(ts, "use the tool")

	waitForToolAction(t, ts, "tu-1")
	completeToolAction(t, ts, "tu-1", "ok")

	err := helpers.WaitForDocumentCondition(t, ts.Worker, 5*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "assistant" && item.Content == "done" {
				return true
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Strategy did not continue after tool-action: %v", err)
	}
}

// TestMockMidStreamErrorFailsCleanly asserts that MidStreamError emits any
// prelude chunks and then aborts the call with the supplied error, letting
// the worker reach idle without hanging.
func TestMockMidStreamErrorFailsCleanly(t *testing.T) {
	t.Parallel()
	ts := strategyPreamble(t)
	ts.SetMockSequence(helpers.MidStreamError(
		errors.New("mock: stream truncated"),
		worker.StreamChunk{Type: "text", Content: "partial..."},
	))

	triggerSendMessage(ts, "Hi")

	if err := helpers.WaitForWorkerState(t, ts.Worker, worker.StateIdle, 5*time.Second); err != nil {
		t.Fatalf("Worker did not return to idle after mid-stream error: %v", err)
	}

	err := helpers.WaitForDocumentCondition(t, ts.Worker, 2*time.Second, func(doc *worker.ConversationDocument) bool {
		for _, item := range doc.GetItems() {
			if item.Type == "error" {
				return true
			}
		}
		return false
	})
	if err != nil {
		ts.DumpDocument()
		t.Fatalf("Error item did not appear after mid-stream error: %v", err)
	}
}
