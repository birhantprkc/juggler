//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package utils

// ModelCaps resolves a per-model integer capability — a context window or a
// max-output-tokens cap — from an exact-id override map over a single default.
//
// Every OpenAI-compatible provider with a fixed model catalog (openai, zai,
// deepseek, etc.) used to hand-roll the identical "look up the id, else return
// the default" branch for both dimensions. Centralising it here means a new
// reasoning model is one map entry and no provider can silently fall out of
// step (e.g. raising the default in one place but forgetting the override map).
type ModelCaps struct {
	Default   int
	Overrides map[string]int
}

// Lookup returns the override for model if present, else Default.
func (c ModelCaps) Lookup(model string) int {
	if c.Overrides != nil {
		if v, ok := c.Overrides[model]; ok {
			return v
		}
	}
	return c.Default
}
