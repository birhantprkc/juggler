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

// streamClient replays the given SSE stream for any request.
func streamClient(stream string) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
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

func responsesStream(t *testing.T, stream string) *provider.StreamResult {
	t.Helper()
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex", // contains "codex" → Responses API path
		BaseURL:    "https://example.test",
		HTTPClient: streamClient(stream),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	return res
}

// TestResponsesUsageWithoutDetailsLeavesCacheUnknown: a response.completed
// whose usage omits input_tokens_details entirely must yield nil CachedTokens
// (cache usage unknown) — never a fabricated 0 that reads as a cache miss.
// The Codex backend emits exactly this shape on some calls, which is what made
// its transaction blobs look like intermittent full misses.
func TestResponsesUsageWithoutDetailsLeavesCacheUnknown(t *testing.T) {
	res := responsesStream(t, sseBody(
		`{"type":"response.output_text.delta","delta":"hi","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`,
		`{"type":"response.completed","sequence_number":2,"response":{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":172743,"output_tokens":12,"total_tokens":172755}}}`,
	))
	if res.InputTokens != 172743 || res.InputTokensApproximate {
		t.Fatalf("InputTokens = %d (approx=%v), want provider-reported 172743", res.InputTokens, res.InputTokensApproximate)
	}
	if res.CachedTokens != nil {
		t.Fatalf("CachedTokens = %d, want nil (details block omitted ⇒ unknown, not a miss)", *res.CachedTokens)
	}
	if res.CacheWriteTokens != nil {
		t.Fatalf("CacheWriteTokens = %d, want nil (Responses API has no cache-write field)", *res.CacheWriteTokens)
	}
}

// TestResponsesExplicitZeroCachedTokensIsReported: input_tokens_details with
// cached_tokens:0 is a genuine provider report of zero cache reuse and must be
// preserved as an explicit 0, distinguishable from the omitted-details case.
func TestResponsesExplicitZeroCachedTokensIsReported(t *testing.T) {
	res := responsesStream(t, sseBody(
		`{"type":"response.completed","sequence_number":1,"response":{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":0},"output_tokens":5,"total_tokens":1005}}}`,
	))
	if res.CachedTokens == nil {
		t.Fatal("CachedTokens = nil, want explicit 0 (details block present with cached_tokens:0)")
	}
	if *res.CachedTokens != 0 {
		t.Fatalf("CachedTokens = %d, want 0", *res.CachedTokens)
	}
}

// TestResponsesNonZeroCachedTokensIsReported: the ordinary hit case still
// surfaces the reported subset.
func TestResponsesNonZeroCachedTokensIsReported(t *testing.T) {
	res := responsesStream(t, sseBody(
		`{"type":"response.completed","sequence_number":1,"response":{"id":"resp_1","object":"response","status":"completed","usage":{"input_tokens":172485,"input_tokens_details":{"cached_tokens":168448},"output_tokens":9,"total_tokens":172494}}}`,
	))
	if res.CachedTokens == nil || *res.CachedTokens != 168448 {
		t.Fatalf("CachedTokens = %v, want 168448", res.CachedTokens)
	}
}
