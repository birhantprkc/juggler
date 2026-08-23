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
 * Build a model config from a pair plus its two optional dials, omitting either
 * when empty so standard serving and the default thinking level are the absence
 * of a key rather than an empty string.
 *
 * Every write path goes through this. They each rebuild the object from scratch
 * rather than spreading the previous one, so a dial that isn't named here is
 * dropped — one function means adding a third dial can't leave one path behind.
 * @param {string} provider
 * @param {string} model
 * @param {string} [thinking] - Native provider level; '' for the model's default.
 * @param {string} [serviceTier] - Advertised tier id; '' for standard serving.
 * @returns {ConcreteModelConfig} The config to write.
 */
export function buildModelConfig(provider, model, thinking, serviceTier) {
  /** @type {ConcreteModelConfig} */
  const next = { provider, model };
  if (thinking) next.thinking = thinking;
  if (serviceTier) next.serviceTier = serviceTier;
  return next;
}

/**
 * Structural equality for two configs, with both dials normalised (absent ===
 * '') and "nothing selected" spelled either null or undefined. The doc hands
 * out a freshly built object on every read, so object identity says nothing
 * about whether the selection moved — this is what the UI compares before it
 * agrees to touch anything.
 * @param {ModelConfigShape} a - A model config (or null).
 * @param {ModelConfigShape} b - A model config (or null).
 * @returns {boolean} True when both name the same provider, model, level and tier.
 */
export function sameModelConfig(a, b) {
  if (!a && !b) return true;
  return a === b || (!!a && !!b
    && a.provider === b.provider && a.model === b.model
    && (a.thinking || '') === (b.thinking || '')
    && (a.serviceTier || '') === (b.serviceTier || ''));
}

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
