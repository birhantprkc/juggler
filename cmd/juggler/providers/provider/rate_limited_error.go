//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import "time"

// RateLimitedError reports a provider refusing a request because a rate limit
// or usage cap has been reached.
//
// It exists as its own type for one field: RetryAfter. A 429 states how long it
// will last, in a header or in its body, and that number decides everything
// downstream — whether a retry can clear it at all, and what the user is told.
// Reported as bare text it reaches the caller as a substring match against
// "429", and the wait has to be guessed; a guess of a few seconds against a cap
// that lasts four hours spends the account's next window discovering the same
// refusal once per thread.
type RateLimitedError struct {
	// RetryAfter is how long the provider said to wait, or 0 when it said
	// nothing. 0 means "unstated", never "retry immediately" — a caller with no
	// stated wait is guessing and should say so.
	RetryAfter time.Duration

	// Message is the provider's own account of the refusal, verbatim. It is the
	// only diagnosable part and is never rewritten: the reader is told what this
	// means in a lead above it, not instead of it.
	Message string

	// Cause is the underlying provider/SDK error, preserved so callers can still
	// match on it.
	Cause error
}

func (e *RateLimitedError) Error() string { return e.Message }
func (e *RateLimitedError) Unwrap() error { return e.Cause }
