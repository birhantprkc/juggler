//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import "time"

// ProgressEmitter throttles mid-stream progress notifications. Providers feed
// it streamed content (text deltas, thinking deltas, tool_use JSON fragments)
// as they arrive; it forwards a running output-token estimate to the
// callback as a transient ContentBlockTypeProgress chunk no more than once
// per progressMinInterval, so the UI's "Receiving..." spinner can switch to
// a live token count without flooding the websocket.
//
// Token count is the standard chars/4 approximation via EstimateTokens. The
// final exact count from the provider's reported usage replaces it at end
// of stream via the handleResponse path on the frontend.
//
// A ProgressEmitter is owned by a single provider goroutine for the duration
// of one stream — no synchronisation needed.
type ProgressEmitter struct {
	cb         StructuredStreamCallback
	chars      int
	lastEmit   time.Time
	lastTokens int
}

const progressMinInterval = 100 * time.Millisecond

// NewProgressEmitter returns an emitter that forwards progress chunks to cb.
// cb may be nil, in which case Add is a no-op.
func NewProgressEmitter(cb StructuredStreamCallback) *ProgressEmitter {
	return &ProgressEmitter{cb: cb}
}

// Add accumulates s into the running character count and emits a progress
// chunk if the throttle window has elapsed and the token estimate has
// changed.
func (p *ProgressEmitter) Add(s string) {
	if p == nil || p.cb == nil || s == "" {
		return
	}
	p.chars += len(s)
	if time.Since(p.lastEmit) < progressMinInterval {
		return
	}
	p.emit()
}

func (p *ProgressEmitter) emit() {
	tokens := p.chars / 4
	if tokens == p.lastTokens {
		return
	}
	p.lastTokens = tokens
	p.lastEmit = time.Now()
	_, _ = p.cb(StreamChunk{
		Type: ContentBlockTypeProgress,
		Metadata: map[string]any{
			"outputTokens": tokens,
		},
	})
}
