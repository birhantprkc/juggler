//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

const (
	DefaultContextWindow   = 128000
	DefaultMaxOutputTokens = 16384
)

// ModelContextWindows is the static context-window map exposed via
// ProviderInfo.ModelContextWindows for the providers settings UI.
var ModelContextWindows = map[string]int{
	"gpt-5.6":       DefaultContextWindow,
	"gpt-5.6-sol":   DefaultContextWindow,
	"gpt-5.6-terra": DefaultContextWindow,
	"gpt-5.6-luna":  DefaultContextWindow,
	"gpt-5.1-codex": DefaultContextWindow,
	"gpt-5.2-codex": DefaultContextWindow,
}
