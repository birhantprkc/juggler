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
		ServiceTierSpecFn:  codexServiceTierSpec,
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

	// ServiceTiers is the backend's declaration of the non-standard serving
	// classes this model offers, carrying its own id, label and blurb (e.g.
	// {"priority", "Fast", "1.5x speed, increased usage"}). It is the sole
	// authority for what may be requested: a tier absent here is not offered
	// and never sent. DefaultServiceTier is the backend's declared default and
	// is displayed, never applied — see ServiceTierSpec.tierFor.
	//
	// The response also carries additional_speed_tiers, which the Codex client
	// marks deprecated in favour of this field. It is deliberately not parsed.
	ServiceTiers       []codexServiceTier `json:"service_tiers"`
	DefaultServiceTier string             `json:"default_service_tier"`
}

type codexReasoningLevel struct {
	Effort string `json:"effort"`
}

type codexServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
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

// serviceTierSpecs is the latest complete API-declared serving-class catalog,
// keyed by model slug, on the same wholesale-replacement terms as
// reasoningSpecs: a model that stops offering a tier must lose it immediately,
// because continuing to offer it would spend the user's money on a request the
// backend will decline.
var serviceTierSpecs atomic.Value // stores map[string]openaibase.ServiceTierSpec

func replaceServiceTierSpecs(specs map[string]openaibase.ServiceTierSpec) {
	serviceTierSpecs.Store(specs)
}

// codexServiceTierSpec is the descriptor's ServiceTierSpecFn. Only a spec
// populated from /models is returned: a saved or static model absent from the
// live catalog gets no speed control and no service_tier on the wire.
func codexServiceTierSpec(modelID string) openaibase.ServiceTierSpec {
	if snapshot, ok := serviceTierSpecs.Load().(map[string]openaibase.ServiceTierSpec); ok {
		return snapshot[modelID]
	}
	return openaibase.ServiceTierSpec{}
}

// serviceTierSpecFromCatalog builds a ServiceTierSpec from a model's
// service_tiers, preserving the backend's order, ids and labels. A model that
// declares no tiers yields the zero spec (standard serving only).
func serviceTierSpecFromCatalog(model codexModel) openaibase.ServiceTierSpec {
	tiers := make([]provider.ServiceTier, 0, len(model.ServiceTiers))
	for _, tier := range model.ServiceTiers {
		if tier.ID == "" {
			continue
		}
		tiers = append(tiers, provider.ServiceTier{
			ID:          tier.ID,
			Name:        tier.Name,
			Description: tier.Description,
		})
	}
	if len(tiers) == 0 {
		return openaibase.ServiceTierSpec{}
	}
	return openaibase.ServiceTierSpec{Tiers: tiers, Default: model.DefaultServiceTier}
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
	tierSpecs := make(map[string]openaibase.ServiceTierSpec, len(parsed.Models))
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
		tierSpec := serviceTierSpecFromCatalog(model)
		tierSpecs[model.Slug] = tierSpec
		infos = append(infos, provider.ModelInfo{
			ID:                   model.Slug,
			DisplayName:          utils.ModelDisplayName(model.Slug) + " (ChatGPT plan)",
			ContextWindow:        contextWindow,
			MaxOutputTokens:      maxOutputTokens,
			FromAPI:              true,
			ThinkingLevels:       spec.Options(),
			DefaultThinkingLevel: spec.Default,
			ServiceTiers:         tierSpec.Options(),
			DefaultServiceTier:   tierSpec.Default,
		})
	}
	if len(infos) == 0 {
		return nil, fmt.Errorf("OpenAI Codex /models returned no visible models")
	}
	replaceReasoningSpecs(specs)
	replaceServiceTierSpecs(tierSpecs)
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
		// ChatGPT-plan /models response is the sole authority for reasoning levels
		// and serving classes, so a model absent from that response advertises
		// neither a thinking control nor a speed control.
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
