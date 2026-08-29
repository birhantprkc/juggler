//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import "fmt"

// AuthError reports a provider refusing a request because its credentials are
// not usable — expired, revoked, or never established.
//
// It exists as its own type because authentication is the one terminal failure
// class the user can always fix, and the fix is provider-specific: an API-key
// provider wants a key in settings, a CLI-backed one wants a login inside that
// CLI. Reported as a generic terminal error, it reaches the user as whatever
// wording the provider happened to choose — written for someone standing at that
// provider's own command line, not for someone reading a transcript.
//
// Producing one is a claim that the credential is at fault, so providers raise it
// only on an explicit signal (an HTTP 401, or their own unambiguous auth text),
// never on a bare failure.
type AuthError struct {
	// Provider is the registry name of the provider that refused, e.g.
	// "claudecode". Reporters use it to name the right settings entry.
	Provider string

	// Status is the HTTP status the provider reported, or 0 when the failure
	// arrived as text with no status attached — which happens whenever the
	// refusal is raised by a CLI before it reaches the API.
	Status int

	// Message is the provider's own account of the failure, verbatim. A
	// credential failure is barely diagnosable without it, so it is carried
	// separately from Hint and never rewritten.
	Message string

	// Hint is the remediation, phrased for the person who has to perform it.
	// Only the provider knows where its credentials live and what re-establishes
	// them, so only the provider can write this sentence.
	Hint string

	// Cause retains the originating error where there is one.
	Cause error
}

func (e *AuthError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Status != 0 {
		return fmt.Sprintf("%s rejected the request as unauthenticated (HTTP %d)", e.Provider, e.Status)
	}
	return fmt.Sprintf("%s rejected the request as unauthenticated", e.Provider)
}

// Unwrap exposes the originating error so the usual chain walkers keep working.
func (e *AuthError) Unwrap() error { return e.Cause }

// Retryable marks this terminal for generic classifiers. Retrying is pointless
// until a human re-establishes the credential, and a retry loop against an
// expired login is how a rate limit gets earned on top of the original problem.
func (e *AuthError) Retryable() bool { return false }
