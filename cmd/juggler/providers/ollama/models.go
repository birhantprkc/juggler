//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import "strings"

// ModelContextWindows maps Ollama model name prefixes/families to context
// window sizes (tokens). Ollama lets users name local models freely (with tags
// like ":7b-q4"), so lookups match by family prefix rather than exact name.
var ModelContextWindows = map[string]int{
	"llama3.3":    131072,
	"llama3.2":    131072,
	"llama3.1":    131072,
	"llama3":      8192,
	"qwen3":       131072,
	"qwen2.5":     131072,
	"qwen2":       131072,
	"deepseek-r1": 131072,
	"deepseek-v3": 131072,
	"mistral":     32768,
	"mixtral":     32768,
	"gemma3":      128000,
	"gemma2":      8192,
	"phi4":        16384,
	"phi3":        128000,
	"command-r":   131072,
}

// DefaultContextWindow is used when the model family is unknown.
const DefaultContextWindow = 8192

// DefaultMaxOutputTokens caps generation length per request.
const DefaultMaxOutputTokens = 4096

// GetContextWindow returns the context window for an Ollama model. Match is by
// family prefix (everything before ':'), since users tag custom variants.
func GetContextWindow(model string) int {
	id := strings.ToLower(model)
	if idx := strings.Index(id, ":"); idx >= 0 {
		id = id[:idx]
	}
	if window, ok := ModelContextWindows[id]; ok {
		return window
	}
	for prefix, window := range ModelContextWindows {
		if strings.HasPrefix(id, prefix) {
			return window
		}
	}
	return DefaultContextWindow
}
