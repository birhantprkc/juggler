//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestContextWindow pins a few known windows across vendors and the
// unknown-model default.
func TestContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"claude-opus-4-5", 200000},
		{"claude-sonnet-4-5", 1000000},
		{"deepseek-v4-pro", 1000000},
		{"gpt-5", 400000},
		{"gemini-3-flash", 1048576},
		{"totally-unlisted-model", DefaultContextWindow}, // → default
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("contextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestOutputCapFitsWindow guards that no catalogued model's output cap exceeds
// its own context window (which would make max_tokens structurally impossible
// and 400 the request).
func TestOutputCapFitsWindow(t *testing.T) {
	for model := range ModelContextWindows {
		out := maxOutputCaps.Lookup(model)
		win := contextWindowCaps.Lookup(model)
		if out >= win {
			t.Errorf("maxOutput(%q) = %d must be < contextWindow %d (leave room for input)", model, out, win)
		}
	}
}

// TestThinkingSpecUsesCanonicalLevels pins the thinking contract: every
// advertised level is a canonical thinking token (off/low/medium/high/max) so
// it survives NormalizeThinkingLevel, and DeepSeek V4's top tier maps the
// canonical "max" level onto the native "xhigh" effort (not a bogus "xhigh"
// canonical level, which would be dropped and send no reasoning param).
func TestThinkingSpecUsesCanonicalLevels(t *testing.T) {
	canonical := map[string]bool{
		provider.ThinkingOff: true, provider.ThinkingLow: true, provider.ThinkingMedium: true,
		provider.ThinkingHigh: true, provider.ThinkingMax: true,
	}
	for _, model := range []string{"deepseek-v4-pro", "deepseek-v4-flash", "gpt-5", "claude-opus-4-5", "glm-5"} {
		spec := thinkingSpec(model)
		if len(spec.Levels) == 0 {
			t.Errorf("thinkingSpec(%q) advertised no levels", model)
		}
		for _, lvl := range spec.Levels {
			if !canonical[lvl] {
				t.Errorf("thinkingSpec(%q) advertises non-canonical level %q (would be dropped by NormalizeThinkingLevel)", model, lvl)
			}
			if _, ok := spec.Effort[lvl]; !ok {
				t.Errorf("thinkingSpec(%q) level %q has no native effort mapping", model, lvl)
			}
		}
	}

	// DeepSeek V4: canonical high→high, max→xhigh.
	ds := thinkingSpec("deepseek-v4-pro")
	if ds.Effort[provider.ThinkingHigh] != "high" {
		t.Errorf("deepseek-v4 Effort[high] = %q, want \"high\"", ds.Effort[provider.ThinkingHigh])
	}
	if ds.Effort[provider.ThinkingMax] != "xhigh" {
		t.Errorf("deepseek-v4 Effort[max] = %q, want \"xhigh\"", ds.Effort[provider.ThinkingMax])
	}

	// Everything else: standard low/medium/high.
	other := thinkingSpec("gpt-5")
	for lvl, want := range map[string]string{
		provider.ThinkingLow: "low", provider.ThinkingMedium: "medium", provider.ThinkingHigh: "high",
	} {
		if other.Effort[lvl] != want {
			t.Errorf("gpt-5 Effort[%q] = %q, want %q", lvl, other.Effort[lvl], want)
		}
	}
}

// TestCapabilitiesFailClosedOnUncataloguedModel pins the admission contract:
// catalogued ids resolve statically while user-invented aliases fail closed
// rather than inheriting the provider defaults.
func TestCapabilitiesFailClosedOnUncataloguedModel(t *testing.T) {
	Register()
	info, found := provider.GetProviderInfo("opencodezen")
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("opencodezen registration has no capability resolver")
	}
	got, found := info.ResolveModelCapabilities("deepseek-v4-pro")
	want := provider.ModelCapabilities{ContextWindowTokens: 1000000, MaxOutputTokens: 384000}
	if !found || got != want {
		t.Fatalf("deepseek-v4-pro capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if got, found := info.ResolveModelCapabilities("my-custom-model"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("custom alias capabilities = (%+v, %v), want zero, false", got, found)
	}
}
