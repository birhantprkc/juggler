//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Conversation handle for the gemini provider. Stateless from the
// conversation's view — gemini's HTTP API is whole-history per request —
// so this is a thin per-turn dispatcher around Client. Tool-result
// continuations and fresh user messages both route through the same
// Submit/streamMessage path; the provider derives which from
// req.Messages' trailing entries. Never emits autonomously, so Subscribe
// is a no-op.

package gemini

import (
	"context"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

type conversation struct {
	client *Client
	convID string
}

func (cv *conversation) Submit(ctx context.Context, req provider.MessageRequest, callback provider.StructuredStreamCallback) (*provider.StreamResult, error) {
	if req.ConversationID == "" {
		req.ConversationID = cv.convID
	}
	return cv.client.streamMessage(ctx, req, callback)
}

// CacheTTL returns 0 because gemini doesn't expose a TTL-bounded prefix
// cache through this client.
func (cv *conversation) CacheTTL() time.Duration { return 0 }

// Subscribe is a no-op: the gemini HTTP backend is purely reactive and never
// emits a turn without a preceding request, so there are no autonomous turns
// to route to a sink.
func (cv *conversation) Subscribe(sink provider.TurnSink) {}

// Cancel is a no-op for gemini: in-flight HTTP requests are cancelled via
// the parent context, and there is no provider-side state to preserve
// between turns.
func (cv *conversation) Cancel() {}

// Close is a no-op for gemini: nothing to release per-conversation.
func (cv *conversation) Close() error { return nil }
