//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds the Mistral AI provider to the global registry. Called
// explicitly from main; no init()-time side effects.
//
// Mistral speaks the OpenAI Chat-Completions protocol, so it rides the shared
// openaibase machinery. Its API key is independent of the generic
// OpenAI-compatible provider, so a user can configure both side by side.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "mistral",
		DisplayName:     "Mistral AI",
		Description:     "Mistral AI models via the official OpenAI-compatible API. Models are discovered from Mistral's /v1/models endpoint.",
		ConfigKeyName:   "mistral_api_key",
		EnvVarName:      "MISTRAL_API_KEY",
		APIKeyURL:       "https://console.mistral.ai/settings/keys",
		DisplayProvider: "Mistral AI",
		// The Ministral line is Mistral's small/fast tier. 8B rather than 3B:
		// this model has to write a coherent tab title, not merely a short one.
		// Deliberately unversioned, so it matches both the dated id and the
		// -latest alias, whichever the endpoint publishes.
		CheapModel:        "ministral-8b",
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    thinkingSpec,
		BaseURL:           "https://api.mistral.ai/v1",
	})
}

// inputModalities reports the input modalities a Mistral model accepts.
// Vision-capable models accept text and images; the code-focused and tiny
// models are text-only (nil).
func inputModalities(modelID string) []string {
	switch modelID {
	case "codestral-latest", "devstral-medium-latest", "mistral-tiny-latest":
		return nil
	default:
		return []string{"text", "image"}
	}
}
