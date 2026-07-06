//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:               "zai",
		DisplayName:        "Z.AI GLM",
		ConfigKeyName:      "zai_api_key",
		EnvVarName:         "ZAI_API_KEY",
		APIKeyURL:          "https://z.ai/manage-apikey/apikey-list",
		DisplayProvider:    "Z.AI",
		Filter:             isGLMChatModel,
		ContextWindowCaps:  contextWindowCaps,
		MaxOutputCaps:      maxOutputCaps,
		UsageStatsOverride: usageStats,
		BaseURL:            "https://api.z.ai/api/coding/paas/v4",
		Quirks: openaibase.Quirks{
			IncludePresencePenalty:  true,
			IncludeFrequencyPenalty: true,
		},
	})
}

// isGLMChatModel filters to GLM chat models, excluding embedding/vision/tts variants.
func isGLMChatModel(modelID string) bool {
	id := strings.ToLower(modelID)
	if !strings.HasPrefix(id, "glm-") {
		return false
	}
	for _, suffix := range []string{"-embedding", "-vision", "-tts"} {
		if strings.HasSuffix(id, suffix) {
			return false
		}
	}
	return true
}
