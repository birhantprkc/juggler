//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"strings"

	provider "juggler/cmd/juggler/providers/registry"
)

// ThinkingSpec describes a model's reasoning-effort support in the canonical
// thinking vocabulary. The zero value (nil Effort) means the model exposes no
// reasoning control and the UI hides the selector.
type ThinkingSpec struct {
	// Levels are the canonical levels advertised to the UI, in display order
	// (a subset of off/low/medium/high/max).
	Levels []string
	// Default is the canonical level the model uses when a turn carries none
	// (presentation only, so the UI can label "Default (medium)").
	Default string
	// Effort maps each supported canonical level to the native reasoning_effort
	// string to send on the wire. A canonical level absent here is unsupported:
	// a request carrying it omits the reasoning param.
	Effort map[string]string
}

// ThinkingSpecFunc returns the ThinkingSpec for a model id. A nil func (or a
// zero ThinkingSpec) means the provider exposes no reasoning control.
type ThinkingSpecFunc func(modelID string) ThinkingSpec

// effortFor maps a canonical level to the native reasoning_effort to send.
// ok=false means omit the reasoning param entirely — the level is absent,
// unsupported by this model, or unknown — which preserves today's default
// request shape byte-for-byte.
func (s ThinkingSpec) effortFor(level string) (string, bool) {
	level = provider.NormalizeThinkingLevel(level)
	if level == "" || len(s.Effort) == 0 {
		return "", false
	}
	effort, ok := s.Effort[level]
	return effort, ok
}

// OpenAIThinkingSpec classifies an OpenAI / OpenAI-Codex model id into its
// reasoning-effort support, expressed in the canonical thinking vocabulary.
// Non-reasoning models (gpt-4o, gpt-4, gpt-3.5) return the zero ThinkingSpec.
//
// The canonical→native maps are deliberately conservative: the valid set of
// reasoning_effort values differs by model family and a wrong value is a hard
// 400, so a model we can't confidently classify gets no control (no param sent)
// rather than a guessed value. This is the single source of truth shared by the
// openai and openaicodex providers.
func OpenAIThinkingSpec(modelID string) ThinkingSpec {
	m := strings.ToLower(modelID)

	// Codex reasoning models (gpt-5.x-codex, codex-max, bare "codex" slugs).
	// They accept low/medium/high; codex-max style models add an "xhigh" tier.
	// "off" is intentionally not offered — codex reasons on every turn.
	if strings.Contains(m, "codex") {
		levels := []string{provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh}
		effort := map[string]string{
			provider.ThinkingLow:    "low",
			provider.ThinkingMedium: "medium",
			provider.ThinkingHigh:   "high",
		}
		if strings.Contains(m, "codex-max") || strings.Contains(m, "5.2-codex") {
			levels = append(levels, provider.ThinkingMax)
			effort[provider.ThinkingMax] = "xhigh"
		}
		return ThinkingSpec{Levels: levels, Default: provider.ThinkingMedium, Effort: effort}
	}

	// GPT-5 family (gpt-5, gpt-5-mini/nano, gpt-5.1, gpt-5.1-thinking, gpt-5.6…).
	// gpt-5.1+ accept an explicit "none" for fully-off; earlier gpt-5 map "off"
	// to the always-safe "minimal". No family member exposes "xhigh", so "max"
	// caps at "high".
	if strings.HasPrefix(m, "gpt-5") {
		off := "minimal"
		if strings.HasPrefix(m, "gpt-5.1") || strings.HasPrefix(m, "gpt-5.2") || strings.HasPrefix(m, "gpt-5.6") {
			off = "none"
		}
		return ThinkingSpec{
			Levels:  []string{provider.ThinkingOff, provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh, provider.ThinkingMax},
			Default: provider.ThinkingMedium,
			Effort: map[string]string{
				provider.ThinkingOff:    off,
				provider.ThinkingLow:    "low",
				provider.ThinkingMedium: "medium",
				provider.ThinkingHigh:   "high",
				provider.ThinkingMax:    "high",
			},
		}
	}

	// o-series reasoning models (o1, o3, o3-mini, o4-mini). These accept only
	// low/medium/high — no "minimal"/"none"/"xhigh". o1-mini and o1-preview do
	// not accept reasoning_effort and are excluded.
	if isOSeriesReasoning(m) {
		return ThinkingSpec{
			Levels:  []string{provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh},
			Default: provider.ThinkingMedium,
			Effort: map[string]string{
				provider.ThinkingLow:    "low",
				provider.ThinkingMedium: "medium",
				provider.ThinkingHigh:   "high",
			},
		}
	}

	return ThinkingSpec{}
}

// isOSeriesReasoning reports whether a (lower-cased) model id is an o-series
// reasoning model that accepts reasoning_effort. Includes o1, o3, o3-mini and
// o4-mini (and their dated ids); excludes o1-mini / o1-preview, which don't.
func isOSeriesReasoning(m string) bool {
	switch {
	case m == "o1" || strings.HasPrefix(m, "o1-2"):
		return true
	case m == "o3" || strings.HasPrefix(m, "o3-2") || strings.HasPrefix(m, "o3-mini"):
		return true
	case strings.HasPrefix(m, "o4-mini"):
		return true
	default:
		return false
	}
}
