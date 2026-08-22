//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Recently-used concrete models for quick re-access from the model selector.
 * Most-recent first, deduped by provider+model+thinking (the same model at two
 * thinking levels is two distinct entries), capped at MAX. An absent
 * `thinking` means the model's default level.
 *
 * Persisted SERVER-SIDE (GET/POST /api/recent-models), not in browser
 * localStorage: localStorage is partitioned by origin (including port), so an
 * app relaunch that lands the spawned server on a different port would reset
 * it. Server-side storage survives both. The persisted list is independent of
 * current provider availability; callers use {@link getAvailable} when building
 * selectable UI.
 *
 * An in-memory cache backs the synchronous `get()` the model selector needs at
 * render time; `refresh()` repopulates it from the server (call it when opening
 * the menu), and `record()` updates it optimistically before POSTing.
 */

import { fetchJson } from './http.js';

const MAX = 6;

/** @typedef {{ provider: string, model: string, thinking?: string }} RecentModel */

/** @type {RecentModel[]} */
let _cache = [];

/**
 * @param {unknown} data
 * @returns {RecentModel[]} Sanitised, capped list.
 */
function sanitize(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter(x => x && typeof x.provider === 'string' && typeof x.model === 'string')
    .map(x => (typeof x.thinking === 'string' && x.thinking !== ''
      ? { provider: x.provider, model: x.model, thinking: x.thinking }
      : { provider: x.provider, model: x.model }))
    .slice(0, MAX);
}

const recentModels = {
  /**
   * Recently-used models, most-recent first, from the in-memory cache.
   * Synchronous so it can be read during render; call {@link refresh} to
   * repopulate from the server first.
   * @returns {RecentModel[]} Cached recent models.
   */
  get() {
    return _cache;
  },

  /**
   * Cached recent models whose provider and model are present in the supplied
   * provider snapshot. Unavailable providers are excluded because these entries
   * back selection UI rather than history display — and so are models the user
   * has hidden, so ⌥⌘M cycling and the Recent list never land on one.
   * @param {Array<{name: string, available: boolean, modelsWithContext?: Array<{id: string, hidden?: boolean}>}>} providers
   * @returns {RecentModel[]} Selectable recent models.
   */
  getAvailable(providers) {
    const available = new Map(providers
      .filter(provider => provider.available)
      .map(provider => [provider.name, new Set((provider.modelsWithContext || [])
        .filter(model => !model.hidden)
        .map(model => model.id))]));
    return _cache.filter(entry => available.get(entry.provider)?.has(entry.model));
  },

  /**
   * Reload the list from the server into the in-memory cache.
   * @returns {Promise<RecentModel[]>} The refreshed list (also cached).
   */
  async refresh() {
    // Network/parse failure — keep the existing cache; recents are best-effort
    // convenience state.
    const data = await fetchJson('/api/recent-models', { fallback: null });
    if (data) _cache = sanitize(data.models);
    return _cache;
  },

  /**
   * Record a concrete model selection, moving it to the front. Entries dedupe
   * by the provider+model+thinking triple. Updates the cache optimistically,
   * then persists to the server.
   * @param {string} provider
   * @param {string} model
   * @param {string} [thinking] Canonical thinking level; absent/empty means
   *   the model's default level.
   * @returns {Promise<void>}
   */
  async record(provider, model, thinking) {
    if (!provider || !model) return;
    const entry = thinking ? { provider, model, thinking } : { provider, model };
    _cache = [entry, ..._cache.filter(x =>
      !(x.provider === provider && x.model === model && (x.thinking || '') === (thinking || '')))].slice(0, MAX);
    // Best-effort persistence; the optimistic cache update already reflects the
    // pick for this session.
    await fetchJson('/api/recent-models', { method: 'POST', body: entry, fallback: null });
  },
};

export default recentModels;
