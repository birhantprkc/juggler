//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"sync/atomic"

	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

var baseURL = "https://chatgpt.com/backend-api/codex"

const (
	codexClientVersion = "0.144.1"
)

// Register adds the OpenAI Codex-plan provider to the global registry. It
// uses the local Codex app/CLI's ChatGPT OAuth token, not a Platform API key.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:               "openaicodex",
		DisplayName:        "OpenAI Codex (ChatGPT plan)",
		Description:        "Uses your local Codex app/CLI ChatGPT login, so Plus/Pro/Business/Edu/Enterprise Codex plans can be selected without an OpenAI Platform API key.",
		AuthType:           provider.AuthTypeOAuthBearer,
		AuthSource:         "codex_cli",
		BaseURL:            baseURL,
		ContextWindows:     ModelContextWindows,
		DisplayProvider:    "OpenAI Codex",
		ListModelsOverride: listModels,
		UsageStatsOverride: usageStats,
		ThinkingSpecFn:     codexThinkingSpec,
		Quirks: openaibase.Quirks{
			MaxTokensParamName:           "max_completion_tokens",
			ForceResponsesAPI:            true,
			OmitResponsesMaxOutputTokens: true,
			ForcedToolChoiceSupported:    true,
			SessionAffinityHeader:        true,
		},
	})
}

type codexModelsResponse struct {
	Models []codexModel `json:"models"`
}

type codexModel struct {
	Slug             string `json:"slug"`
	Visibility       string `json:"visibility"`
	ContextWindow    int    `json:"context_window"`
	MaxContextWindow int    `json:"max_context_window"`
	MaxOutputTokens  int    `json:"max_output_tokens"`
	Priority         int    `json:"priority"`
	// DefaultReasoningLevel and SupportedReasoningLevels are the backend's
	// authoritative per-model reasoning-effort declaration — the single source
	// of truth for which effort tiers this model accepts. The valid set varies
	// per model (e.g. gpt-5.6-sol advertises low/medium/high/xhigh/max/ultra)
	// and the current catalog's slugs carry no "codex" marker at all, so a slug
	// heuristic cannot classify them. We advertise and wire-gate from these
	// fields, never from the slug.
	DefaultReasoningLevel    string                `json:"default_reasoning_level"`
	SupportedReasoningLevels []codexReasoningLevel `json:"supported_reasoning_levels"`
}

type codexReasoningLevel struct {
	Effort string `json:"effort"`
}

// reasoningSpecs is the latest complete API-declared reasoning catalog, keyed
// by model slug. Each successful /models response replaces the whole immutable
// snapshot so a model removed from (or no longer declaring levels in) a later
// response cannot retain stale capabilities from an earlier fetch.
var reasoningSpecs atomic.Value // stores map[string]openaibase.ThinkingSpec

func replaceReasoningSpecs(specs map[string]openaibase.ThinkingSpec) {
	reasoningSpecs.Store(specs)
}

// codexThinkingSpec is the descriptor's ThinkingSpecFn. The ChatGPT-plan
// catalog is authoritative for reasoning levels, so only a spec populated from
// /models is returned. A saved/static model that was not present in the live
// catalog gets no reasoning control and no reasoning_effort on the wire — never
// a model-name guess or hard-coded fallback.
func codexThinkingSpec(modelID string) openaibase.ThinkingSpec {
	if snapshot, ok := reasoningSpecs.Load().(map[string]openaibase.ThinkingSpec); ok {
		return snapshot[modelID]
	}
	return openaibase.ThinkingSpec{}
}

// thinkingSpecFromCatalog builds a ThinkingSpec from a model's
// supported_reasoning_levels, preserving the backend's order and default. A
// model that declares no levels yields the zero spec (no reasoning control).
func thinkingSpecFromCatalog(model codexModel) openaibase.ThinkingSpec {
	levels := make([]string, 0, len(model.SupportedReasoningLevels))
	for _, level := range model.SupportedReasoningLevels {
		if level.Effort != "" {
			levels = append(levels, level.Effort)
		}
	}
	if len(levels) == 0 {
		return openaibase.ThinkingSpec{}
	}
	return openaibase.ThinkingSpec{Levels: levels, Default: model.DefaultReasoningLevel}
}

func listModels(ctx context.Context, bearerToken string, headers map[string]string) ([]provider.ModelInfo, error) {
	endpoint, err := url.Parse(baseURL + "/models")
	if err != nil {
		return nil, fmt.Errorf("failed to build OpenAI Codex models URL: %w", err)
	}
	query := endpoint.Query()
	query.Set("client_version", codexClientVersion)
	endpoint.RawQuery = query.Encode()

	var parsed codexModelsResponse
	if err := utils.GetJSON(ctx, endpoint.String(), utils.JSONGetOptions{
		Bearer:  bearerToken,
		Headers: headers,
		Label:   "OpenAI Codex /models",
	}, &parsed); err != nil {
		return nil, fmt.Errorf("failed to list models from OpenAI Codex: %w", err)
	}

	sort.SliceStable(parsed.Models, func(i, j int) bool {
		return parsed.Models[i].Priority < parsed.Models[j].Priority
	})

	infos := make([]provider.ModelInfo, 0, len(parsed.Models))
	specs := make(map[string]openaibase.ThinkingSpec, len(parsed.Models))
	for _, model := range parsed.Models {
		if model.Slug == "" || model.Visibility != "list" {
			continue
		}
		contextWindow := model.ContextWindow
		if contextWindow == 0 {
			contextWindow = model.MaxContextWindow
		}
		if contextWindow == 0 {
			contextWindow = DefaultContextWindow
		}
		maxOutputTokens := model.MaxOutputTokens
		if maxOutputTokens == 0 {
			maxOutputTokens = DefaultMaxOutputTokens
		}
		spec := thinkingSpecFromCatalog(model)
		specs[model.Slug] = spec
		infos = append(infos, provider.ModelInfo{
			ID:                   model.Slug,
			DisplayName:          utils.ModelDisplayName(model.Slug) + " (ChatGPT plan)",
			ContextWindow:        contextWindow,
			MaxOutputTokens:      maxOutputTokens,
			FromAPI:              true,
			ThinkingLevels:       spec.Options(),
			DefaultThinkingLevel: spec.Default,
		})
	}
	if len(infos) == 0 {
		return nil, fmt.Errorf("OpenAI Codex /models returned no visible models")
	}
	replaceReasoningSpecs(specs)
	return withStaticFallbackModels(infos), nil
}

func withStaticFallbackModels(infos []provider.ModelInfo) []provider.ModelInfo {
	seen := make(map[string]bool, len(infos))
	for _, info := range infos {
		seen[info.ID] = true
	}

	ids := make([]string, 0, len(ModelContextWindows))
	for id := range ModelContextWindows {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)

	for _, id := range ids {
		// These compatibility entries contribute only static admission limits. The
		// ChatGPT-plan /models response is the sole authority for reasoning levels,
		// so a model absent from that response advertises no thinking control.
		infos = append(infos, provider.ModelInfo{
			ID:              id,
			DisplayName:     utils.ModelDisplayName(id) + " (ChatGPT plan)",
			ContextWindow:   ModelContextWindows[id],
			MaxOutputTokens: DefaultMaxOutputTokens,
			FromAPI:         false,
		})
	}
	return infos
}
