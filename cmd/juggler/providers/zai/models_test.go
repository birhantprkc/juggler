//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import "testing"

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
// is optimistic (200K) and only the smaller models carry an override. A new
// model the API starts advertising therefore inherits 200K, not a stale 128K.
// GLM-5.2's base id is 200K too — its 1M window is opt-in, requested by
// appending "[1m]" to the id (see models.go), so only that variant overrides.
func TestContextWindowDefaultsToModernCatalog(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"glm-4.6", 200000},      // default
		{"glm-4.7", 200000},      // default
		{"glm-5.1", 200000},      // default
		{"glm-5.2", 200000},      // base id → default; 1M is opt-in via [1m]
		{"glm-5.2[1m]", 1000000}, // opt-in 1M variant
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
