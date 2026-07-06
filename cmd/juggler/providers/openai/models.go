//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import "juggler/cmd/juggler/providers/utils"

// ModelContextWindows maps OpenAI model names to their context window sizes (in tokens)
// Only includes well-known models - unknown models fall back to defaults
var ModelContextWindows = map[string]int{
	// GPT-5 Series (400K total: 272K input + 128K output)
	"gpt-5":            400000,
	"gpt-5-mini":       400000,
	"gpt-5-nano":       400000,
	"gpt-5.1":          128000, // ChatGPT version
	"gpt-5.1-thinking": 196000,

	// GPT-4o Series
	"gpt-4o":      128000,
	"gpt-4o-mini": 128000,

	// GPT-4 Turbo
	"gpt-4-turbo": 128000,

	// GPT-4
	"gpt-4":     8192,
	"gpt-4-32k": 32768,

	// GPT-3.5
	"gpt-3.5-turbo": 16385,

	// o1 Series
	"o1":         200000,
	"o1-preview": 128000,
	"o1-mini":    128000,
}

// ModelMaxOutputTokens maps OpenAI model names to their max output tokens
var ModelMaxOutputTokens = map[string]int{
	// GPT-5 Series
	"gpt-5":            128000,
	"gpt-5-mini":       128000,
	"gpt-5-nano":       128000,
	"gpt-5.1":          128000,
	"gpt-5.1-thinking": 128000,

	// GPT-4o Series
	"gpt-4o":      16384,
	"gpt-4o-mini": 16384,

	// GPT-4 Turbo
	"gpt-4-turbo": 4096,

	// GPT-4
	"gpt-4":     8192,
	"gpt-4-32k": 32768,

	// GPT-3.5
	"gpt-3.5-turbo": 4096,

	// o1 Series
	"o1":         100000,
	"o1-preview": 32768,
	"o1-mini":    65536,
}

// DefaultContextWindow is used for unknown models
const DefaultContextWindow = 128000

// DefaultMaxOutputTokens is used for unknown models
const DefaultMaxOutputTokens = 16384

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)
