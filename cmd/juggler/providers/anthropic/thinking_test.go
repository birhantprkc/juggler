//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"testing"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"

	"juggler/cmd/juggler/providers/provider"
)

// thinkingWire marshals a thinking param and returns it as a generic map, so
// assertions name wire keys ("type", "budget_tokens") rather than depending on
// field order in the encoded JSON.
func thinkingWire(t *testing.T, thinking anthropicsdk.ThinkingConfigParamUnion) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(thinking)
	if err != nil {
		t.Fatalf("marshal thinking param: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("unmarshal thinking param %s: %v", encoded, err)
	}
	return wire
}

// TestBuildMessageParamsThinkingLevel pins the extended-thinking request shape:
// a supported level sets the thinking param with the expected budget, kept below
// max_tokens.
func TestBuildMessageParamsThinkingLevel(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}

	cases := map[string]int64{
		"low":    2048,
		"medium": 8192,
		"high":   16384,
		"max":    32768,
	}
	for level, wantBudget := range cases {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})
		got := params.Thinking.GetBudgetTokens()
		if got == nil {
			t.Fatalf("level %q: thinking param missing, want budget %d", level, wantBudget)
		}
		if *got != wantBudget {
			t.Errorf("level %q: budget = %d, want %d", level, *got, wantBudget)
		}
		if *got >= params.MaxTokens {
			t.Errorf("level %q: budget %d must be < max_tokens %d", level, *got, params.MaxTokens)
		}
	}
}

// TestBuildMessageParamsThinkingClamped pins the budget clamp: Opus 4.x caps
// max_tokens at 32000, so the "max" budget is clamped below it with answer
// headroom rather than exceeding the ceiling (a hard 400).
func TestBuildMessageParamsThinkingClamped(t *testing.T) {
	c := &Client{model: "claude-opus-4-20250514"}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "max"})
	got := params.Thinking.GetBudgetTokens()
	if got == nil {
		t.Fatal("thinking param missing for opus max")
	}
	if want := int64(32000 - 4096); *got != want {
		t.Errorf("clamped budget = %d, want %d", *got, want)
	}
}

// TestBuildMessageParamsThinkingClampedToCapability pins the divergence guard:
// when the admission capability snapshot carries a lower output limit than the
// static catalog, the thinking budget clamps against the wire max_tokens (the
// snapshot), never the catalog — budget_tokens ≥ max_tokens is a hard 400. And
// when the snapshot leaves no room for even the minimum budget plus answer
// headroom, thinking drops for that turn instead of erroring.
func TestBuildMessageParamsThinkingClampedToCapability(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 20000}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "max"})
	got := params.Thinking.GetBudgetTokens()
	if got == nil {
		t.Fatal("thinking param missing for max level")
	}
	if want := int64(20000 - 4096); *got != want {
		t.Errorf("budget = %d, want %d (clamped to the capability wire value, not the catalog)", *got, want)
	}
	if *got >= params.MaxTokens {
		t.Errorf("budget %d must be < max_tokens %d", *got, params.MaxTokens)
	}

	c = &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 5000}
	params = c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "max"})
	if got := params.Thinking.GetBudgetTokens(); got != nil {
		t.Errorf("maxTokens 5000: budget = %d, want thinking dropped (below the 1024 minimum after headroom)", *got)
	}
}

// TestBuildMessageParamsThinkingClampsToCatalogWireValue pins the F4 ordering:
// when the catalog clamps max_tokens below an over-large capability snapshot,
// the thinking budget follows the clamped (catalog) wire value, not the
// snapshot — otherwise budget_tokens ≥ max_tokens would be a hard 400.
func TestBuildMessageParamsThinkingClampsToCatalogWireValue(t *testing.T) {
	c := &Client{model: "claude-opus-4-20250514", maxOutputTokens: 100000}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "max"})
	if params.MaxTokens != 32000 {
		t.Fatalf("MaxTokens = %d, want catalog-clamped 32000", params.MaxTokens)
	}
	got := params.Thinking.GetBudgetTokens()
	if got == nil {
		t.Fatal("thinking param missing")
	}
	if want := int64(32000 - 4096); *got != want {
		t.Errorf("budget = %d, want %d (clamped to the catalog wire value)", *got, want)
	}
	if *got >= params.MaxTokens {
		t.Errorf("budget %d must be < max_tokens %d", *got, params.MaxTokens)
	}
}

// TestBuildMessageParamsThinkingOffAbsent pins backward compatibility: "off" and
// an absent level produce no thinking param at all.
func TestBuildMessageParamsThinkingOffAbsent(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}
	for _, level := range []string{"", "off", "garbage"} {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})
		if got := params.Thinking.GetBudgetTokens(); got != nil {
			t.Errorf("level %q: thinking param present (budget %d), want omitted", level, *got)
		}
	}
}

// TestBuildMessageParamsThinkingForcedToolDrops pins the forced-tool rule for
// the manual thinking form: a forced tool_choice is incompatible with it (a hard
// 400), so the thinking param is dropped for that turn.
func TestBuildMessageParamsThinkingForcedToolDrops(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}
	tools := []provider.ToolDefinition{{Name: "submit_answer", InputSchema: []byte(`{"type":"object"}`)}}
	for _, tc := range []*provider.ToolChoice{
		{Mode: provider.ToolChoiceTool, Name: "submit_answer"},
		{Mode: provider.ToolChoiceAny},
	} {
		params := c.buildMessageParams(provider.MessageRequest{
			ThinkingLevel: "high",
			Tools:         tools,
			ToolChoice:    tc,
		})
		if got := params.Thinking.GetBudgetTokens(); got != nil {
			t.Errorf("forced tool (mode %q): thinking present (budget %d), want dropped", tc.Mode, *got)
		}
	}

	// A non-forcing choice (none) still allows thinking.
	params := c.buildMessageParams(provider.MessageRequest{
		ThinkingLevel: "high",
		Tools:         tools,
		ToolChoice:    &provider.ToolChoice{Mode: provider.ToolChoiceNone},
	})
	if got := params.Thinking.GetBudgetTokens(); got == nil {
		t.Error("mode none must still allow thinking")
	}
}

// TestBuildMessageParamsThinkingUnsupportedModel pins that a level on a model
// without extended-thinking support (Claude 3.5) is ignored.
func TestBuildMessageParamsThinkingUnsupportedModel(t *testing.T) {
	c := &Client{model: "claude-3-5-sonnet-20241022"}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "high"})
	if got := params.Thinking.GetBudgetTokens(); got != nil {
		t.Errorf("unsupported model: thinking present (budget %d), want omitted", *got)
	}
}

// TestBuildMessageParamsLegacyThinkingWireForm pins the manual thinking wire
// shape for the models that still take it: thinking.type "enabled" carrying an
// explicit budget_tokens, and no output_config.
func TestBuildMessageParamsLegacyThinkingWireForm(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: "high"})

	wire := thinkingWire(t, params.Thinking)
	if got := wire["type"]; got != "enabled" {
		t.Errorf("thinking type = %v, want \"enabled\"", got)
	}
	if got := wire["budget_tokens"]; got != float64(16384) {
		t.Errorf("budget_tokens = %v, want 16384", got)
	}
	if params.OutputConfig.Effort != "" {
		t.Errorf("effort = %q, want none on the manual form", params.OutputConfig.Effort)
	}
}

// TestBuildMessageParamsAdaptiveThinkingLevel pins the adaptive request shape
// for models on that form: each level maps to an output_config.effort value,
// thinking.type is "adaptive" with no budget_tokens, and display is "summarized"
// so the response keeps its thinking text (it defaults to "omitted" on these
// models, which returns thinking blocks stripped of text).
func TestBuildMessageParamsAdaptiveThinkingLevel(t *testing.T) {
	c := &Client{model: "claude-opus-4-7-20260210"}

	cases := map[string]string{
		"low":    "low",
		"medium": "medium",
		"high":   "high",
		"max":    "max",
	}
	for level, wantEffort := range cases {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})

		if params.Thinking.OfAdaptive == nil {
			t.Fatalf("level %q: adaptive thinking param missing", level)
		}
		if got := params.Thinking.GetBudgetTokens(); got != nil {
			t.Errorf("level %q: budget_tokens = %d, want none on the adaptive form", level, *got)
		}
		if got := string(params.OutputConfig.Effort); got != wantEffort {
			t.Errorf("level %q: effort = %q, want %q", level, got, wantEffort)
		}

		wire := thinkingWire(t, params.Thinking)
		if got := wire["type"]; got != "adaptive" {
			t.Errorf("level %q: thinking type = %v, want \"adaptive\"", level, got)
		}
		if got := wire["display"]; got != "summarized" {
			t.Errorf("level %q: display = %v, want \"summarized\"", level, got)
		}
		if _, present := wire["budget_tokens"]; present {
			t.Errorf("level %q: budget_tokens present on the adaptive form: %v", level, wire)
		}

		// output_config is a sibling of model/max_tokens/messages, not part of
		// the thinking object.
		var body map[string]any
		encoded, err := json.Marshal(params)
		if err != nil {
			t.Fatalf("level %q: marshal params: %v", level, err)
		}
		if err := json.Unmarshal(encoded, &body); err != nil {
			t.Fatalf("level %q: unmarshal params: %v", level, err)
		}
		outputConfig, ok := body["output_config"].(map[string]any)
		if !ok {
			t.Fatalf("level %q: output_config missing from the request body: %s", level, encoded)
		}
		if got := outputConfig["effort"]; got != wantEffort {
			t.Errorf("level %q: output_config.effort = %v, want %q", level, got, wantEffort)
		}
	}
}

// TestBuildMessageParamsAdaptiveThinkingOffAbsent pins that "off", an absent
// level and an unrecognised one send neither a thinking nor an output_config
// param on the adaptive form, matching the manual form's behaviour. "off" is
// deliberately not sent as thinking.type "disabled": every model on this form
// defaults to thinking off, so omitting the param says the same thing without
// tripping the models that reject "disabled" outright.
func TestBuildMessageParamsAdaptiveThinkingOffAbsent(t *testing.T) {
	c := &Client{model: "claude-opus-4-7-20260210"}
	for _, level := range []string{"", "off", "garbage"} {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})
		if params.Thinking.OfAdaptive != nil {
			t.Errorf("level %q: adaptive thinking param present, want omitted", level)
		}
		if params.OutputConfig.Effort != "" {
			t.Errorf("level %q: effort = %q, want omitted", level, params.OutputConfig.Effort)
		}

		encoded, err := json.Marshal(params)
		if err != nil {
			t.Fatalf("level %q: marshal params: %v", level, err)
		}
		var body map[string]any
		if err := json.Unmarshal(encoded, &body); err != nil {
			t.Fatalf("level %q: unmarshal params: %v", level, err)
		}
		if _, present := body["output_config"]; present {
			t.Errorf("level %q: output_config present in the request body: %s", level, encoded)
		}
		if _, present := body["thinking"]; present {
			t.Errorf("level %q: thinking present in the request body: %s", level, encoded)
		}
	}
}

// TestBuildMessageParamsAdaptiveThinkingKeepsForcedTool pins that the
// forced-tool rule applies only to the manual form. Forced tool use is
// compatible with adaptive thinking, so the turn keeps its thinking instead of
// silently dropping it.
func TestBuildMessageParamsAdaptiveThinkingKeepsForcedTool(t *testing.T) {
	c := &Client{model: "claude-opus-4-7-20260210"}
	tools := []provider.ToolDefinition{{Name: "submit_answer", InputSchema: []byte(`{"type":"object"}`)}}
	for _, tc := range []*provider.ToolChoice{
		{Mode: provider.ToolChoiceTool, Name: "submit_answer"},
		{Mode: provider.ToolChoiceAny},
	} {
		params := c.buildMessageParams(provider.MessageRequest{
			ThinkingLevel: "high",
			Tools:         tools,
			ToolChoice:    tc,
		})
		if params.Thinking.OfAdaptive == nil {
			t.Errorf("forced tool (mode %q): adaptive thinking dropped, want kept", tc.Mode)
		}
		if got := string(params.OutputConfig.Effort); got != "high" {
			t.Errorf("forced tool (mode %q): effort = %q, want \"high\"", tc.Mode, got)
		}
	}
}

// TestThinkingModeForModel pins which wire form each model generation takes.
// Anthropic rejects the wrong one with a 400 in both directions: 4.5 and earlier
// reject "adaptive", 4.7 and later reject "enabled". 4.6 accepts both and takes
// the adaptive path. Ids naming no generation, and generations newer than any
// this list knows, must land on adaptive — the set of models needing the manual
// form is closed, so an unrecognised id is the newer kind.
func TestThinkingModeForModel(t *testing.T) {
	legacy := []string{
		"claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-opus-4-20250514",
		"claude-haiku-4-5", "claude-3-7-sonnet-20250219", "claude-4.5-sonnet", "claude-sonnet-4",
	}
	adaptive := []string{
		"claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7-20260210", "claude-opus-4-8",
		"claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-mythos-preview",
		"claude-sonnet-9-9-20301231",
	}
	for _, m := range legacy {
		if got := thinkingModeForModel(m); got != thinkingLegacy {
			t.Errorf("thinkingModeForModel(%q) = %v, want thinkingLegacy", m, got)
		}
	}
	for _, m := range adaptive {
		if got := thinkingModeForModel(m); got != thinkingAdaptive {
			t.Errorf("thinkingModeForModel(%q) = %v, want thinkingAdaptive", m, got)
		}
	}
}

// TestClaudeVersion pins the generation parser across both id orders and both
// separators, and pins that a trailing release date is never read as a version.
func TestClaudeVersion(t *testing.T) {
	cases := []struct {
		model        string
		major, minor int
		ok           bool
	}{
		{"claude-sonnet-4-5-20250929", 4, 5, true},
		{"claude-opus-4-1-20250805", 4, 1, true},
		{"claude-opus-4-20250514", 4, 0, true}, // the date must not become the minor
		{"claude-3-7-sonnet-20250219", 3, 7, true},
		{"claude-3-5-sonnet-20241022", 3, 5, true},
		{"claude-4.5-sonnet", 4, 5, true},
		{"claude-4-sonnet", 4, 0, true},
		{"claude-sonnet-4.5", 4, 5, true},
		{"claude-sonnet-4-6", 4, 6, true},
		{"claude-sonnet-5", 5, 0, true},
		{"claude-mythos-preview", 0, 0, false},
	}
	for _, tc := range cases {
		major, minor, ok := claudeVersion(tc.model)
		if major != tc.major || minor != tc.minor || ok != tc.ok {
			t.Errorf("claudeVersion(%q) = (%d, %d, %t), want (%d, %d, %t)",
				tc.model, major, minor, ok, tc.major, tc.minor, tc.ok)
		}
	}
}

// TestSupportsThinking pins the model-capability classifier.
func TestSupportsThinking(t *testing.T) {
	yes := []string{
		"claude-sonnet-4-5-20250929", "claude-sonnet-4", "claude-opus-4-1-20250805",
		"claude-4-sonnet", "claude-4.5-sonnet", "claude-3-7-sonnet-20250219", "claude-3.7-sonnet",
	}
	no := []string{
		"claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307",
	}
	for _, m := range yes {
		if !SupportsThinking(m) {
			t.Errorf("SupportsThinking(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if SupportsThinking(m) {
			t.Errorf("SupportsThinking(%q) = true, want false", m)
		}
	}
}
