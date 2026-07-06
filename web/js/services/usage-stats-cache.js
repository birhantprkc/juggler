//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side cache of provider account/plan usage stats (quota windows).
 *
 * Unlike the provider/model list, usage is pull-based: there is no WS push, so
 * this module owns a debounced GET of `/api/providers/usage`. The endpoint makes
 * live upstream calls per credentialed provider, so `refresh()` collapses bursts
 * to at most one fetch per REFRESH_INTERVAL_MS and de-dupes concurrent callers.
 * The model selector calls `refresh()` each time its menu opens; the 10s floor
 * keeps repeated opens from hammering the upstream APIs.
 */

/**
 * @typedef {object} UsageStat
 * @property {string} name - e.g. "Session (5h)", "Week (7d)", "Balance"
 * @property {number} [usedPercent] - 0..100 where known; absent ⇒ no meter (e.g. a raw balance)
 * @property {string} [detail] - Absolute display value, e.g. "$12.34 left"
 * @property {string} [resetsAt] - ISO timestamp of window reset, if provided
 * @property {number} [windowSecs] - Window duration in seconds, if known
 * @property {string} [category] - e.g. "primary", "weekly", "model", "code_review", "balance"
 * @typedef {object} UsageStats
 * @property {string} provider - Provider name (e.g. "openaicodex")
 * @property {string} [plan] - Plan label, if reported
 * @property {string} updatedAt - ISO timestamp of the snapshot
 * @property {UsageStat[]} stats - Per-window usage signals
 */

/** Minimum gap between live fetches; repeated opens within this window reuse the cache. */
const REFRESH_INTERVAL_MS = 10_000;

/** @type {{ usage: UsageStats[], errors: Record<string, string> }|null} */
let _cache = null;
let _lastFetch = 0;
/** @type {Promise<{ usage: UsageStats[], errors: Record<string, string> }>|null} */
let _inFlight = null;

const usageStatsCache = {
  /**
   * Latest usage stats for one provider, or null if none cached / none reported.
   * @param {string} providerName
   * @returns {UsageStats|null} The provider's usage snapshot, or null.
   */
  get(providerName) {
    if (!_cache || !providerName) return null;
    return _cache.usage.find(u => u.provider === providerName) || null;
  },

  /**
   * Whether any usage snapshot has been received (even an empty one).
   * @returns {boolean} True once at least one fetch has resolved.
   */
  hasData() {
    return _cache !== null;
  },

  /**
   * Fetch usage stats, debounced to one live call per REFRESH_INTERVAL_MS.
   * Concurrent callers share the in-flight request. Resolves with the cached
   * snapshot (refreshed or not). Never rejects — on failure it resolves with
   * the last snapshot, or an empty one if none exists yet.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ usage: UsageStats[], errors: Record<string, string> }>} The cached snapshot.
   */
  async refresh({ force = false } = {}) {
    const now = Date.now();
    if (!force && _cache && now - _lastFetch < REFRESH_INTERVAL_MS) {
      return _cache;
    }
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      try {
        const resp = await fetch('/api/providers/usage');
        if (!resp.ok) throw new Error(`usage fetch failed: ${resp.status}`);
        const data = await resp.json();
        _cache = {
          usage: Array.isArray(data.usage) ? data.usage : [],
          errors: (data.errors && typeof data.errors === 'object') ? data.errors : {},
        };
        _lastFetch = Date.now();
        return _cache;
      } catch (err) {
        console.warn('[usageStatsCache] refresh failed:', err);
        return _cache || { usage: [], errors: {} };
      } finally {
        _inFlight = null;
      }
    })();
    return _inFlight;
  },
};

export default usageStatsCache;
