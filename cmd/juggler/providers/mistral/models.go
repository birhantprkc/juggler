//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// The model list is never hardcoded — ListModelsWithInfo pulls it live from
// Mistral's /v1/models endpoint, so new releases appear automatically. What
// lives here is the per-model capability metadata that endpoint does NOT
// return: context window, output cap, image support and reasoning support.
// Anything unlisted falls back to the defaults.

// ModelContextWindows maps Mistral model names to context window sizes (tokens).
// Source: https://mistral.ai/models and the /v1/models API endpoint.
var ModelContextWindows = map[string]int{
	"codestral-latest":        256000,
	"devstral-medium-latest":  262144,
	"magistral-medium-latest": 131072,
	"magistral-small-latest":  262144,
	"ministral-3b-latest":     131072,
	"ministral-8b-latest":     262144,
	"ministral-14b-latest":    262144,
	"mistral-large-latest":    262144,
	"mistral-medium-latest":   131072,
	"mistral-small-latest":    262144,
	"mistral-tiny-latest":     131072,
}

// DefaultContextWindow is used for unknown Mistral models.
const DefaultContextWindow = 131072

// DefaultMaxOutputTokens is the per-request output cap for Mistral models.
const DefaultMaxOutputTokens = 16384

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the tests and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens}
)

// thinkingSpec classifies a Mistral model's reasoning-effort support. Only
// Magistral models expose reasoning through the OpenAI-shaped reasoning_effort
// field, with low/medium/high levels. All other Mistral models return the zero
// spec (no reasoning control).
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	if strings.HasPrefix(strings.ToLower(modelID), "magistral") {
		return openaibase.EffortSpec("medium", "low", "medium", "high")
	}
	return openaibase.ThinkingSpec{}
}
