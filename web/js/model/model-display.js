//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model display-name helpers.
 *
 * Naming is the provider's job, not the app's: each provider ships a
 * `displayName` on its model list ("Claude Opus (CLI)", "GPT-5 (ChatGPT plan)",
 * "Gemini 2.5 Pro"). These helpers just render it, falling back to the raw wire
 * id only when a provider supplies no name. No prettifying or per-provider
 * special-casing lives here — that belongs in the provider (see
 * cmd/juggler/providers/.../ and providers/utils.ModelDisplayName).
 */

/**
 * Strip provider namespace noise from a raw model id, for the no-displayName
 * fallback only.
 * @param {string} modelId
 * @returns {string} Base model label.
 */
export function baseModelLabel(modelId) {
  if (!modelId) return '';
  return modelId.startsWith('models/') ? modelId.substring(7) : modelId;
}

/**
 * Render a model's label: the provider-supplied display name when present, else
 * the bare id.
 * @param {string|undefined} displayName Provider-supplied label from the model list.
 * @param {string} modelId Raw wire id, used only as a fallback.
 * @returns {string} Display label.
 */
export function modelLabel(displayName, modelId) {
  return (displayName && displayName.trim()) || baseModelLabel(modelId);
}

/**
 * Render a model's label given only a `{provider, model}` ref, resolving the
 * provider-supplied display name from a providers list. Use at call sites
 * (recents, the current-model chip, default-model status) that don't already
 * hold the model object.
 * @param {Array<{name: string, modelsWithContext?: Array<{id: string, displayName?: string}>}>} providers
 * @param {string} providerName
 * @param {string} modelId
 * @returns {string} Display label.
 */
export function modelLabelFromList(providers, providerName, modelId) {
  const entry = providers
    ?.find(p => p.name === providerName)
    ?.modelsWithContext?.find(m => m.id === modelId);
  return modelLabel(entry?.displayName, modelId);
}
