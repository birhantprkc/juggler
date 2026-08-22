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

	"juggler/cmd/juggler/providers/provider"
)

// captureBody returns an http.Client whose transport records the decoded JSON
// request body into *out, then replays a minimal one-chunk stream for the given
// API shape ("chat" or "responses").
func captureBody(t *testing.T, out *map[string]any, shape string) *http.Client {
	t.Helper()
	var stream string
	switch shape {
	case "chat":
		stream = sseBody(`{"id":"x","object":"chat.completion.chunk","created":0,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	case "responses":
		stream = sseBody(`{"type":"response.output_text.delta","delta":"hi","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`)
	}
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		*out = payload
		header := make(http.Header)
		header.Set("Content-Type", "text/event-stream")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(stream)),
			Request:    r,
		}, nil
	})}
}

// TestChatCompletionsSendsPromptCacheKey proves the Chat Completions path pins
// prompt-cache routing to the conversation+thread. Without a stable
// prompt_cache_key, OpenAI load-balances consecutive same-prefix turns across
// cache shards and misses a cache that exists — re-billing the growing prefix
// at the fresh rate roughly every other turn (observed burning the usage
// window on gpt-5.5 / GLM agent loops).
func TestChatCompletionsSendsPromptCacheKey(t *testing.T) {
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "glm-4.6",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "chat"),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:       []provider.Message{{Type: "user", Content: "hello"}},
		ConversationID: "conv-abc",
		ThreadID:       "thread-1",
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got, _ := body["prompt_cache_key"].(string); got != "conv-abc/thread-1" {
		t.Fatalf("prompt_cache_key = %q, want %q", got, "conv-abc/thread-1")
	}
}

// TestChatCompletionsRootThreadPromptCacheKey proves the root thread (ThreadID
// "") still yields a stable, conversation-scoped key rather than being dropped.
func TestChatCompletionsRootThreadPromptCacheKey(t *testing.T) {
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "glm-4.6",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "chat"),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:       []provider.Message{{Type: "user", Content: "hello"}},
		ConversationID: "conv-abc",
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got, _ := body["prompt_cache_key"].(string); got != "conv-abc/" {
		t.Fatalf("prompt_cache_key = %q, want %q", got, "conv-abc/")
	}
}

// TestChatCompletionsOmitsPromptCacheKeyWhenNoConversation proves a request
// without a conversation id sends no key at all — a constant fallback would
// funnel unrelated conversations onto a single shard, worse than default
// prefix-only routing. (Also keeps existing conv-less unit tests byte-stable.)
func TestChatCompletionsOmitsPromptCacheKeyWhenNoConversation(t *testing.T) {
	var body map[string]any
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "glm-4.6",
		BaseURL:    "https://example.test",
		HTTPClient: captureBody(t, &body, "chat"),
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
	if _, ok := body["prompt_cache_key"]; ok {
		t.Fatalf("prompt_cache_key was sent (%v) but should be omitted without a conversation id", body["prompt_cache_key"])
	}
}

// TestResponsesSendsPromptCacheKey proves the Responses API path (the gpt-5.x /
// codex ChatGPT-plan surface that was observed missing cache ~half the turns)
// carries the same stable prompt_cache_key.
func TestResponsesSendsPromptCacheKey(t *testing.T) {
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
	_, err = c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:       []provider.Message{{Type: "user", Content: "hello"}},
		ConversationID: "conv-xyz",
		ThreadID:       "thread-2",
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got, _ := body["prompt_cache_key"].(string); got != "conv-xyz/thread-2" {
		t.Fatalf("prompt_cache_key = %q, want %q", got, "conv-xyz/thread-2")
	}
}
