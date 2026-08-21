//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

// ModelRef points to a concrete (provider, model) pair.
// An empty Provider or Model means no model is resolvable.
type ModelRef struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	// Thinking is the optional thinking/reasoning-effort level, named in the
	// provider's own vocabulary; empty ⇒ the model's default level.
	// Old persisted files without the field load as empty — no migration.
	Thinking string `json:"thinking,omitempty"`
	// ServiceTier is the optional serving class, named by the id the model
	// advertised (e.g. "priority"); empty ⇒ standard serving. Loads as empty
	// from files written before it existed — no migration.
	ServiceTier string `json:"serviceTier,omitempty"`
}
