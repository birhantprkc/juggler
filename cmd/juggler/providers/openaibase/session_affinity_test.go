//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// captureHeaders returns an http.Client that records each request's
// session_id header and replays a minimal Responses-shape stream.
func captureHeaders(sessionIDs *[]string) *http.Client {
	stream := sseBody(`{"type":"response.output_text.delta","delta":"hi","item_id":"m1","output_index":0,"content_index":0,"sequence_number":1}`)
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		*sessionIDs = append(*sessionIDs, r.Header.Get("session_id"))
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

func sessionAffinityClient(t *testing.T, sessionIDs *[]string, quirks Quirks) *Client {
	t.Helper()
	c, err := NewClient(Config{
		APIKey:     "test",
		Model:      "gpt-5-codex", // contains "codex" → Responses API path
		BaseURL:    "https://example.test",
		HTTPClient: captureHeaders(sessionIDs),
		Quirks:     quirks,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func streamOnce(t *testing.T, c *Client, convID string) {
	t.Helper()
	_, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:       []provider.Message{{Type: "user", Content: "hello"}},
		ConversationID: convID,
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil })
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
}

// TestSessionAffinityHeaderStablePerConversation: with the quirk on, every
// request for a conversation carries the same UUID-shaped session_id — the
// ChatGPT Codex backend's cache-affinity key. Losing stability across turns
// would lose replica affinity and re-bill the whole prefix, so this pins the
// derivation, not just presence.
func TestSessionAffinityHeaderStablePerConversation(t *testing.T) {
	var got []string
	c := sessionAffinityClient(t, &got, Quirks{ForceResponsesAPI: true, SessionAffinityHeader: true})

	streamOnce(t, c, "conv-abc")
	streamOnce(t, c, "conv-abc")
	streamOnce(t, c, "conv-other")

	if len(got) != 3 {
		t.Fatalf("expected 3 requests, got %d", len(got))
	}
	uuidShape := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if !uuidShape.MatchString(got[0]) {
		t.Fatalf("session_id %q is not UUID-shaped", got[0])
	}
	if got[0] != got[1] {
		t.Fatalf("session_id changed between turns of the same conversation: %q vs %q", got[0], got[1])
	}
	if got[0] == got[2] {
		t.Fatalf("different conversations share a session_id (%q) — they would funnel onto one replica", got[0])
	}
}

// TestSessionAffinityHeaderAbsences: no header without the quirk (other
// vendors don't know it, requests must stay byte-identical), and no header
// without a conversation id even with the quirk on.
func TestSessionAffinityHeaderAbsences(t *testing.T) {
	var withoutQuirk []string
	c := sessionAffinityClient(t, &withoutQuirk, Quirks{ForceResponsesAPI: true})
	streamOnce(t, c, "conv-abc")
	if withoutQuirk[0] != "" {
		t.Fatalf("session_id %q sent without the quirk", withoutQuirk[0])
	}

	var withoutConv []string
	c = sessionAffinityClient(t, &withoutConv, Quirks{ForceResponsesAPI: true, SessionAffinityHeader: true})
	streamOnce(t, c, "")
	if withoutConv[0] != "" {
		t.Fatalf("session_id %q sent with no conversation id", withoutConv[0])
	}
}
