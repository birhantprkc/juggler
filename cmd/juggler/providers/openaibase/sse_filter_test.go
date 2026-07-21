//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/packages/ssestream"
)

func filterString(t *testing.T, raw string) string {
	t.Helper()
	f := newSSEEmptyFrameFilter(io.NopCloser(strings.NewReader(raw)))
	out, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("filter read: %v", err)
	}
	return string(out)
}

// chunk builds one valid chat.completion.chunk data frame.
func chunk(content string) string {
	return `data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"` + content + `"}}]}` + "\n\n"
}

// TestSSEFilterDropsEmptyDataFrame: an empty `data:` heartbeat between two real
// frames is removed, leaving the real frames byte-for-byte intact.
func TestSSEFilterDropsEmptyDataFrame(t *testing.T) {
	in := chunk("A") + "data:\n\n" + chunk("B")
	got := filterString(t, in)
	want := chunk("A") + chunk("B")
	if got != want {
		t.Fatalf("empty data frame not dropped cleanly:\n got=%q\nwant=%q", got, want)
	}
}

// TestSSEFilterDropsCommentKeepAlive: a comment keep-alive immediately followed
// by a blank line dispatches an empty payload in the SDK and must be dropped.
func TestSSEFilterDropsCommentKeepAlive(t *testing.T) {
	in := chunk("A") + ": ping\n\n" + chunk("B")
	got := filterString(t, in)
	want := chunk("A") + chunk("B")
	if got != want {
		t.Fatalf("comment keep-alive frame not dropped:\n got=%q\nwant=%q", got, want)
	}
}

// TestSSEFilterPreservesDoneAndData: the [DONE] sentinel and normal frames pass
// through untouched.
func TestSSEFilterPreservesDoneAndData(t *testing.T) {
	in := chunk("hi") + "data: [DONE]\n\n"
	if got := filterString(t, in); got != in {
		t.Fatalf("valid stream altered:\n got=%q\nwant=%q", got, in)
	}
}

// streamFromSSE runs a raw SSE body through the real openai-go decoder exactly
// as the client does, optionally wrapped in our filter, and returns the
// concatenated streamed content plus the terminal stream error.
func streamFromSSE(raw string, filter bool) (string, error) {
	body := io.NopCloser(strings.NewReader(raw))
	if filter {
		body = newSSEEmptyFrameFilter(body)
	}
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:   body,
	}
	stream := ssestream.NewStream[openai.ChatCompletionChunk](ssestream.NewDecoder(resp), nil)
	var sb strings.Builder
	for stream.Next() {
		for _, ch := range stream.Current().Choices {
			sb.WriteString(ch.Delta.Content)
		}
	}
	return sb.String(), stream.Err()
}

// TestSSEDecoderFailsWithoutFilter is the control: it pins the exact upstream
// defect this fix targets — an empty data heartbeat makes the unwrapped decoder
// return "unexpected end of JSON input".
func TestSSEDecoderFailsWithoutFilter(t *testing.T) {
	in := chunk("A") + "data:\n\n" + chunk("B") + "data: [DONE]\n\n"
	_, err := streamFromSSE(in, false)
	if err == nil || !strings.Contains(err.Error(), "unexpected end of JSON input") {
		t.Fatalf("expected the upstream decode failure, got err=%v", err)
	}
}

// TestSSEDecoderSucceedsWithFilter: the same stream, wrapped in our filter,
// decodes cleanly and yields the real deltas in order.
func TestSSEDecoderSucceedsWithFilter(t *testing.T) {
	in := chunk("A") + "data:\n\n" + ": ping\n\n" + chunk("B") + "data: [DONE]\n\n"
	got, err := streamFromSSE(in, true)
	if err != nil {
		t.Fatalf("stream errored with filter: %v", err)
	}
	if got != "AB" {
		t.Fatalf("streamed content = %q, want %q", got, "AB")
	}
}
