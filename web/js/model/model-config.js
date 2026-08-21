//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Helpers for the `modelConfig` shape stored on threads / conversations. A
 * modelConfig is either null/undefined (inherit from parent / unset) or a
 * concrete { provider, model } pair, optionally carrying a `thinking` level
 * (the provider's own native string; absent ⇒ provider default) and a
 * `serviceTier` (an id the model advertised; absent ⇒ standard serving).
 *
 * `resolveConfig` annotates a config with its availability status against the
 * current provider list so UI code has one place to check.
 *
 * Status values:
 *   - 'ok'                    — provider available and model present
 *   - 'unconfigured'          — provider has no API key
 *   - 'unknown-model'         — provider exists but its `model` is not in the current list
 *   - 'unavailable-provider'  — provider entry not in /api/providers at all
 */

/**
 * @typedef {{provider: string, model: string, thinking?: string, serviceTier?: string}} ConcreteModelConfig
 * @typedef {ConcreteModelConfig | null | undefined} ModelConfigShape
 * @typedef {{
 *   provider: string,
 *   model: string,
 *   thinking?: string,
 *   serviceTier?: string,
 *   status: 'ok'|'unconfigured'|'unknown-model'|'unavailable-provider'
 * }} ResolvedConfig
 */

/**
 * Resolve a modelConfig to a uniform shape with availability status.
 * @param {ModelConfigShape} cfg
 * @param {Array<{name: string, available: boolean, modelsWithContext?: Array<{id: string}>}>} providers
 * @returns {ResolvedConfig | null} null if cfg is null/undefined, otherwise resolved details
 */
export function resolveConfig(cfg, providers) {
  if (!cfg) return null;
  const status = checkAvailability(cfg.provider, cfg.model, providers);
  // Carry both dials through unchanged (either may be undefined). They are
  // tweaks on the concrete pair, not part of availability — the UI decides
  // whether the selected model actually advertises the level or the tier.
  return {
    provider: cfg.provider,
    model: cfg.model,
    thinking: cfg.thinking,
    serviceTier: cfg.serviceTier,
    status,
  };
}

/**
 * @param {string} providerName
 * @param {string} modelId
 * @param {Array<{name: string, available: boolean, modelsWithContext?: Array<{id: string}>}>} providers
 * @returns {'ok'|'unconfigured'|'unknown-model'|'unavailable-provider'} availability status
 */
function checkAvailability(providerName, modelId, providers) {
  if (!providers || providers.length === 0) {
    // Provider list not loaded yet — assume ok rather than flashing warnings
    return 'ok';
  }
  const provider = providers.find(pp => pp.name === providerName);
  if (!provider) return 'unavailable-provider';
  if (!provider.available) return 'unconfigured';
  const models = provider.modelsWithContext || [];
  if (models.length > 0 && !models.some(m => m.id === modelId)) {
    return 'unknown-model';
  }
  return 'ok';
}
