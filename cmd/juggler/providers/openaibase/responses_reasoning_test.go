//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestResponsesReasoningSurfacedAsThinking proves the Responses API path
// (o-series / gpt-5-codex) surfaces the model's reasoning the same way the
// Chat Completions path surfaces `reasoning_content`: as live thinking that
// also drives the output-token progress estimate. Without it a model that
// reasons before answering left the spinner frozen on "Receiving".
func TestResponsesReasoningSurfacedAsThinking(t *testing.T) {
	body := sseBody(
		`{"type":"response.reasoning_summary_text.delta","delta":"Weighing the options.","item_id":"r1","output_index":0,"sequence_number":1,"summary_index":0}`,
		`{"type":"response.reasoning_summary_text.delta","delta":" Settling on an answer.","item_id":"r1","output_index":0,"sequence_number":2,"summary_index":0}`,
		`{"type":"response.output_text.delta","delta":"Done.","item_id":"m1","output_index":1,"content_index":0,"sequence_number":3}`,
	)
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	})}
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex", // contains "codex" → Responses API path
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	var thinking, text strings.Builder
	var sawProgress bool
	result, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		switch chunk.Type {
		case provider.ContentBlockTypeThinking:
			thinking.WriteString(chunk.Content)
		case provider.ContentBlockTypeProgress:
			sawProgress = true
		case provider.ContentBlockTypeText:
			text.WriteString(chunk.Content)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if result.InputTokens == 0 || !result.InputTokensApproximate {
		t.Fatalf("fallback input usage = %+v, want positive approximate count", result)
	}
	if got := thinking.String(); got != "Weighing the options. Settling on an answer." {
		t.Fatalf("reasoning was not surfaced as thinking; got %q", got)
	}
	if !sawProgress {
		t.Fatal("reasoning did not drive a progress chunk — the spinner would stay frozen on \"Receiving\"")
	}
	if got := text.String(); got != "Done." {
		t.Fatalf("final text = %q, want \"Done.\"", got)
	}
}

// TestResponsesRequestsReasoningSummary is the guard for the half that makes
// the test above mean anything in production. The Responses API streams
// reasoning_summary_text events only for a request that asked for a summary, so
// parsing them is worthless on its own: with effort alone (or with no reasoning
// object at all, which is what a default turn sends) a reasoning model emits no
// summary and the UI shows no thinking. The summary must ride on every
// reasoning-model request, including one carrying no thinking level.
func TestResponsesRequestsReasoningSummary(t *testing.T) {
	reasoningOf := func(t *testing.T, body map[string]any) map[string]any {
		t.Helper()
		reasoning, ok := body["reasoning"].(map[string]any)
		if !ok {
			t.Fatalf("no reasoning object on the wire; body = %v", body)
		}
		return reasoning
	}

	// Reasoning model, no level picked: summary present, effort omitted so the
	// model stays on its own default.
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex", // contains "codex" → Responses API path
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "responses"),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.thinkingSpec = OpenAIThinkingSpec("gpt-5-codex")
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	reasoning := reasoningOf(t, body)
	if got, _ := reasoning["summary"].(string); got != "auto" {
		t.Fatalf("reasoning.summary = %q, want auto — without it no thinking is ever streamed", got)
	}
	if _, ok := reasoning["effort"]; ok {
		t.Fatalf("reasoning.effort sent (%v) but no level was picked", reasoning["effort"])
	}

	// Reasoning model with a level: summary and effort travel together.
	var levelBody map[string]any
	c2, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &levelBody, "responses"),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c2.thinkingSpec = OpenAIThinkingSpec("gpt-5-codex")
	if _, err := c2.streamMessage(context.Background(), provider.MessageRequest{
		Messages:      []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel: "high",
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	levelReasoning := reasoningOf(t, levelBody)
	if got, _ := levelReasoning["summary"].(string); got != "auto" {
		t.Fatalf("reasoning.summary = %q, want auto", got)
	}
	if got, _ := levelReasoning["effort"].(string); got != "high" {
		t.Fatalf("reasoning.effort = %q, want high", got)
	}

	// A model advertising no levels is not a reasoning model: no reasoning
	// object at all. Sending one is a hard 400 on some endpoints, and this is
	// the shape every provider without a ThinkingSpecFn (openrouter,
	// openaicompat) puts on the wire.
	var plainBody map[string]any
	c3, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-4o",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &plainBody, "responses"),
		Quirks:     Quirks{ForceResponsesAPI: true}, // gpt-4o alone wouldn't take this path
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := c3.streamMessage(context.Background(), provider.MessageRequest{
		Messages:      []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel: "high", // even an explicit level must not conjure one
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if _, ok := plainBody["reasoning"]; ok {
		t.Fatalf("reasoning sent (%v) to a model advertising no levels", plainBody["reasoning"])
	}
}
