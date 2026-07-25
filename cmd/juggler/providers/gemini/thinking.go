//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import (
	"strings"
)

// thinkingSpec describes a Gemini model's thinking-budget support in its own
// native level names. The zero value (nil budgets) ⇒ no thinking control.
type thinkingSpec struct {
	levels  []string         // native levels advertised, in display order
	def     string           // default level (presentation only)
	budgets map[string]int32 // level name → thinkingBudget tokens
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
			levels: []string{"low", "medium", "high", "max"},
			def:    "",
			budgets: map[string]int32{
				"low":    2048,
				"medium": 8192,
				"high":   16384,
				"max":    32768,
			},
		}
	}
	// Flash / Flash-Lite: budget 0 disables (so "off" is a real, enforceable
	// choice); max budget 24576. The default budget is dynamic (the model
	// decides), not off, so def is left empty ⇒ the UI shows a plain "Default".
	return thinkingSpec{
		levels: []string{"off", "low", "medium", "high", "max"},
		def:    "",
		budgets: map[string]int32{
			"off":    0,
			"low":    2048,
			"medium": 8192,
			"high":   16384,
			"max":    24576,
		},
	}
}

// budgetFor returns the thinkingBudget for a level, and ok=false when the level
// is absent/unsupported (⇒ leave ThinkingConfig unset, provider default). The
// advertised budgets map is the only gate: a level is valid iff it is a key.
func (s thinkingSpec) budgetFor(level string) (int32, bool) {
	if level == "" || s.budgets == nil {
		return 0, false
	}
	b, ok := s.budgets[level]
	return b, ok
}
