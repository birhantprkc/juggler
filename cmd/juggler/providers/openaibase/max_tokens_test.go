//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestEffectiveMaxOutputTokensClampsToCatalog pins the F4 openaibase clamp: a
// capability snapshot above the descriptor catalog's known per-model ceiling is
// clamped down to the catalog value; a snapshot below it is kept; and an
// unknown model keeps the snapshot (falling back only when it is unset).
func TestEffectiveMaxOutputTokensClampsToCatalog(t *testing.T) {
	catalog := func(model string) (int, bool) {
		if model == "known" {
			return 4096, true
		}
		return 0, false
	}
	cases := []struct {
		name     string
		model    string
		snapshot int
		hasCat   bool
		reqCap   int64
		want     int
	}{
		{"known model clamps snapshot down", "known", 40000, true, 0, 4096},
		{"known model keeps lower snapshot", "known", 2048, true, 0, 2048},
		{"unknown model keeps snapshot", "other", 40000, true, 0, 40000},
		{"no catalog keeps snapshot", "known", 40000, false, 0, 40000},
		{"unset snapshot falls back", "other", 0, true, 0, fallbackMaxOutputTokens},
		// F1: a per-request cap only ever lowers the effective wire value.
		{"request cap lowers below snapshot", "other", 40000, true, 4096, 4096},
		{"request cap ignored when above snapshot", "known", 2048, true, 8000, 2048},
		{"request cap applies with catalog clamp", "known", 40000, true, 1000, 1000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Client{model: tc.model, maxOutputTokens: tc.snapshot}
			if tc.hasCat {
				c.catalogMaxOutput = catalog
			}
			if got := c.effectiveMaxOutputTokens(provider.MessageRequest{MaxOutputTokens: tc.reqCap}); got != tc.want {
				t.Fatalf("effectiveMaxOutputTokens() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestResponsesRequestUsesConfiguredMaxOutputTokens(t *testing.T) {
	var got float64
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		got, _ = payload["max_output_tokens"].(float64)
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sseBody(`{"type":"response.output_text.delta","delta":"hi","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`))),
			Request:    r,
		}, nil
	})}
	c, err := NewClient(Config{
		APIKey:          "test",
		Model:           "gpt-5-codex",
		BaseURL:         "https://example.test",
		HTTPClient:      httpClient,
		MaxOutputTokens: 32768,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got != 32768 {
		t.Fatalf("max_output_tokens = %v, want 32768", got)
	}
}

// tracks the model's configured max-output-tokens instead of a hardcoded 8192.
// Reasoning models (GLM, DeepSeek-R1) spend output budget on chain-of-thought
// before the answer; an 8192 cap throttles the reasoning itself, producing
// empty `finish=length` turns. A client told the model allows 65536 must send
// that on the wire.
func TestRequestUsesConfiguredMaxOutputTokens(t *testing.T) {
	var gotMaxTokens float64
	var sawKey bool
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if v, ok := payload["max_tokens"].(float64); ok {
			gotMaxTokens = v
			sawKey = true
		}
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sseBody(`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))),
			Request:    r,
		}, nil
	})}

	c, err := NewClient(Config{
		APIKey:          "test",
		Model:           "glm-4.6",
		BaseURL:         "https://example.test",
		HTTPClient:      httpClient,
		MaxOutputTokens: 65536,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if !sawKey {
		t.Fatal("request carried no max_tokens param")
	}
	if gotMaxTokens != 65536 {
		t.Fatalf("max_tokens = %v, want 65536 (the model's configured cap)", gotMaxTokens)
	}
}

// TestRequestHonorsLowerConfiguredCap proves a model whose declared cap sits
// BELOW the fallback is sent verbatim — the fallback is an unset-default, not a
// floor. Flooring it (the old behaviour) made ModelInfo.MaxOutputTokens a lie:
// ollama advertises 4096 but the request would have carried 8192.
func TestRequestHonorsLowerConfiguredCap(t *testing.T) {
	var gotMaxTokens float64
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		if v, ok := payload["max_tokens"].(float64); ok {
			gotMaxTokens = v
		}
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sseBody(`{"id":"x","object":"chat.completion.chunk","created":0,"model":"local","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))),
			Request:    r,
		}, nil
	})}

	c, err := NewClient(Config{
		APIKey:          "test",
		Model:           "local",
		BaseURL:         "https://example.test",
		HTTPClient:      httpClient,
		MaxOutputTokens: 4096, // below fallbackMaxOutputTokens
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if gotMaxTokens != 4096 {
		t.Fatalf("max_tokens = %v, want 4096 (configured cap honoured, not floored)", gotMaxTokens)
	}
}

// TestRequestMaxOutputTokensFallsBackWhenUnset proves an unconfigured client
// (MaxOutputTokens == 0) still sends a sane non-zero cap rather than 0/omitted.
func TestRequestMaxOutputTokensFallsBackWhenUnset(t *testing.T) {
	var gotMaxTokens float64
	httpClient := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		if v, ok := payload["max_tokens"].(float64); ok {
			gotMaxTokens = v
		}
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(sseBody(`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))),
			Request:    r,
		}, nil
	})}

	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "glm-4.6",
		BaseURL:    "https://example.test",
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if gotMaxTokens <= 0 {
		t.Fatalf("max_tokens = %v, want a non-zero fallback cap", gotMaxTokens)
	}
}
