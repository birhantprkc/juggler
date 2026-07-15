//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package openaicompat exposes a single user-configured provider for any
// gateway that speaks the OpenAI Chat Completions API but isn't one of the
// built-in vendors (LLM proxies, self-hosted gateways, aggregators, …).
// Instead of adding a package per gateway, the user supplies the base URL and
// (optionally) custom request headers from the settings panel; both are read
// live from the credentials store at client-construction time.
package openaicompat

import (
	"encoding/json"
	"strings"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/jlog"
)

// Raw credentials.json keys, written by the settings UI via /api/config. Kept
// in sync with the frontend and server/handlers/config.go, which post/read
// these literal names.
const (
	// BaseURLCredKey holds the gateway base URL, e.g. https://gateway/v1.
	BaseURLCredKey = "openai_compatible_base_url"
	// HeadersCredKey holds a JSON object of extra request headers, e.g.
	// {"User-Agent":"my-app/1.0"}. Empty/invalid ⇒ no extra headers.
	HeadersCredKey = "openai_compatible_headers"
)

// Default context/output caps for models a gateway advertises without
// per-model information. The gateway's /v1/models list supplies the ids; these
// bound them conservatively.
const (
	defaultContextWindow   = 128000
	defaultMaxOutputTokens = 16384
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:          "openai-compatible",
		DisplayName:   "OpenAI-compatible (custom)",
		Description:   "Any gateway that speaks the OpenAI Chat Completions API. Set the base URL and, if your gateway needs them, custom request headers (JSON) below. Models come from the gateway's /v1/models endpoint.",
		ConfigKeyName: "openai_compatible_api_key",
		EnvVarName:    "OPENAI_COMPATIBLE_API_KEY",
		// No APIKeyURL: the key comes from whichever gateway the user points at.
		DisplayProvider:   "OpenAI-compatible",
		ContextWindowCaps: utils.ModelCaps{Default: defaultContextWindow},
		MaxOutputCaps:     utils.ModelCaps{Default: defaultMaxOutputTokens},
		BaseURLFunc:       baseURL,
		HeadersFunc:       headers,
		// Zero-value Quirks: standard OpenAI request shape, the safe default for
		// an arbitrary compatible gateway.
	})
}

// baseURL resolves the configured gateway base URL from the credentials store.
// Trailing slashes are trimmed so the SDK doesn't build "//v1/..." paths.
// Returns "" when unset — the client then errors clearly on first use rather
// than silently hitting api.openai.com.
func baseURL() string {
	store, err := core.NewCredentialsStore()
	if err != nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(store.GetRawKey(BaseURLCredKey)), "/")
}

// headers resolves the user-configured custom request headers (a JSON object)
// from the credentials store. Returns nil when unset, empty, or invalid.
func headers() map[string]string {
	store, err := core.NewCredentialsStore()
	if err != nil {
		return nil
	}
	return parseHeaderJSON(store.GetRawKey(HeadersCredKey))
}

// parseHeaderJSON parses a JSON object of string→string header pairs. Blank
// input returns nil; malformed input is logged and treated as no headers so a
// typo in the settings box never wedges the provider.
func parseHeaderJSON(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed map[string]string
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		jlog.Error("openai-compatible: ignoring invalid custom headers JSON: %v", err)
		return nil
	}
	if len(parsed) == 0 {
		return nil
	}
	return parsed
}
