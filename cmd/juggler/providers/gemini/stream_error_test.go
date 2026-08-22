//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/utils"

	"google.golang.org/genai"
)

// classifyStreamError is the whole of gemini's contract with the worker's retry
// loop, and that loop reads text. These cases assert the mapping in the terms
// the loop actually uses — utils.TransientMessage for the capacity failures,
// and the "429"/"rate limit" substrings the turn loop's isRateLimitMsg matches
// — so a reworded message that silently stopped being retryable fails here.

func TestClassifyStreamErrorMarksCapacityFailuresTransient(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
	}{
		{"bad gateway", 502},
		{"service unavailable", 503},
		{"gateway timeout", 504},
		{"overloaded", statusOverloaded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyStreamError(genai.APIError{Code: tc.code, Message: "upstream is busy", Status: "UNAVAILABLE"})
			if !utils.TransientMessage(err.Error()) {
				t.Fatalf("code %d must classify as transient, got %q", tc.code, err.Error())
			}
			if !strings.Contains(err.Error(), "upstream is busy") {
				t.Fatalf("underlying provider text must survive, got %q", err.Error())
			}
		})
	}
}

func TestClassifyStreamErrorMarksRateLimit(t *testing.T) {
	err := classifyStreamError(genai.APIError{Code: 429, Message: "quota exceeded", Status: "RESOURCE_EXHAUSTED"})
	msg := strings.ToLower(err.Error())
	// Both spellings the worker's isRateLimitMsg accepts.
	if !strings.Contains(msg, "rate limit") || !strings.Contains(err.Error(), "429") {
		t.Fatalf("429 must be recognisable as a rate limit, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "quota exceeded") {
		t.Fatalf("underlying provider text must survive, got %q", err.Error())
	}
}

func TestClassifyStreamErrorLeavesOtherFailuresTerminal(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"client error", genai.APIError{Code: 400, Message: "invalid argument"}},
		{"auth", genai.APIError{Code: 403, Message: "permission denied"}},
		{"not an API error", errors.New("dial tcp: no route to host")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := classifyStreamError(tc.err)
			if utils.TransientMessage(err.Error()) {
				t.Fatalf("%s must not be retried transparently, got %q", tc.name, err.Error())
			}
			if !strings.Contains(err.Error(), "gemini") {
				t.Fatalf("error must name the provider, got %q", err.Error())
			}
		})
	}
}

// The SDK hands back genai.APIError by value, and callers wrap it, so the
// classification has to survive both. A pointer-typed assertion (which is what
// the retired googleapi.Error branch used) matches neither.
func TestClassifyStreamErrorUnwrapsWrappedAPIError(t *testing.T) {
	wrapped := fmt.Errorf("stream failed: %w", genai.APIError{Code: 503, Message: "model overloaded"})
	if err := classifyStreamError(wrapped); !utils.TransientMessage(err.Error()) {
		t.Fatalf("a wrapped 503 must still classify as transient, got %q", err.Error())
	}
}
