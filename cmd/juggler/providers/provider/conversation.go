//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"context"
	"time"
)

// StatelessConversation is the Conversation handle for providers whose backend
// is a stateless HTTP API — every turn is one request carrying its full
// history, so there is no per-conversation provider-side state to track.
// anthropic, gemini, and the openaibase-derived providers all return one of
// these from OpenConversation; the stateful outlier is claudecode (its own
// handle owns live CLI subprocesses and per-thread session bookkeeping).
//
// The handle owns only the conversation id (defaulted onto requests that omit
// one), the prompt-cache TTL to report, and a per-turn Dispatch func — almost
// always the client's streamMessage method value. Because the backend is
// purely reactive, Subscribe/Cancel/Close are all no-ops.
type StatelessConversation struct {
	// ConvID is stamped onto req.ConversationID when the caller left it empty.
	ConvID string
	// TTL is reported verbatim by CacheTTL; 0 means the provider exposes no
	// time-bounded prefix cache.
	TTL time.Duration
	// Dispatch drives one solicited turn — typically the client's streamMessage.
	Dispatch func(ctx context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error)
}

// Submit defaults the conversation id onto the request, then dispatches one
// turn. Tool-result continuations and fresh user turns both route through
// Dispatch; the provider derives which from req.Messages' trailing entries.
func (cv *StatelessConversation) Submit(ctx context.Context, req MessageRequest, callback StructuredStreamCallback) (*StreamResult, error) {
	if req.ConversationID == "" {
		req.ConversationID = cv.ConvID
	}
	return cv.Dispatch(ctx, req, callback)
}

// CacheTTL reports the upstream prompt-cache lifetime the client configured.
func (cv *StatelessConversation) CacheTTL() time.Duration { return cv.TTL }

// Subscribe is a no-op: stateless HTTP backends never emit a turn without a
// preceding Submit, so there are no autonomous turns to route to a sink.
func (cv *StatelessConversation) Subscribe(sink TurnSink) {}

// Cancel is a no-op whatever thread it names: in-flight requests are cancelled
// via the parent context, and there is no provider-side state to preserve
// between turns — per-thread or otherwise.
func (cv *StatelessConversation) Cancel(threadItemID string) {}

// Close is a no-op: nothing to release per-conversation.
func (cv *StatelessConversation) Close() error { return nil }
