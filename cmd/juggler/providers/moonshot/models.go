//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// The model *list* is never hardcoded — ListModelsWithInfo pulls it live from
// Moonshot's /v1/models endpoint, so new Kimi releases appear automatically.
// What lives here is the per-model capability metadata that endpoint does NOT
// return: context window, output cap, image support and reasoning support. The
// maps are keyed by exact model id; anything unlisted falls back to the
// defaults, which are tuned to the modern Kimi line.

// ModelContextWindows overrides DefaultContextWindow for models whose window is
// not the default. Kimi K3 is the 1M-token flagship; the K2.x line is 256K; the
// legacy moonshot-v1-* series carries its size in the id (sunsetting).
var ModelContextWindows = map[string]int{
	"kimi-k3":                         1000000,
	"kimi-k2.7-code":                  256000,
	"kimi-k2.7-code-highspeed":        256000,
	"kimi-k2.6":                       256000,
	"kimi-k2.5":                       256000,
	"moonshot-v1-8k":                  8000,
	"moonshot-v1-32k":                 32000,
	"moonshot-v1-128k":                128000,
	"moonshot-v1-8k-vision-preview":   8000,
	"moonshot-v1-32k-vision-preview":  32000,
	"moonshot-v1-128k-vision-preview": 128000,
}

// DefaultContextWindow is used for unknown models. The current Kimi catalog
// (kimi-latest, kimi-k2*) sits at 128K or above, so an unlisted id is far more
// likely 128K than the tiny legacy sizes; a conservative-but-modern default
// avoids over-promising context on a small model while still fitting new Kimis.
const DefaultContextWindow = 128000

// ModelMaxOutputTokens overrides DefaultMaxOutputTokens per model. Two cases:
//   - Reasoning models (kimi-k3) spend output budget thinking before they
//     answer, so they need headroom well above the default — an 8K cap would
//     throttle the reasoning itself and yield empty `finish=length` turns.
//   - The small legacy moonshot-v1 windows can't fit the default output cap
//     alongside any input, so their cap is pinned below the window.
var ModelMaxOutputTokens = map[string]int{
	"kimi-k3":                        131072,
	"moonshot-v1-8k":                 4096,
	"moonshot-v1-8k-vision-preview":  4096,
	"moonshot-v1-32k":                16384,
	"moonshot-v1-32k-vision-preview": 16384,
}

// DefaultMaxOutputTokens is the per-request output cap for models without an
// override. Sits well above the old flat 8192 so the long-context Kimi models
// aren't truncated mid-answer, while staying under the 128K/1M windows.
const DefaultMaxOutputTokens = 32768

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the tests and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// isChatModel admits Moonshot's chat models — the kimi-* and moonshot-* lines —
// while dropping any non-chat endpoints (embeddings) that /v1/models may list.
func isChatModel(modelID string) bool {
	id := strings.ToLower(modelID)
	if !strings.HasPrefix(id, "kimi-") && !strings.HasPrefix(id, "moonshot-") {
		return false
	}
	for _, marker := range []string{"embedding", "tts", "audio"} {
		if strings.Contains(id, marker) {
			return false
		}
	}
	return true
}

// inputModalities reports the input modalities for a Moonshot model id. The
// flagship kimi-k3, the K2.5/K2.6/K2.7 line, and every -vision- variant accept
// image input; the plain legacy moonshot-v1-* models are text-only.
func inputModalities(modelID string) []string {
	if supportsVision(modelID) {
		return []string{"text", "image"}
	}
	return nil
}

// supportsVision reports whether a Moonshot model accepts image input.
func supportsVision(modelID string) bool {
	m := strings.ToLower(modelID)
	switch {
	case strings.Contains(m, "vision"):
		return true
	case strings.HasPrefix(m, "kimi-k3"),
		strings.HasPrefix(m, "kimi-k2.5"),
		strings.HasPrefix(m, "kimi-k2.6"),
		strings.HasPrefix(m, "kimi-k2.7"):
		return true
	default:
		return false
	}
}

// thinkingSpec classifies a Moonshot model's reasoning-effort support. Only
// Kimi K3 drives reasoning through the OpenAI-shaped `reasoning_effort` field,
// and it currently accepts a single value ("max"), so it advertises a one-level
// selector. The K2.x thinking models use a separate Moonshot-specific `thinking`
// shape that openaibase does not emit, so exposing a reasoning_effort selector
// for them would send a param the API rejects — they get the zero spec (no
// control). Legacy moonshot-v1-* models don't reason at all.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	if strings.HasPrefix(strings.ToLower(modelID), "kimi-k3") {
		return openaibase.EffortSpec("max", "max")
	}
	return openaibase.ThinkingSpec{}
}
