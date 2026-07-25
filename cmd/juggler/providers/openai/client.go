//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:              "openai",
		DisplayName:       "OpenAI ChatGPT",
		ConfigKeyName:     "openai_api_key",
		EnvVarName:        "OPENAI_API_KEY",
		APIKeyURL:         "https://platform.openai.com/api-keys",
		DisplayProvider:   "OpenAI",
		Filter:            isChatModel,
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    openaibase.OpenAIThinkingSpec,
		// Small/fast tier for out-of-band micro-tasks (auto-naming a tab).
		CheapModel: "gpt-5-mini",
		Quirks: openaibase.Quirks{
			UseDeveloperRole:          true,
			MaxTokensParamName:        "max_completion_tokens",
			ForcedToolChoiceSupported: true,
		},
	})
}

// inputModalities reports the input modalities for an OpenAI model id. Returns
// ["text","image"] for vision-capable families, nil (text-only) otherwise.
func inputModalities(modelID string) []string {
	if supportsVision(modelID) {
		return []string{"text", "image"}
	}
	return nil
}

// supportsVision reports whether an OpenAI model accepts image input. Vision
// families: gpt-4o*, gpt-4.1*, gpt-4-turbo*, gpt-5*, chatgpt-4o*, o4-mini, and
// the full o1/o3 reasoning models. Text-only exceptions handled by exclusion:
// gpt-4 base, gpt-3.5, o1-mini, o1-preview, o3-mini.
func supportsVision(modelID string) bool {
	m := strings.ToLower(modelID)
	switch {
	case strings.HasPrefix(m, "gpt-4o"),
		strings.HasPrefix(m, "chatgpt-4o"),
		strings.HasPrefix(m, "gpt-4.1"),
		strings.HasPrefix(m, "gpt-4-turbo"),
		strings.HasPrefix(m, "gpt-5"),
		strings.HasPrefix(m, "o4-mini"):
		return true
	// o1 / o3 full reasoning models support vision; their -mini and o1-preview
	// variants are text-only. Match the bare id and dated ids (o1-2024-…),
	// excluding the -mini/-preview suffixes.
	case m == "o1" || strings.HasPrefix(m, "o1-2"),
		m == "o3" || strings.HasPrefix(m, "o3-2"):
		return true
	default:
		return false
	}
}

// isChatModel filters out non-chat OpenAI models (embeddings, audio, image,
// moderation, legacy GPT-3 base models).
func isChatModel(modelID string) bool {
	excludePrefixes := []string{
		"text-embedding-", "whisper-", "tts-", "dall-e-",
		"text-moderation-", "omni-moderation-",
		"babbage-", "davinci-", "curie-", "ada-",
	}
	excludeSubstrings := []string{
		"-audio-", "audio-preview", "realtime-preview",
	}
	modelLower := strings.ToLower(modelID)
	for _, prefix := range excludePrefixes {
		if strings.HasPrefix(modelLower, prefix) {
			return false
		}
	}
	for _, substring := range excludeSubstrings {
		if strings.Contains(modelLower, substring) {
			return false
		}
	}
	return true
}
