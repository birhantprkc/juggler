//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

import "juggler/cmd/juggler/providers/provider"

// LimitSource names where a model's token limits were established. It travels
// with the numbers so the difference between "the endpoint told us 1M" and "we
// assumed 128k" survives all the way to the settings UI, instead of both
// arriving as an int nobody can question.
type LimitSource string

const (
	// LimitSourceUnknown is the zero value: nothing established this limit.
	LimitSourceUnknown LimitSource = ""
	// LimitSourceEndpoint means the provider's own model listing reported it.
	// This is the only source that describes the server that will serve the
	// request, so it outranks everything except the user.
	LimitSourceEndpoint LimitSource = "endpoint"
	// LimitSourceCatalog means a built-in per-model entry supplied it, because
	// the endpoint publishes no limits (OpenAI, DeepSeek and z.ai all return
	// bare ids) or could not be reached.
	LimitSourceCatalog LimitSource = "catalog"
	// LimitSourceDefault means neither of the above knew this model, and a
	// provider-wide fallback was used. It is a guess, and the one source worth
	// showing a user as such.
	LimitSourceDefault LimitSource = "default"
	// LimitSourceOverride means the user set the number by hand
	// (models.limits in the global settings), which outranks every other source.
	LimitSourceOverride LimitSource = "override"
)

// Limits is a model's resolved token limits together with where they came from.
// A non-positive value means unknown — never zero tokens.
type Limits struct {
	ContextWindow int
	MaxOutput     int
	// Source describes ContextWindow, which is the number that decides when a
	// conversation compacts and is therefore the one worth attributing.
	Source LimitSource
}

// ClampOutputToWindow returns the output cap to use for a model with the given
// window, substituting the shared derived reserve when the reported cap cannot
// be right.
//
// Two inputs get replaced, for the same reason. A cap at or above the window
// leaves nothing for input, so the provider rejects every request — and such a
// value is a catalog artifact rather than a limit (some OpenRouter entries
// report max_completion_tokens equal to context_length). A cap of zero is
// simply absent. In both cases the honest answer is the conservative reserve
// derived from the window, which is what admission would charge anyway.
//
// An unknown window has nothing to clamp against, so the cap passes through
// untouched: whether it is usable is not a question this function can answer.
func ClampOutputToWindow(window, maxOutput int) int {
	if window <= 0 {
		return maxOutput
	}
	if maxOutput <= 0 || maxOutput >= window {
		return int(provider.ContextSafetyReserve(int64(window)))
	}
	return maxOutput
}
