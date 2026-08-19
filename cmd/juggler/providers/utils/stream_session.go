//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import (
	"context"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// StreamSession is the scaffolding every SDK-streaming provider arms around its
// event loop: a cancellable context derived from the caller's, the idle
// watchdog that cancels it when the upstream goes silent, the throttled
// progress emitter that drives the UI's live output-token count, and the
// stall-versus-cancel classification the resulting stream error needs.
//
// It owns only what was byte-identical at every arm site. Decoding SDK events,
// accumulating blocks, capturing usage and building the result stay
// provider-local, because those genuinely differ — anthropic runs a block state
// machine and reports cache-write tokens, gemini never accumulates output text,
// and the two openai paths key their tool accumulators differently.
//
// Typical use:
//
//	sess, streamCtx := utils.NewStreamSession(ctx, "anthropic", callback)
//	defer sess.Close()
//	stream := sdk.NewStreaming(streamCtx, params)
//	for stream.Next() {
//	    sess.Reset()
//	    // … decode the event, sess.Progress(delta) on streamed content …
//	}
//	if err := stream.Err(); err != nil {
//	    if stall := sess.StallError(); stall != nil {
//	        return nil, stall
//	    }
//	    return nil, err
//	}
//
// A session belongs to one goroutine for the life of one stream attempt. A
// provider that retries internally (gemini) arms a fresh session per attempt,
// so the idle window it reports is the one that actually elapsed.
type StreamSession struct {
	name     string
	parent   context.Context
	cancel   context.CancelFunc
	idle     *IdleWatchdog
	timeout  time.Duration
	progress *provider.ProgressEmitter
}

// NewStreamSession arms a session for one stream and returns it alongside the
// context to hand the SDK. providerName is the lowercase registry id used to
// label a stall ("anthropic", "gemini", "zai"); callback may be nil, in which
// case Progress is a no-op.
//
// The idle window is resolved once here and reused for both the watchdog and
// the stall message, so the reported timeout is the one that fired.
func NewStreamSession(ctx context.Context, providerName string, callback provider.StructuredStreamCallback) (*StreamSession, context.Context) {
	streamCtx, cancel := context.WithCancel(ctx)
	timeout := EffectiveStreamIdleTimeout()
	return &StreamSession{
		name:     providerName,
		parent:   ctx,
		cancel:   cancel,
		idle:     NewIdleWatchdog(timeout, cancel),
		timeout:  timeout,
		progress: provider.NewProgressEmitter(callback),
	}, streamCtx
}

// Reset restarts the idle window. Call it on every received stream event.
func (s *StreamSession) Reset() {
	s.idle.Reset()
}

// Progress feeds streamed content (text deltas, thinking deltas, tool-input
// JSON fragments) to the throttled output-token estimate behind the UI spinner.
func (s *StreamSession) Progress(text string) {
	s.progress.Add(text)
}

// StallError returns the canonical transient stall error when the watchdog
// fired while the caller's context was still alive — the stream went silent,
// rather than the caller cancelling it. It returns nil otherwise, so a stream
// error is classified with `if stall := sess.StallError(); stall != nil` instead
// of each provider re-deriving the predicate and remembering which timeout to
// report. Getting that wrong in either direction is costly: a missed stall
// parks the turn, and a misclassified caller cancel makes the worker auto-retry
// a deliberate interrupt.
func (s *StreamSession) StallError() error {
	if s.idle.Fired() && s.parent.Err() == nil {
		return StallError(s.name, s.timeout)
	}
	return nil
}

// Close stops the watchdog and releases the derived context, in that order.
// Idempotent; defer it immediately after NewStreamSession.
func (s *StreamSession) Close() {
	s.idle.Stop()
	s.cancel()
}
