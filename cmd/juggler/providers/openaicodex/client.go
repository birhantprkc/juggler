//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"context"
	"fmt"
	"net/url"
	"sort"

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
		ThinkingSpecFn:     openaibase.OpenAIThinkingSpec,
		Quirks: openaibase.Quirks{
			MaxTokensParamName:           "max_completion_tokens",
			ForceResponsesAPI:            true,
			OmitResponsesMaxOutputTokens: true,
			ForcedToolChoiceSupported:    true,
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
		spec := openaibase.OpenAIThinkingSpec(model.Slug)
		infos = append(infos, provider.ModelInfo{
			ID:                   model.Slug,
			DisplayName:          utils.ModelDisplayName(model.Slug) + " (ChatGPT plan)",
			ContextWindow:        contextWindow,
			MaxOutputTokens:      maxOutputTokens,
			FromAPI:              true,
			ThinkingLevels:       spec.Levels,
			DefaultThinkingLevel: spec.Default,
		})
	}
	if len(infos) == 0 {
		return nil, fmt.Errorf("OpenAI Codex /models returned no visible models")
	}
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
		spec := openaibase.OpenAIThinkingSpec(id)
		infos = append(infos, provider.ModelInfo{
			ID:                   id,
			DisplayName:          utils.ModelDisplayName(id) + " (ChatGPT plan)",
			ContextWindow:        ModelContextWindows[id],
			MaxOutputTokens:      DefaultMaxOutputTokens,
			FromAPI:              false,
			ThinkingLevels:       spec.Levels,
			DefaultThinkingLevel: spec.Default,
		})
	}
	return infos
}
