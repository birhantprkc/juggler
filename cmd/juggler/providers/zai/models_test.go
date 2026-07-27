//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"slices"
	"testing"
)

// TestGLMOutputCapHasReasoningHeadroom guards that GLM's output cap leaves room
// for chain-of-thought. GLM is a reasoning model: it spends output budget
// thinking before it answers. The original flat 8192 cap throttled the
// reasoning itself, yielding empty `finish=length` turns that the worker
// silently retried — minutes of dead "Receiving". The cap must be well above
// 8192 yet stay within z.ai's documented per-model maxima (GLM-4.6 128K,
// GLM-4.5 96K) and the coding-plan ceiling (~98K).
func TestGLMOutputCapHasReasoningHeadroom(t *testing.T) {
	cases := []struct {
		model   string
		atLeast int
		atMost  int
	}{
		{"glm-4.6", 32768, 98304},
		{"glm-4.5", 32768, 98304},
		{"glm-4.7", 32768, 98304},
		{"glm-5.2", 16384, 98304}, // unknown/newer → generous default, still bounded
		{"glm-4-flash", 16384, 98304},
	}
	for _, tc := range cases {
		got := maxOutputCaps.Lookup(tc.model)
		if got < tc.atLeast {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want >= %d (reasoning needs headroom)", tc.model, got, tc.atLeast)
		}
		if got > tc.atMost {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want <= %d (within plan/model ceiling)", tc.model, got, tc.atMost)
		}
	}
}

// TestContextWindowDefaultsToModernCatalog guards the window sizing: the whole
// current z.ai catalog is 200K except the glm-4.5 series (128K), so the default
// is optimistic (200K) and only off-default models carry an override. A new
// model the API starts advertising therefore inherits 200K, not a stale 128K.
// GLM-5.2 overrides upward: it serves a 1M window under its plain base id over
// the standard coding endpoint (verified on the wire — see models.go).
func TestContextWindowDefaultsToModernCatalog(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"glm-4.6", 200000},      // default
		{"glm-4.7", 200000},      // default
		{"glm-5.1", 200000},      // default
		{"glm-5.2", 1000000},     // override → 1M window on the base id
		{"glm-9-future", 200000}, // unknown → default
		{"glm-4.5", 128000},      // override
		{"glm-4.5-air", 128000},  // override
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("contextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestThinkingSpec pins the reasoning-effort selector to GLM-5.2+: those models
// advertise the three distinct tiers (none/high/max, default max), while
// earlier GLM releases expose no control — sending them reasoning_effort would
// be rejected. A forward-dated major (glm-6) inherits the selector.
func TestThinkingSpec(t *testing.T) {
	withSelector := []string{"glm-5.2", "glm-6", "glm-6.1-air"}
	for _, m := range withSelector {
		spec := thinkingSpec(m)
		if !slices.Equal(spec.Levels, []string{"none", "high", "max"}) {
			t.Errorf("thinkingSpec(%q).Levels = %v, want [none high max]", m, spec.Levels)
		}
		if spec.Default != "max" {
			t.Errorf("thinkingSpec(%q).Default = %q, want max", m, spec.Default)
		}
	}
	noSelector := []string{"glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-flash"}
	for _, m := range noSelector {
		if spec := thinkingSpec(m); len(spec.Levels) != 0 {
			t.Errorf("thinkingSpec(%q).Levels = %v, want empty (reasoning_effort unsupported)", m, spec.Levels)
		}
	}
}

// TestGLMVersion pins the version parser that gates the selector: dotted and
// bare versions, suffixed variants, and non-GLM / unparseable ids.
func TestGLMVersion(t *testing.T) {
	cases := []struct {
		model        string
		major, minor int
		ok           bool
	}{
		{"glm-5.2", 5, 2, true},
		{"glm-4.5-air", 4, 5, true},
		{"glm-5", 5, 0, true},
		{"glm-4.6", 4, 6, true},
		{"glm-6", 6, 0, true},
		{"GLM-5.2", 5, 2, true},  // case-insensitive
		{"gpt-5", 0, 0, false},   // wrong prefix
		{"glm-air", 0, 0, false}, // no numeric version
		{"", 0, 0, false},
	}
	for _, tc := range cases {
		major, minor, ok := glmVersion(tc.model)
		if major != tc.major || minor != tc.minor || ok != tc.ok {
			t.Errorf("glmVersion(%q) = (%d, %d, %v), want (%d, %d, %v)",
				tc.model, major, minor, ok, tc.major, tc.minor, tc.ok)
		}
	}
}
