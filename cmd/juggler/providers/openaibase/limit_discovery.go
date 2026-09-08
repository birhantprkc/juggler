//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/json"

	"juggler/cmd/juggler/providers/utils"
)

// The OpenAI model schema is four fields — id, object, created, owned_by — and
// carries no limits, which is why a client that reads only the typed struct has
// to fall back on a compiled-in table for every provider. But almost every
// OpenAI-COMPATIBLE server adds its own limit fields to the same rows, and the
// SDK keeps the untouched JSON alongside the parsed struct. So the numbers are
// already in hand on every model list; they were simply being dropped.
//
// The field names below are what real servers publish. Each is only ever read
// from the shape that server actually sends, so an unrelated server that
// happens to use the same key still gets the same meaning:
//
//	max_model_len                 vLLM (and SGLang, which copies its shape)
//	meta.n_ctx / meta.n_ctx_train llama.cpp llama-server
//	loaded_context_length         LM Studio (the window the instance loaded with)
//	max_context_length            LM Studio (architecture max), Mistral
//	context_window                Groq
//	context_length                Together, xAI, Moonshot, Fireworks, OpenRouter
//	contextLength                 Fireworks' control-plane route (camelCase)
//	capabilities.limits.*         GitHub Copilot
//	max_input_tokens              LiteLLM, Anthropic
//	inputTokenLimit               Gemini
//	metadata.context_length       DeepInfra
//
// Precedence runs from the most specific description of the running server to
// the most theoretical. A window the server says it is SERVING beats one it
// says the model could support: llama.cpp started with -c 8192 on a 128k model
// reports n_ctx 8192 and n_ctx_train 131072, and only the first of those is a
// promise. Same for LM Studio, where a model loaded at a smaller window still
// advertises its architectural max.
var windowKeys = [][]string{
	{"max_model_len"},
	{"meta", "n_ctx"},
	{"loaded_context_length"},
	{"context_window"},
	{"context_length"},
	{"max_context_length"},
	{"contextLength"},
	{"capabilities", "limits", "max_prompt_tokens"},
	{"capabilities", "limits", "max_context_window_tokens"},
	{"max_input_tokens"},
	{"inputTokenLimit"},
	{"metadata", "context_length"},
	{"meta", "n_ctx_train"},
}

// outputKeys are the fields that name an output ceiling, in the same order of
// preference. `max_tokens` is deliberately absent — see DiscoverLimits.
var outputKeys = [][]string{
	{"max_completion_tokens"},
	{"top_provider", "max_completion_tokens"},
	{"max_output_tokens"},
	{"capabilities", "limits", "max_output_tokens"},
	{"outputTokenLimit"},
	{"metadata", "max_tokens"},
}

// DiscoverLimits reads the token limits a model row publishes about itself,
// returning a zero value for the many endpoints that publish none.
//
// Three rules keep it from inventing numbers:
//
// A bare `max_tokens` is read only when the row also carries a window. The
// name means three different things in the wild — the output ceiling on
// Anthropic and LiteLLM, and the CONTEXT WINDOW on DeepInfra's native model
// list — and the two readings differ by two orders of magnitude. Where a
// window is already known the field is unambiguously the output cap; where it
// is the only limit in the row, it is skipped rather than guessed, because
// guessing wrong either throttles every answer or overruns the window.
//
// A value at or below zero is unknown, never a limit. Anthropic's own
// documentation shows `max_input_tokens: 0`, and xAI, OpenRouter, Mistral and
// DeepInfra all type theirs nullable.
//
// Where a row reports both an overall window and the routed provider's smaller
// one (OpenRouter), the smaller wins: it describes the machine the request
// will actually land on.
func DiscoverLimits(rawJSON string) utils.Limits {
	if rawJSON == "" {
		return utils.Limits{}
	}
	var row map[string]any
	if err := json.Unmarshal([]byte(rawJSON), &row); err != nil {
		return utils.Limits{}
	}

	var limits utils.Limits
	for _, path := range windowKeys {
		if value, ok := positiveInt(row, path...); ok {
			limits.ContextWindow = value
			break
		}
	}
	// OpenRouter reports the catalog-wide context_length and the routed
	// provider's own, and they can disagree. Only the one that will serve the
	// request is a limit.
	if routed, ok := positiveInt(row, "top_provider", "context_length"); ok {
		if limits.ContextWindow <= 0 || routed < limits.ContextWindow {
			limits.ContextWindow = routed
		}
	}

	for _, path := range outputKeys {
		if value, ok := positiveInt(row, path...); ok {
			limits.MaxOutput = value
			break
		}
	}
	if limits.MaxOutput <= 0 && limits.ContextWindow > 0 {
		if value, ok := positiveInt(row, "max_tokens"); ok {
			limits.MaxOutput = value
		}
	}

	if limits.ContextWindow > 0 {
		limits.Source = utils.LimitSourceEndpoint
	}
	return limits
}

// positiveInt walks a path of object keys and returns the number at the end of
// it. Anything that is not a positive number — absent, null, a string, an
// object, zero, negative — reports not-found, so a caller never has to
// distinguish "the server said nothing" from "the server said nothing usable".
func positiveInt(row map[string]any, path ...string) (int, bool) {
	var current any = row
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return 0, false
		}
		if current, ok = object[key]; !ok {
			return 0, false
		}
	}
	number, ok := current.(float64)
	if !ok || number <= 0 {
		return 0, false
	}
	return int(number), true
}
