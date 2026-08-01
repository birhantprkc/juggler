//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * usage-stats-cache service unit tests.
 *
 * The upstream usage endpoints (notably ChatGPT/Codex `/usage`) refresh their
 * quota windows only every few minutes and serve an empty/placeholder payload to
 * polls in between. The cache must therefore RETAIN the last known-good snapshot
 * across such empty responses instead of blanking the meters — otherwise the UI
 * flip-flops between real numbers and "no usage data". These tests drive
 * `refresh()` against a stubbed `window.fetch` (restored in a finally, per the
 * connectivity-test convention). The cache is a module singleton with real-time
 * debouncing, so every call passes `force: true` to bypass the per-provider gap
 * and each test uses a unique provider name to stay order-independent.
 * @module unit-tests/usage-stats-cache-test
 */

import { assert } from '../utilities/test-helpers.js';
import usageStatsCache from '../../js/services/usage-stats-cache.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Stub `window.fetch`, recording every call. The handler decides the response
 * (or throws to simulate a network failure).
 * @param {(url: string, opts: any) => any} handler - Response factory.
 * @returns {{calls: {url: string, opts: any}[], restore: () => void}} The
 *   recorded calls and a restore function (call in a finally).
 */
function stubFetch(handler) {
  const orig = window.fetch;
  /** @type {{url: string, opts: any}[]} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  });
  return { calls, restore: () => { window.fetch = orig; } };
}

/**
 * Force one `refresh()` for `provider` against a stubbed server that returns
 * `usageArray` as the `usage` field (or throws when `throwErr` is set).
 * @param {string} provider - Provider name to refresh.
 * @param {any[]|null} usageArray - The `usage` array the fake server returns; null ⇒ non-ok.
 * @param {boolean} [throwErr] - When true, the fetch throws (network failure).
 * @returns {Promise<import('../../js/services/usage-stats-cache.js').UsageStats|null>} The resolved snapshot.
 */
async function refreshWith(provider, usageArray, throwErr = false) {
  const stub = stubFetch(() => {
    if (throwErr) throw new Error('network blip');
    if (usageArray === null) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, json: async () => ({ usage: usageArray, errors: {} }) };
  });
  try {
    return await usageStatsCache.refresh(provider, { force: true });
  } finally {
    stub.restore();
  }
}

/**
 * A usage snapshot carrying one meter for `provider`.
 * @param {string} provider - Provider name.
 * @param {number} pct - used_percent for the single window.
 * @returns {import('../../js/services/usage-stats-cache.js').UsageStats} A one-meter snapshot.
 */
function snapshotWith(provider, pct) {
  return {
    provider,
    plan: 'pro',
    updatedAt: new Date().toISOString(),
    stats: [{ name: 'Session (5h)', usedPercent: pct, category: 'primary' }],
  };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('an empty successful response retains the last known-good snapshot', async () => {
    const p = 'codex-retain';
    await refreshWith(p, [snapshotWith(p, 42)]);
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 42, 'good snapshot must be cached');

    // A rate-limited poll: server returns HTTP 200 but an empty usage array.
    const after = await refreshWith(p, []);
    assert(after?.stats?.[0]?.usedPercent === 42,
      'refresh() must resolve with the retained snapshot, not the empty one');
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 42,
      'an empty response must NOT blank a meter we already have');
  });

  await run('a fresh snapshot with stats overwrites the retained one', async () => {
    const p = 'codex-overwrite';
    await refreshWith(p, [snapshotWith(p, 10)]);
    await refreshWith(p, []); // empty — retained at 10
    await refreshWith(p, [snapshotWith(p, 75)]);
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 75,
      'a non-empty snapshot must replace the retained value');
  });

  await run('first-load empty marks hasData true but reports no snapshot', async () => {
    const p = 'codex-firstempty';
    assert(!usageStatsCache.hasData(p), 'precondition: provider has no data yet');
    const snap = await refreshWith(p, []);
    assert(snap === null, 'first empty load resolves null (nothing to retain)');
    assert(usageStatsCache.hasData(p),
      'hasData() must flip true so the UI shows its own empty state instead of "loading"');
    assert(usageStatsCache.get(p) === null, 'get() stays null until real stats arrive');
  });

  await run('a snapshot whose stats emptied out is retained, not cleared', async () => {
    const p = 'codex-emptystats';
    await refreshWith(p, [snapshotWith(p, 55)]);
    // Same provider present in the payload but with an empty stats array — the
    // server never sends this (it filters len==0), but the cache must be robust.
    await refreshWith(p, [{ provider: p, plan: 'pro', updatedAt: new Date().toISOString(), stats: [] }]);
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 55,
      'a zero-stat snapshot must not clobber the last known-good');
  });

  await run('non-ok and thrown fetches keep the existing snapshot', async () => {
    const p = 'codex-neterr';
    await refreshWith(p, [snapshotWith(p, 33)]);
    await refreshWith(p, null); // HTTP 429
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 33, 'a non-ok response must not clobber the cache');
    const afterThrow = await refreshWith(p, null, true); // thrown
    assert(afterThrow?.stats?.[0]?.usedPercent === 33, 'a thrown fetch resolves with the retained snapshot');
    assert(usageStatsCache.get(p)?.stats?.[0]?.usedPercent === 33, 'a thrown fetch must not clobber the cache');
  });

  await run('a falsy provider name is a no-op that resolves null', async () => {
    const snap = await usageStatsCache.refresh('', { force: true });
    assert(snap === null, 'empty provider name resolves null without fetching');
  });

  return { passed, failed, errors };
}
