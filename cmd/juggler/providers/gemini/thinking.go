//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"strings"

	provider "juggler/cmd/juggler/providers/registry"
)

// thinkingSpec describes a Gemini model's thinking-budget support in the
// canonical vocabulary. The zero value (nil budgets) ⇒ no thinking control.
type thinkingSpec struct {
	levels  []string         // canonical levels advertised, in display order
	def     string           // canonical default level (presentation only)
	budgets map[string]int32 // canonical level → thinkingBudget tokens
}

// geminiThinkingSpecFor classifies a Gemini model id into its thinking support.
// The 2.5 family reasons within a token budget: Flash / Flash-Lite can disable
// it (budget 0 ⇒ "off"), while Pro always thinks (no "off"). Older families
// (2.0, 1.5) expose no thinking control. Model ids arrive as "models/gemini-…";
// the match is a lowercased substring so both bare and prefixed ids work.
func geminiThinkingSpecFor(model string) thinkingSpec {
	m := strings.ToLower(model)
	if !strings.Contains(m, "gemini-2.5") {
		return thinkingSpec{}
	}
	if strings.Contains(m, "pro") {
		// Pro cannot fully disable thinking; max budget 32768. The default budget
		// is dynamic (the model decides), not a fixed level, so def is left empty
		// ⇒ the UI shows a plain "Default".
		return thinkingSpec{
			levels: []string{provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh, provider.ThinkingMax},
			def:    "",
			budgets: map[string]int32{
				provider.ThinkingLow:    2048,
				provider.ThinkingMedium: 8192,
				provider.ThinkingHigh:   16384,
				provider.ThinkingMax:    32768,
			},
		}
	}
	// Flash / Flash-Lite: budget 0 disables (so "off" is a real, enforceable
	// choice); max budget 24576. The default budget is dynamic (the model
	// decides), not off, so def is left empty ⇒ the UI shows a plain "Default".
	return thinkingSpec{
		levels: []string{provider.ThinkingOff, provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh, provider.ThinkingMax},
		def:    "",
		budgets: map[string]int32{
			provider.ThinkingOff:    0,
			provider.ThinkingLow:    2048,
			provider.ThinkingMedium: 8192,
			provider.ThinkingHigh:   16384,
			provider.ThinkingMax:    24576,
		},
	}
}

// budgetFor returns the thinkingBudget for a canonical level, and ok=false when
// the level is absent/unsupported (⇒ leave ThinkingConfig unset, provider
// default).
func (s thinkingSpec) budgetFor(level string) (int32, bool) {
	level = provider.NormalizeThinkingLevel(level)
	if level == "" || s.budgets == nil {
		return 0, false
	}
	b, ok := s.budgets[level]
	return b, ok
}
