//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"errors"
	"fmt"
	"testing"
)

// The worker wraps every provider failure before reporting it
// (classifyLLMError: fmt.Errorf("LLM error: %w", cause)), so an AuthError is
// only ever seen through at least one layer of wrapping. If errors.As stopped
// finding it there, the reporting branch would silently fall through to the
// generic terminal path and the user would be back to reading the provider's raw
// text with no remediation.
func TestAuthErrorSurvivesWrapping(t *testing.T) {
	original := &AuthError{
		Provider: "claudecode",
		Status:   401,
		Message:  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
		Hint:     "Run `claude` in a terminal and use /login.",
	}

	wrapped := fmt.Errorf("LLM error: %w", error(original))
	wrapped = fmt.Errorf("delivering turn: %w", wrapped)

	var found *AuthError
	if !errors.As(wrapped, &found) {
		t.Fatalf("errors.As did not find an AuthError through wrapping: %v", wrapped)
	}
	if found != original {
		t.Errorf("errors.As returned a different AuthError: got %#v, want %#v", found, original)
	}
	if found.Hint != original.Hint {
		t.Errorf("Hint = %q, want %q", found.Hint, original.Hint)
	}
}

// Error() carries the provider's own text unchanged when there is any, because
// that text is the only diagnosable part of a credential failure. The
// constructed forms exist only for providers that refuse without saying why.
func TestAuthErrorText(t *testing.T) {
	tests := []struct {
		name string
		err  *AuthError
		want string
	}{
		{
			name: "provider text is kept verbatim",
			err:  &AuthError{Provider: "claudecode", Status: 401, Message: "OAuth access token has expired."},
			want: "OAuth access token has expired.",
		},
		{
			name: "no text but a status",
			err:  &AuthError{Provider: "claudecode", Status: 401},
			want: "claudecode rejected the request as unauthenticated (HTTP 401)",
		},
		{
			name: "no text and no status",
			err:  &AuthError{Provider: "claudecode"},
			want: "claudecode rejected the request as unauthenticated",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.err.Error(); got != tt.want {
				t.Errorf("Error() = %q, want %q", got, tt.want)
			}
		})
	}
}

// An expired credential does not heal by being asked again, and a retry loop
// against one earns a rate limit on top of the original problem.
func TestAuthErrorIsTerminal(t *testing.T) {
	if (&AuthError{Provider: "claudecode"}).Retryable() {
		t.Error("Retryable() = true, want false")
	}
}

// Unwrap keeps the originating error reachable, so a caller that wants the
// transport-level cause still gets it.
func TestAuthErrorUnwrapsCause(t *testing.T) {
	cause := errors.New("underlying transport failure")
	err := &AuthError{Provider: "claudecode", Cause: cause}
	if !errors.Is(err, cause) {
		t.Errorf("errors.Is did not reach the cause through AuthError")
	}
	if (&AuthError{Provider: "claudecode"}).Unwrap() != nil {
		t.Error("Unwrap() on a causeless AuthError should be nil")
	}
}
