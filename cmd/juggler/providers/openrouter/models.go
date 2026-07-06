//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

// ModelContextWindows maps a small set of well-known OpenRouter model IDs to
// their context window sizes. OpenRouter exposes hundreds of models; the
// authoritative list (with context windows) is fetched live from the
// /api/v1/models endpoint. This map exists only as a fallback and to satisfy
// the test harness's --list-models output.
var ModelContextWindows = map[string]int{
	"anthropic/claude-sonnet-4.5": 200000,
	"anthropic/claude-opus-4.1":   200000,
	"openai/gpt-5":                400000,
	"openai/gpt-5-mini":           400000,
	"google/gemini-2.5-pro":       1000000,
	"google/gemini-2.5-flash":     1000000,
	"meta-llama/llama-3.3-70b":    131072,
	"deepseek/deepseek-chat":      128000,
	"qwen/qwen3-coder":            256000,
}

// DefaultContextWindow is used for unknown models.
const DefaultContextWindow = 128000

// DefaultMaxOutputTokens is used when the API does not report a value.
const DefaultMaxOutputTokens = 8192

// GetContextWindow returns the context window for a model (or default if unknown).
func GetContextWindow(model string) int {
	if window, ok := ModelContextWindows[model]; ok {
		return window
	}
	return DefaultContextWindow
}
