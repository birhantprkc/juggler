//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"context"
	"fmt"

	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

const baseURL = "https://openrouter.ai/api/v1"

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:               "openrouter",
		DisplayName:        "OpenRouter",
		ConfigKeyName:      "openrouter_api_key",
		EnvVarName:         "OPENROUTER_API_KEY",
		APIKeyURL:          "https://openrouter.ai/keys",
		ContextWindows:     ModelContextWindows,
		BaseURL:            baseURL,
		ListModelsOverride: listModels,
		UsageStatsOverride: usageStats,
	})
}

// openRouterModel mirrors the subset of fields we consume from
// https://openrouter.ai/api/v1/models.
type openRouterModel struct {
	ID            string `json:"id"`
	Name          string `json:"name"` // Human label OpenRouter ships, e.g. "Anthropic: Claude Sonnet 4.5"
	ContextLength int    `json:"context_length"`
	Architecture  struct {
		InputModalities []string `json:"input_modalities"`
	} `json:"architecture"`
	TopProvider struct {
		MaxCompletionTokens int `json:"max_completion_tokens"`
	} `json:"top_provider"`
}

type openRouterModelsResponse struct {
	Data []openRouterModel `json:"data"`
}

// listModels fetches the model catalog directly from OpenRouter. The OpenAI
// SDK's Models.List does not surface context_length, so we hit the REST
// endpoint to get authoritative context windows for each model.
func listModels(ctx context.Context, apiKey string, headers map[string]string) ([]provider.ModelInfo, error) {
	var parsed openRouterModelsResponse
	if err := utils.GetJSON(ctx, baseURL+"/models", utils.JSONGetOptions{
		Bearer:  apiKey,
		Headers: headers,
		Label:   "OpenRouter /models",
	}, &parsed); err != nil {
		return nil, fmt.Errorf("failed to list models from OpenRouter: %w", err)
	}

	infos := make([]provider.ModelInfo, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		ctxWindow := m.ContextLength
		if ctxWindow == 0 {
			ctxWindow = GetContextWindow(m.ID)
		}
		maxOut := m.TopProvider.MaxCompletionTokens
		if maxOut == 0 {
			maxOut = DefaultMaxOutputTokens
		}
		// Map OpenRouter's reported input modalities, keeping only the kinds we
		// model (text/image). Anything else (e.g. "file") is dropped; a result
		// of just ["text"] is normalised to nil (text-only by convention).
		var inputModalities []string
		for _, mod := range m.Architecture.InputModalities {
			if mod == "image" {
				inputModalities = []string{"text", "image"}
				break
			}
		}

		infos = append(infos, provider.ModelInfo{
			ID:              m.ID,
			DisplayName:     utils.FirstNonEmpty(m.Name, utils.ModelDisplayName(m.ID)),
			ContextWindow:   ctxWindow,
			MaxOutputTokens: maxOut,
			FromAPI:         true,
			InputModalities: inputModalities,
		})
	}

	return infos, nil
}
