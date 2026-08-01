//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side cache of provider account/plan usage stats (quota windows).
 *
 * Unlike the provider/model list, usage is pull-based: there is no WS push, so
 * this module owns a debounced GET of `/api/providers/usage?provider=<name>`.
 * Callers only ever display the active conversation's provider, so `refresh()`
 * fetches ONE provider at a time — never a fan-out across providers the user
 * isn't looking at (fetching an inactive provider's usage is wasted work and, for
 * CLI-backed providers, can even provoke a login). The cache is
 * keyed by provider so the model selector and the usage sidebar card can track
 * different providers without evicting each other. Each provider's live fetch is
 * debounced to one call per REFRESH_INTERVAL_MS and de-dupes concurrent callers.
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

/**
 * Minimum gap between live fetches per provider; repeated opens within this
 * window reuse the cache. Aligned with the upstream usage endpoints' own refresh
 * cadence (the ChatGPT/Codex `/usage` backend only recomputes its windows every
 * few minutes and serves an empty/placeholder payload to polls in between), so
 * we never hammer a rate-limited source. Empty responses that do slip through are
 * absorbed by the last-known-good retention in refresh().
 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** @type {Map<string, UsageStats|null>} provider name → latest snapshot (null = fetched, none reported). */
const _byProvider = new Map();
/** @type {Map<string, number>} provider name → last live-fetch timestamp. */
const _lastFetch = new Map();
/** @type {Map<string, Promise<UsageStats|null>>} provider name → in-flight fetch. */
const _inFlight = new Map();

const usageStatsCache = {
  /**
   * Latest usage stats for one provider, or null if none cached / none reported.
   * @param {string} providerName
   * @returns {UsageStats|null} The provider's usage snapshot, or null.
   */
  get(providerName) {
    if (!providerName) return null;
    return _byProvider.get(providerName) || null;
  },

  /**
   * Whether a usage snapshot has been received for a provider (even an empty one).
   * @param {string} providerName
   * @returns {boolean} True once at least one fetch for it has resolved.
   */
  hasData(providerName) {
    return !!providerName && _byProvider.has(providerName);
  },

  /**
   * Fetch one provider's usage stats, debounced to one live call per
   * REFRESH_INTERVAL_MS. Concurrent callers share the in-flight request. Resolves
   * with the provider's cached snapshot (refreshed or not). Never rejects — on
   * failure it resolves with the last snapshot, or null if none exists yet. A
   * falsy providerName is a no-op that resolves null.
   * @param {string} providerName
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<UsageStats|null>} The provider's cached snapshot.
   */
  async refresh(providerName, { force = false } = {}) {
    if (!providerName) return null;

    const now = Date.now();
    const last = _lastFetch.get(providerName) || 0;
    if (!force && _byProvider.has(providerName) && now - last < REFRESH_INTERVAL_MS) {
      return _byProvider.get(providerName) || null;
    }
    const pending = _inFlight.get(providerName);
    if (pending) return pending;

    const fetchPromise = (async () => {
      try {
        const resp = await fetch(`/api/providers/usage?provider=${encodeURIComponent(providerName)}`);
        if (!resp.ok) throw new Error(`usage fetch failed: ${resp.status}`);
        const data = await resp.json();
        /** @type {UsageStats[]} */
        const list = Array.isArray(data.usage) ? data.usage : [];
        const snapshot = list.find(u => u && u.provider === providerName) || null;
        // Retain the last known-good snapshot when this fetch came back empty.
        // The upstream usage endpoint refreshes only every few minutes and hands
        // an empty/placeholder payload to polls in between; blanking the cached
        // meters on those responses is what makes the display flip-flop between
        // real numbers and "no usage data". Overwrite only when the new snapshot
        // actually carries stats, or when we have no good value to preserve (first
        // load — store the empty result so hasData() flips true and the UI can
        // show its own empty state).
        const nextHasStats = !!(snapshot && Array.isArray(snapshot.stats) && snapshot.stats.length > 0);
        const prev = _byProvider.get(providerName);
        const prevHasStats = !!(prev && Array.isArray(prev.stats) && prev.stats.length > 0);
        if (nextHasStats || !prevHasStats) {
          _byProvider.set(providerName, snapshot);
        }
        _lastFetch.set(providerName, Date.now());
        return _byProvider.get(providerName) || null;
      } catch (err) {
        console.warn('[usageStatsCache] refresh failed:', err);
        return _byProvider.get(providerName) || null;
      } finally {
        _inFlight.delete(providerName);
      }
    })();
    _inFlight.set(providerName, fetchPromise);
    return fetchPromise;
  },
};

export default usageStatsCache;
