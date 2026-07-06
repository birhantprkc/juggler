//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Conversation handle for the anthropic provider. Stateless from the
// conversation's view — anthropic's HTTP API is whole-history per
// request — so this is a thin per-turn dispatcher around Client.
// Tool-result continuations and fresh user messages both route through
// the same Submit/streamMessage path; the provider derives which from
// req.Messages' trailing entries. Never emits autonomously, so Subscribe
// is a no-op.

package anthropic

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

// CacheTTL reports the lifetime of the prompt-cache anchor the client writes via
// the ephemeral cache_control breakpoints in buildMessageParams. Ephemeral
// breakpoints default to Anthropic's 5-minute TTL, so the UI treats a warm
// anchor as stale after 5 minutes of inactivity. The breakpoint layout is
//
//	[ tools ][ system ] | cache_control | [ history ] | cache_control |
//
// The system breakpoint is worth emitting because that prefix is stable across
// strategy changes (it varies only on a plugin toggle or a pinned-file edit);
// the history breakpoint rolls the cache forward across the growing
// conversation. See buildMessageParams for the full rationale.
func (cv *conversation) CacheTTL() time.Duration { return 5 * time.Minute }

// Subscribe is a no-op: the anthropic HTTP backend is purely reactive and
// never emits a turn without a preceding request, so there are no autonomous
// turns to route to a sink.
func (cv *conversation) Subscribe(sink provider.TurnSink) {}

// Cancel is a no-op: in-flight HTTP requests are cancelled via the
// parent context, and there is no provider-side state to preserve.
func (cv *conversation) Cancel() {}

// Close is a no-op: nothing to release per-conversation.
func (cv *conversation) Close() error { return nil }
