//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import "strings"

// ModelContextWindows maps Anthropic model names to their context window sizes (in tokens)
// These values are based on official Anthropic documentation as of 2025
var ModelContextWindows = map[string]int{
	// Claude 3.5 Sonnet (current default)
	"claude-3-5-sonnet-20241022": 200000,
	"claude-3-5-sonnet-20240620": 200000,

	// Claude Sonnet 4 Series
	"claude-sonnet-4":   200000, // Standard: 200K, Beta (tier 4): 1M
	"claude-sonnet-4.5": 200000, // Standard: 200K, Beta (tier 4): 1M
	"claude-4-sonnet":   200000,
	"claude-4.5-sonnet": 200000,

	// Claude 3 Opus
	"claude-3-opus-20240229": 200000,
	"claude-3-opus":          200000,

	// Claude 3 Sonnet
	"claude-3-sonnet-20240229": 200000,
	"claude-3-sonnet":          200000,

	// Claude 3 Haiku
	"claude-3-haiku-20240307": 200000,
	"claude-3-haiku":          200000,

	// Claude 3.5 Haiku
	"claude-3-5-haiku-20241022": 200000,
	"claude-3-5-haiku":          200000,
}

// DefaultContextWindow is the fallback context window if model is not found
const DefaultContextWindow = 200000

// GetContextWindow returns the context window for a given model
// Returns DefaultContextWindow if the model is not found
func GetContextWindow(model string) int {
	if window, ok := ModelContextWindows[model]; ok {
		return window
	}
	return DefaultContextWindow
}

// GetMaxOutputTokens returns the maximum number of output tokens a model can
// emit in a single response — the value to send as the request's max_tokens.
// Anthropic rejects max_tokens above a model's ceiling (a hard 400) and silently
// truncates at it otherwise, so this must be per-model rather than a fixed cap.
//
// Detection is by substring rather than exact map lookup because the Models API
// hands back dated ids (claude-sonnet-4-5-20250929) that an exact map would miss,
// and because the catalog uses two naming orders (claude-sonnet-4.5 and
// claude-4.5-sonnet). Order matters: the most specific generations are checked
// first, since "claude-3-5-sonnet" also contains "claude-3".
//
// Ceilings (Anthropic docs): Opus 4.x → 32000; Sonnet/Haiku 4.x and Sonnet 3.7 →
// 64000; Sonnet/Haiku 3.5 → 8192; Claude 3 (non-3.5) → 4096. Unknown/future ids
// fall back to defaultMaxOutputTokens, which is at or below every known model's
// ceiling so an unrecognised id can never produce a max_tokens 400.
func GetMaxOutputTokens(model string) int {
	m := strings.ToLower(model)

	isOpus := strings.Contains(m, "opus")
	isSonnet := strings.Contains(m, "sonnet")
	isHaiku := strings.Contains(m, "haiku")

	// Generation 4 appears either family-first ("sonnet-4", "sonnet-4.5",
	// "sonnet-4-5", "opus-4-1") or version-first in the short aliases
	// ("4-sonnet", "4.5-sonnet").
	gen4 := func(family string) bool {
		return strings.Contains(m, family+"-4") ||
			strings.Contains(m, "4-"+family) ||
			strings.Contains(m, "4.0-"+family) ||
			strings.Contains(m, "4.1-"+family) ||
			strings.Contains(m, "4.5-"+family)
	}

	switch {
	case isOpus && gen4("opus"):
		return 32000
	case isSonnet && gen4("sonnet"):
		return 64000
	case isHaiku && gen4("haiku"):
		return 64000
	case strings.Contains(m, "3-7-sonnet") || strings.Contains(m, "claude-3.7"):
		return 64000
	case strings.Contains(m, "3-5-") || strings.Contains(m, "claude-3.5"):
		return 8192
	case strings.Contains(m, "claude-3"):
		return 4096
	default:
		return defaultMaxOutputTokens
	}
}

// SupportsThinking reports whether an Anthropic model supports extended
// thinking (a reasoning budget). Claude 3.7 Sonnet and all Claude 4.x models
// do; the original Claude 3 and Claude 3.5 models do not. Substring match so
// dated API ids (claude-sonnet-4-5-20250929, claude-3-7-sonnet-20250219) are
// covered.
func SupportsThinking(model string) bool {
	m := strings.ToLower(model)
	if strings.Contains(m, "3-7-sonnet") || strings.Contains(m, "claude-3.7") {
		return true
	}
	// Claude 4.x, family-first ("sonnet-4", "opus-4-1", "sonnet-4-5") and the
	// version-first short aliases ("claude-4-sonnet", "claude-4.5-sonnet").
	markers := []string{
		"sonnet-4", "opus-4", "haiku-4",
		"4-sonnet", "4-opus", "4-haiku",
		"4.5-sonnet", "4.5-opus", "4.5-haiku", "4.1-opus",
	}
	for _, marker := range markers {
		if strings.Contains(m, marker) {
			return true
		}
	}
	return false
}

// SupportsImageInput reports whether an Anthropic model accepts image input.
// Every Claude 3.x and Claude 4.x model is multimodal; older text-only models
// (Claude 2, instant) are not in our catalog. Conservative substring match so
// dated API ids (e.g. claude-3-5-sonnet-20241022, claude-sonnet-4-5-20250929)
// are covered.
func SupportsImageInput(model string) bool {
	m := strings.ToLower(model)
	markers := []string{
		"claude-3", "claude-4",
		"sonnet-4", "opus-4", "haiku-4",
	}
	for _, marker := range markers {
		if strings.Contains(m, marker) {
			return true
		}
	}
	return false
}
