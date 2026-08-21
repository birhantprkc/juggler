//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

const (
	// DefaultContextWindow is the last-resort admission limit for a model the
	// catalog lists without any window of its own. It is deliberately
	// conservative: an under-estimate compacts early, an over-estimate
	// overruns the model's real limit mid-turn.
	DefaultContextWindow   = 128000
	DefaultMaxOutputTokens = 16384

	// catalogContextWindow is the window the ChatGPT-plan catalog reports for
	// every model it currently lists.
	catalogContextWindow = 272000
)

// ModelContextWindows mirrors the ChatGPT-plan catalog's visible slugs. It
// serves the providers settings UI via ProviderInfo.ModelContextWindows and
// backs withStaticFallbackModels, so it is the entire model list a user sees
// while signed out or when /models is unreachable. A slug the catalog has
// retired must be removed from here: left in place it stays selectable long
// after the backend stops accepting it.
var ModelContextWindows = map[string]int{
	"gpt-5.6-sol":   catalogContextWindow,
	"gpt-5.6-terra": catalogContextWindow,
	"gpt-5.6-luna":  catalogContextWindow,
	"gpt-5.5":       catalogContextWindow,
	"gpt-5.4":       catalogContextWindow,
	"gpt-5.4-mini":  catalogContextWindow,
}
