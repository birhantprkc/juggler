//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"slices"
	"testing"

	"juggler/cmd/juggler/providers/provider"
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

// TestThinkingSpecNativeLevels pins the thinking contract: each model advertises
// its native reasoning_effort levels directly (the level name IS the wire value),
// DeepSeek V4 exposes high/xhigh, and everything else low/medium/high.
func TestThinkingSpecNativeLevels(t *testing.T) {
	ds := thinkingSpec("deepseek-v4-pro")
	if !slices.Equal(ds.Levels, []string{"high", "xhigh"}) {
		t.Errorf("deepseek-v4 levels = %v, want [high xhigh]", ds.Levels)
	}
	if ds.Default != "high" {
		t.Errorf("deepseek-v4 default = %q, want high", ds.Default)
	}

	for _, model := range []string{"gpt-5", "claude-opus-4-5", "glm-5"} {
		spec := thinkingSpec(model)
		if !slices.Equal(spec.Levels, []string{"low", "medium", "high"}) {
			t.Errorf("thinkingSpec(%q) levels = %v, want [low medium high]", model, spec.Levels)
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
