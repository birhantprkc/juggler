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
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
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
