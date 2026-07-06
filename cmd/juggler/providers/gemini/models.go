//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gemini

import "strings"

// ModelContextWindows maps Gemini model names to their context window sizes (in tokens),
// per Google's published model documentation.
var ModelContextWindows = map[string]int{
	// Gemini 2.0 Series (current generation)
	"gemini-2.0-flash-exp":  1000000, // Default
	"gemini-2.0-flash":      1000000,
	"gemini-2.0-flash-lite": 1000000,
	"gemini-2.0-pro-exp":    2000000,
	"gemini-2.0-pro":        2000000,

	// Gemini 2.5 Series
	"gemini-2.5-pro":   1048576, // ~1M
	"gemini-2.5-flash": 1048576, // ~1M

	// Gemini 1.5 Series (previous generation)
	"gemini-1.5-pro":          2000000, // Max: 2M, Preview: 1M, Standard: 128K
	"gemini-1.5-pro-latest":   2000000,
	"gemini-1.5-flash":        1000000, // Max: 1M, Standard: 128K
	"gemini-1.5-flash-latest": 1000000,
	"gemini-1.5-flash-8b":     1000000,

	// Gemini 1.0 Series (older)
	"gemini-1.0-pro":        32000,
	"gemini-1.0-pro-latest": 32000,
}

// DefaultContextWindow is the fallback context window if model is not found
const DefaultContextWindow = 1000000

// GetContextWindow returns the context window for a given model
// Returns DefaultContextWindow if the model is not found
func GetContextWindow(model string) int {
	if window, ok := ModelContextWindows[model]; ok {
		return window
	}
	return DefaultContextWindow
}

// SupportsImageInput reports whether a Gemini model accepts image input. The
// Gemini 1.5 and 2.x families are natively multimodal; Gemini 1.0 Pro (text)
// is not. The model name may carry the API's "models/" prefix — substring
// matching handles both forms.
func SupportsImageInput(model string) bool {
	m := strings.ToLower(model)
	return strings.Contains(m, "gemini-1.5") || strings.Contains(m, "gemini-2")
}
