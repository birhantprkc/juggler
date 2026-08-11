//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import "strings"

// transientMarkers are the substrings identifying a provider failure that a
// fresh attempt usually clears, in two families:
//
//   - Transport — the stream stalled or the connection dropped mid-response
//     (StallError builds these, so the text is a contract, not a guess).
//   - Upstream capacity — the provider is momentarily overloaded or
//     unavailable: Anthropic's service_unavailable_error / server_is_overloaded
//     (HTTP 503/529), and the equivalent gateway errors other providers return.
//
// Matched as lowercase substrings against the whole error text because the
// providers surface these as opaque JSON bodies, not typed errors.
//
// Deliberately narrow. Bare status numbers are NOT matched — "503" appears in
// token counts, ids, and file paths — and neither is any message that could
// mean genuine quota exhaustion ("exited unexpectedly", "try again later"),
// which retrying would only paper over.
var transientMarkers = []string{
	StallMarker,
	StallDroppedMarker,
	"overloaded",
	"service unavailable",
	"service_unavailable",
	"bad gateway",
	"gateway timeout",
	"temporarily unavailable",
}

// TransientMessage reports whether a provider error string describes a failure
// worth retrying transparently after a short backoff. It is the single
// classifier every retry site shares — the worker's turn loop (isTransientMsg,
// via classifyLLMError) and the out-of-band callers on QuickComplete — so a
// newly-recognised transient shape is added here once and every caller inherits
// it. See transientMarkers for what qualifies and what deliberately doesn't.
func TransientMessage(msg string) bool {
	lower := strings.ToLower(msg)
	for _, marker := range transientMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}
