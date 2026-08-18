//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"strconv"
	"strings"
)

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
	if value, known := catalogMaxOutputTokens(model); known {
		return value
	}
	return defaultMaxOutputTokens
}

// catalogMaxOutputTokens returns the per-model output ceiling and true when the
// static catalog recognises the model's generation, or (0, false) for ids it
// does not know (live-list-only or future models). It exists so callers can
// distinguish a genuinely-known 8192 ceiling (Claude 3.5) from an unknown id
// that merely defaults to 8192 — GetMaxOutputTokens collapses both, but the
// wire clamp in buildMessageParams must only override the capability snapshot
// when the catalog actually knows the model.
func catalogMaxOutputTokens(model string) (int, bool) {
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
		return 32000, true
	case isSonnet && gen4("sonnet"):
		return 64000, true
	case isHaiku && gen4("haiku"):
		return 64000, true
	case strings.Contains(m, "3-7-sonnet") || strings.Contains(m, "claude-3.7"):
		return 64000, true
	case strings.Contains(m, "3-5-") || strings.Contains(m, "claude-3.5"):
		return 8192, true
	case strings.Contains(m, "claude-3"):
		return 4096, true
	default:
		return 0, false
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

// thinkingMode names the wire form a model accepts for extended thinking. The
// zero value is the adaptive form, which is what an unrecognised id gets — see
// thinkingModeForModel for why that direction is the safe one.
type thinkingMode int

const (
	// thinkingAdaptive is thinking.type "adaptive", steered by
	// output_config.effort. Generation 4.6 and later.
	thinkingAdaptive thinkingMode = iota
	// thinkingLegacy is thinking.type "enabled" with an explicit budget_tokens.
	// Generation 4.5 and earlier.
	thinkingLegacy
)

// thinkingModeForModel reports which thinking wire form a model accepts.
// Anthropic split the API at generation 4.6: 4.5 and earlier accept only the
// manual form (thinking.type "enabled" with budget_tokens) and reject
// "adaptive" with a 400, while 4.7 and later accept only "adaptive" and reject
// "enabled" with a 400. Generation 4.6 accepts both and documents "enabled" as
// deprecated, so it takes the adaptive path along with everything newer.
//
// An id carrying no recognisable generation falls to adaptive. The set of models
// needing the manual form is closed — it ends at 4.5, and Anthropic adds only
// newer models — while ids keep arriving from the live Models API, so an
// unrecognised id is far likelier to be newer than older. Defaulting the other
// way would hand every future model the 400 this mapping exists to avoid.
//
// Callers reach this only for models SupportsThinking already accepts; models
// with no thinking at all never consult it.
func thinkingModeForModel(model string) thinkingMode {
	major, minor, ok := claudeVersion(model)
	switch {
	case !ok:
		return thinkingAdaptive
	case major > 4, major == 4 && minor >= 6:
		return thinkingAdaptive
	default:
		return thinkingLegacy
	}
}

// claudeVersion extracts the numeric major.minor generation from an Anthropic
// model id ("claude-sonnet-4-5-20250929" → 4, 5; "claude-opus-4-6" → 4, 6;
// "claude-3-7-sonnet-20250219" → 3, 7; "claude-sonnet-5" → 5, 0). Ids name the
// generation either family-first ("sonnet-4-5") or version-first ("3-7-sonnet"),
// separated by dashes or by a dot ("claude-4.5-sonnet"), so the first numeric
// token is the major and a numeric token immediately after it is the minor.
// A run of more than two digits is a release date rather than a version, and is
// skipped. ok is false for ids naming no generation at all
// ("claude-mythos-preview").
func claudeVersion(model string) (major, minor int, ok bool) {
	tokens := strings.Split(strings.ToLower(model), "-")
	for i, token := range tokens {
		head, tail, dotted := strings.Cut(token, ".")
		value, isVersion := versionNumber(head)
		if !isVersion {
			continue
		}
		major = value
		// A dotted token carries both parts ("4.5"); a bare one carries the
		// major, with any minor in the token that follows ("4", "5").
		if dotted {
			minor, _ = versionNumber(tail)
			return major, minor, true
		}
		if i+1 < len(tokens) {
			if next, isMinor := versionNumber(tokens[i+1]); isMinor {
				minor = next
			}
		}
		return major, minor, true
	}
	return 0, 0, false
}

// versionNumber parses one version component. Components are one or two digits;
// a longer run of digits is a release date (20250929), never a version.
func versionNumber(token string) (int, bool) {
	if token == "" || len(token) > 2 {
		return 0, false
	}
	value, err := strconv.Atoi(token)
	if err != nil {
		return 0, false
	}
	return value, true
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
