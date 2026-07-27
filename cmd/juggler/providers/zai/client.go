//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
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
		Filter:             openaibase.PrefixModelFilter("glm-", "-embedding", "-vision", "-tts"),
		ContextWindowCaps:  contextWindowCaps,
		MaxOutputCaps:      maxOutputCaps,
		ThinkingSpecFn:     thinkingSpec,
		UsageStatsOverride: usageStats,
		BaseURL:            "https://api.z.ai/api/coding/paas/v4",
		Quirks: openaibase.Quirks{
			IncludePresencePenalty:  true,
			IncludeFrequencyPenalty: true,
		},
	})
}
