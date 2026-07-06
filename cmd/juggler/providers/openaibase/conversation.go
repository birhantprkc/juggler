//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Conversation handle for openaibase-derived providers. Stateless from the
// conversation's view — every turn is one HTTP request carrying its
// full history — so this is a thin per-turn dispatcher around Client.

package openaibase

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

// CacheTTL returns 5 minutes — OpenAI's prefix cache is automatic with a
// sliding ~5–10 min TTL (documented as "typically 5 to 10 minutes of
// inactivity, always within an hour during off-peak"). 5m is the
// conservative end so the UI's stored cached-anchor expires before the
// upstream cache does, rather than displaying a phantom hit. Embedding
// Derived providers inherit this; the worst case is the anchor expires
// earlier than necessary and gets corrected on the next turn's actuals.
func (cv *conversation) CacheTTL() time.Duration { return 5 * time.Minute }

// Subscribe is a no-op: openaibase-derived HTTP backends are purely reactive
// and never emit a turn without a preceding request, so there are no
// autonomous turns to route to a sink.
func (cv *conversation) Subscribe(sink provider.TurnSink) {}

// Cancel is a no-op: in-flight HTTP requests are cancelled via the
// parent context, and there is no provider-side state to preserve.
func (cv *conversation) Cancel() {}

// Close is a no-op: nothing to release per-conversation.
func (cv *conversation) Close() error { return nil }
