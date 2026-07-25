//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestOpenAIThinkingSpec pins the per-family reasoning-effort classification and
// its native mapping — wrong values are hard 400s, so this is the single source
// of truth the tests guard.
func TestOpenAIThinkingSpec(t *testing.T) {
	cases := []struct {
		model       string
		wantLevels  []string
		wantEffort  map[string]string // canonical → native (spot checks)
		wantDefault string
		noControl   bool
	}{
		{
			model:       "gpt-5.1",
			wantLevels:  []string{"off", "low", "medium", "high", "max"},
			wantEffort:  map[string]string{"off": "none", "max": "high", "medium": "medium"},
			wantDefault: "medium",
		},
		{
			model:      "gpt-5", // pre-5.1: off → minimal, not none
			wantEffort: map[string]string{"off": "minimal", "high": "high"},
		},
		{
			model:      "gpt-5.2-codex", // codex-max style: adds xhigh, no off
			wantLevels: []string{"low", "medium", "high", "max"},
			wantEffort: map[string]string{"max": "xhigh", "low": "low"},
		},
		{
			model:      "o3-mini",
			wantLevels: []string{"low", "medium", "high"},
			wantEffort: map[string]string{"medium": "medium"},
		},
		{model: "gpt-4o", noControl: true},
		{model: "gpt-3.5-turbo", noControl: true},
		{model: "o1-mini", noControl: true}, // no reasoning_effort
	}
	for _, tc := range cases {
		spec := OpenAIThinkingSpec(tc.model)
		if tc.noControl {
			if len(spec.Levels) != 0 || len(spec.Effort) != 0 {
				t.Errorf("%s: expected no thinking control, got %+v", tc.model, spec)
			}
			continue
		}
		if tc.wantLevels != nil {
			if len(spec.Levels) != len(tc.wantLevels) {
				t.Errorf("%s: levels = %v, want %v", tc.model, spec.Levels, tc.wantLevels)
			} else {
				for i, l := range tc.wantLevels {
					if spec.Levels[i] != l {
						t.Errorf("%s: levels[%d] = %q, want %q", tc.model, i, spec.Levels[i], l)
					}
				}
			}
		}
		for level, want := range tc.wantEffort {
			if got := spec.Effort[level]; got != want {
				t.Errorf("%s: effort[%q] = %q, want %q", tc.model, level, got, want)
			}
		}
		if tc.wantDefault != "" && spec.Default != tc.wantDefault {
			t.Errorf("%s: default = %q, want %q", tc.model, spec.Default, tc.wantDefault)
		}
	}
}

// TestThinkingSpecOptions pins the advertised tier list: each option carries its
// canonical Value and native Label, and a level whose native effort duplicates an
// earlier one is dropped from the advertised set (but stays wire-mappable).
func TestThinkingSpecOptions(t *testing.T) {
	cases := []struct {
		model string
		want  []provider.ThinkingOption
	}{
		{
			// codex-max style: low/medium/high + native "xhigh"; no "off".
			model: "gpt-5.2-codex",
			want: []provider.ThinkingOption{
				{Value: "low", Label: "low"},
				{Value: "medium", Label: "medium"},
				{Value: "high", Label: "high"},
				{Value: "max", Label: "xhigh"},
			},
		},
		{
			// gpt-5.1: "none" off label, and no phantom "max" (its native "high"
			// duplicates the "high" tier, so it's de-duped away).
			model: "gpt-5.1",
			want: []provider.ThinkingOption{
				{Value: "off", Label: "none"},
				{Value: "low", Label: "low"},
				{Value: "medium", Label: "medium"},
				{Value: "high", Label: "high"},
			},
		},
		{
			// earlier gpt-5: off maps to native "minimal"; "max" still de-duped.
			model: "gpt-5",
			want: []provider.ThinkingOption{
				{Value: "off", Label: "minimal"},
				{Value: "low", Label: "low"},
				{Value: "medium", Label: "medium"},
				{Value: "high", Label: "high"},
			},
		},
		{
			// o-series: native names equal canonical; labels present but harmless.
			model: "o3-mini",
			want: []provider.ThinkingOption{
				{Value: "low", Label: "low"},
				{Value: "medium", Label: "medium"},
				{Value: "high", Label: "high"},
			},
		},
	}
	for _, tc := range cases {
		got := OpenAIThinkingSpec(tc.model).Options()
		if len(got) != len(tc.want) {
			t.Errorf("%s: options = %+v, want %+v", tc.model, got, tc.want)
			continue
		}
		for i, opt := range tc.want {
			if got[i] != opt {
				t.Errorf("%s: options[%d] = %+v, want %+v", tc.model, i, got[i], opt)
			}
		}
	}

	// No-control model advertises nothing.
	if opts := OpenAIThinkingSpec("gpt-4o").Options(); len(opts) != 0 {
		t.Errorf("gpt-4o: options = %+v, want none", opts)
	}

	// Back-compat: a dropped tier stays mappable on the wire — a stored
	// thinking:"max" on gpt-5.1 still resolves to native "high".
	if got, ok := OpenAIThinkingSpec("gpt-5.1").effortFor("max"); !ok || got != "high" {
		t.Errorf("gpt-5.1 effortFor(max) = %q,%v; want \"high\",true (back-compat)", got, ok)
	}
}

// TestEffortForOmitsWhenUnsupported pins the omit contract: an absent/unknown
// level, or any level on a no-control spec, returns ok=false so no param is sent.
func TestEffortForOmitsWhenUnsupported(t *testing.T) {
	spec := OpenAIThinkingSpec("gpt-5.1")
	if _, ok := spec.effortFor(""); ok {
		t.Error("absent level must omit the reasoning param")
	}
	if _, ok := spec.effortFor("garbage"); ok {
		t.Error("unknown level must omit the reasoning param")
	}
	if _, ok := (ThinkingSpec{}).effortFor("high"); ok {
		t.Error("no-control spec must omit the reasoning param for any level")
	}
	// codex has no "off" level → omit rather than 400.
	if _, ok := OpenAIThinkingSpec("gpt-5.2-codex").effortFor("off"); ok {
		t.Error("codex must omit for unsupported 'off' level")
	}
}

// TestEffortSpec pins the identity-map helper: levels are preserved in order,
// each maps to its own canonical name as the native effort, Default is carried
// through, and the returned Effort map is mutable so callers can amend it (e.g.
// appending a divergent max→"xhigh" tier) without aliasing.
func TestEffortSpec(t *testing.T) {
	spec := EffortSpec(provider.ThinkingMedium, provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh)
	if spec.Default != provider.ThinkingMedium {
		t.Errorf("Default = %q, want %q", spec.Default, provider.ThinkingMedium)
	}
	wantLevels := []string{provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh}
	if len(spec.Levels) != len(wantLevels) {
		t.Fatalf("Levels = %v, want %v", spec.Levels, wantLevels)
	}
	for i, lvl := range wantLevels {
		if spec.Levels[i] != lvl {
			t.Errorf("Levels[%d] = %q, want %q", i, spec.Levels[i], lvl)
		}
		if spec.Effort[lvl] != lvl {
			t.Errorf("Effort[%q] = %q, want identity %q", lvl, spec.Effort[lvl], lvl)
		}
	}
	// Mutable result: amending one spec's map must not touch a sibling's.
	spec.Effort[provider.ThinkingMax] = "xhigh"
	other := EffortSpec(provider.ThinkingLow, provider.ThinkingLow)
	if _, aliased := other.Effort[provider.ThinkingMax]; aliased {
		t.Error("EffortSpec results share a map — must return a fresh map each call")
	}
}

// TestChatCompletionsSendsReasoningEffort proves the Chat Completions path sends
// reasoning_effort mapped from the canonical level, and omits it when absent.
func TestChatCompletionsSendsReasoningEffort(t *testing.T) {
	newClient := func(t *testing.T, out *map[string]any) *Client {
		c, err := NewClient(Config{APIKey: "test", Model: "gpt-5.1", BaseURL: "https://example.test", HTTPClient: captureBody(t, out, "chat")})
		if err != nil {
			t.Fatalf("NewClient: %v", err)
		}
		c.thinkingSpec = OpenAIThinkingSpec("gpt-5.1")
		return c
	}

	// level high → reasoning_effort "high"
	var body map[string]any
	c := newClient(t, &body)
	if _, err := c.streamMessage(context.Background(), provider.MessageRequest{
		Messages:      []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel: provider.ThinkingHigh,
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if got, _ := body["reasoning_effort"].(string); got != "high" {
		t.Fatalf("reasoning_effort = %q, want high", got)
	}

	// absent level → no reasoning_effort key
	var body2 map[string]any
	c2 := newClient(t, &body2)
	if _, err := c2.streamMessage(context.Background(), provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	}, func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if _, ok := body2["reasoning_effort"]; ok {
		t.Fatalf("reasoning_effort sent (%v) but should be omitted when level absent", body2["reasoning_effort"])
	}
}
