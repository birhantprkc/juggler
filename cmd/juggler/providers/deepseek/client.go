//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:               "deepseek",
		DisplayName:        "DeepSeek",
		ConfigKeyName:      "deepseek_api_key",
		EnvVarName:         "DEEPSEEK_API_KEY",
		APIKeyURL:          "https://platform.deepseek.com/api_keys",
		DisplayProvider:    "DeepSeek",
		Filter:             isDeepSeekChatModel,
		ContextWindowCaps:  contextWindowCaps,
		MaxOutputCaps:      maxOutputCaps,
		UsageStatsOverride: usageStats,
		BaseURL:            "https://api.deepseek.com/v1",
		Quirks: openaibase.Quirks{
			IncludePresencePenalty:  true,
			IncludeFrequencyPenalty: true,
		},
	})
}

// isDeepSeekChatModel filters to DeepSeek chat models, excluding embedding/vision variants.
func isDeepSeekChatModel(modelID string) bool {
	id := strings.ToLower(modelID)
	if !strings.HasPrefix(id, "deepseek-") {
		return false
	}
	for _, suffix := range []string{"-embedding", "-vision", "-tts"} {
		if strings.HasSuffix(id, suffix) {
			return false
		}
	}
	return true
}
