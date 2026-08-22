//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// messageSSE packs Anthropic message-stream events into an SSE body the SDK can
// decode: each event needs both its `event:` name and its `data:` payload.
func messageSSE(events ...[2]string) string {
	var b strings.Builder
	for _, e := range events {
		b.WriteString("event: ")
		b.WriteString(e[0])
		b.WriteString("\ndata: ")
		b.WriteString(e[1])
		b.WriteString("\n\n")
	}
	return b.String()
}

// streamingClient returns a Client whose transport answers with a fixed SSE
// body. NewClient hardcodes its HTTP client, so the struct is built directly.
func streamingClient(body string) *Client {
	sdk := anthropicsdk.NewClient(
		option.WithAPIKey("test"),
		option.WithHTTPClient(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("Content-Type", "text/event-stream")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     header,
				Body:       io.NopCloser(strings.NewReader(body)),
				Request:    r,
			}, nil
		})}),
	)
	return &Client{client: &sdk, model: "claude-sonnet-4-6", maxOutputTokens: 1024}
}

// TestStreamedThinkingEmitsSignature is the guard for the streamed half of
// Claude's thinking round trip. The signature arrives in its own deltas and is
// complete only at content_block_stop, so it has to be streamed separately from
// the thinking text. Without that chunk the worker stores the block with no
// providerData, TransformToAPIMessages drops it as signatureless on the next
// turn, and Claude's reasoning is lost across every tool call.
func TestStreamedThinkingEmitsSignature(t *testing.T) {
	c := streamingClient(messageSSE(
		[2]string{"message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Weighing the options."}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-xyz"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":1}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	))

	var thinking strings.Builder
	var signature string
	var signatureChunks int
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type != provider.ContentBlockTypeThinking {
			return nil, nil
		}
		thinking.WriteString(chunk.Content)
		if sig, _ := chunk.Metadata["signature"].(string); sig != "" {
			signature = sig
			signatureChunks++
		}
		return nil, nil
	}); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}

	if got := thinking.String(); got != "Weighing the options." {
		t.Fatalf("thinking text = %q, want the deltas streamed", got)
	}
	if signature != "sig-xyz" {
		t.Fatalf("no signature reached the callback (got %q) — the block will be dropped on the next turn", signature)
	}
	if signatureChunks != 1 {
		t.Fatalf("signature streamed %d times, want exactly once", signatureChunks)
	}
}

// TestStreamedThinkingWithoutSignatureCarriesNoMetadata pins the empty case: a
// thinking block that never received a signature_delta must carry no metadata
// at all, rather than an empty signature that would be stored as providerData
// and then dropped again at the next transform.
func TestStreamedThinkingWithoutSignatureCarriesNoMetadata(t *testing.T) {
	c := streamingClient(messageSSE(
		[2]string{"message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Unsigned."}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	))

	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hello"}},
	}, func(chunk provider.StreamChunk) (*provider.ToolResult, error) {
		if chunk.Type == provider.ContentBlockTypeThinking && len(chunk.Metadata) > 0 {
			t.Errorf("unsigned thinking carried metadata %+v", chunk.Metadata)
		}
		return nil, nil
	}); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
}
