//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * recent-models service unit tests.
 *
 * Model + thinking level is one identity: entries carry an optional `thinking`
 * whose absence (never `''`) means "the model's default level", and the dedupe
 * key is the provider+model+thinking triple, capped at 6. The service talks to
 * GET/POST /api/recent-models, so `window.fetch` is stubbed (and restored in a
 * finally) per the convention in connectivity-test / extensions-disabled-test;
 * each test seeds the module's in-memory cache to a known state through
 * `refresh()` against the stub, keeping tests order-independent.
 * @module unit-tests/recent-models-test
 */

import { assert } from '../utilities/test-helpers.js';
import recentModels from '../../js/services/recent-models.js';

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
 * Seed the service's in-memory cache with exactly `models` by refreshing
 * against a stubbed server.
 * @param {any[]} models - Raw entries the fake GET returns.
 * @returns {Promise<void>}
 */
async function seed(models) {
  const stub = stubFetch(() => ({ ok: true, json: async () => ({ models }) }));
  try {
    await recentModels.refresh();
  } finally {
    stub.restore();
  }
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

  await run('refresh() sanitizes malformed entries and normalises thinking to absent', async () => {
    await seed([
      { provider: 'anthropic', model: 'op-1', thinking: 'high' },
      { provider: 'anthropic', model: 'op-2', thinking: '' },       // '' ⇒ key dropped
      { provider: 'anthropic', model: 'op-3', thinking: 42 },        // non-string ⇒ key dropped
      { provider: 'anthropic' },                                     // no model ⇒ dropped
      { model: 'orphan' },                                           // no provider ⇒ dropped
      null,                                                          // junk ⇒ dropped
      { provider: 'openai', model: 'gp-1', extra: 'junk' },          // unknown keys stripped
    ]);
    const list = recentModels.get();
    assert(list.length === 4, `expected 4 sanitized entries, got ${list.length}`);
    assert(list[0].thinking === 'high', 'a valid thinking level round-trips');
    assert(!('thinking' in list[1]), `empty-string thinking must become ABSENT, got ${JSON.stringify(list[1])}`);
    assert(!('thinking' in list[2]), `non-string thinking must become absent, got ${JSON.stringify(list[2])}`);
    assert(Object.keys(list[3]).length === 2 && list[3].provider === 'openai' && list[3].model === 'gp-1',
      `unknown keys must be stripped, got ${JSON.stringify(list[3])}`);
  });

  await run('getAvailable() keeps only models present on available providers', async () => {
    await seed([
      { provider: 'ready', model: 'kept' },
      { provider: 'ready', model: 'removed' },
      { provider: 'off', model: 'hidden' },
      { provider: 'missing', model: 'ghost' },
    ]);
    const list = recentModels.getAvailable([
      { name: 'ready', available: true, modelsWithContext: [{ id: 'kept' }] },
      { name: 'off', available: false, modelsWithContext: [{ id: 'hidden' }] },
    ]);
    assert(list.length === 1 && list[0].provider === 'ready' && list[0].model === 'kept',
      `expected only ready/kept, got ${JSON.stringify(list)}`);
    assert(recentModels.get().length === 4, 'availability filtering must not mutate persisted recents');
  });

  await run('refresh() with a non-array payload yields an empty list', async () => {
    await seed([{ provider: 'a', model: 'm' }]);
    await seed(/** @type {any} */ ('not-an-array'));
    assert(recentModels.get().length === 0, 'non-array models must sanitize to []');
  });

  await run('refresh() caps the list at 6', async () => {
    await seed(Array.from({ length: 8 }, (_, i) => ({ provider: 'p', model: `m${i}` })));
    const list = recentModels.get();
    assert(list.length === 6, `expected cap of 6, got ${list.length}`);
    assert(list[0].model === 'm0' && list[5].model === 'm5', 'the first 6 entries survive, in order');
  });

  await run('refresh() failures keep the existing cache', async () => {
    await seed([{ provider: 'keep', model: 'me' }]);
    const notOk = stubFetch(() => ({ ok: false, json: async () => ({}) }));
    try {
      await recentModels.refresh();
    } finally {
      notOk.restore();
    }
    assert(recentModels.get()[0].model === 'me', 'a non-ok response must not clobber the cache');
    const boom = stubFetch(() => { throw new Error('network blip'); });
    try {
      await recentModels.refresh();
    } finally {
      boom.restore();
    }
    assert(recentModels.get()[0].model === 'me', 'a thrown fetch must not clobber the cache');
  });

  await run('same model at two levels is two entries; record() dedupes by the triple', async () => {
    await seed([
      { provider: 'a', model: 'm' },
      { provider: 'a', model: 'm', thinking: 'high' },
    ]);
    const stub = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    try {
      await recentModels.record('a', 'm', 'high');
      let list = recentModels.get();
      assert(list.length === 2, `the triple dedupes against its own row only, got ${list.length} rows`);
      assert(list[0].thinking === 'high' && !('thinking' in list[1]),
        `the high row moved to front, the bare row survived — got ${JSON.stringify(list)}`);

      await recentModels.record('a', 'm');
      list = recentModels.get();
      assert(list.length === 2 && !('thinking' in list[0]) && list[1].thinking === 'high',
        `recording the bare pair reorders only the bare row — got ${JSON.stringify(list)}`);
    } finally {
      stub.restore();
    }
  });

  await run('record() prepends, caps at 6, and POSTs the triple', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => ({ provider: 'p', model: `m${i}` })));
    const stub = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    try {
      await recentModels.record('z', 'zz', 'low');
    } finally {
      stub.restore();
    }
    const list = recentModels.get();
    assert(list.length === 6, `cap must hold after record, got ${list.length}`);
    assert(list[0].provider === 'z' && list[0].model === 'zz' && list[0].thinking === 'low',
      'the new triple lands at the front');
    assert(!list.some((e) => e.model === 'm5'), 'the oldest entry falls off the end');
    assert(stub.calls.length === 1 && stub.calls[0].url === '/api/recent-models'
      && stub.calls[0].opts?.method === 'POST', 'exactly one POST to /api/recent-models');
    const body = JSON.parse(stub.calls[0].opts.body);
    assert(body.provider === 'z' && body.model === 'zz' && body.thinking === 'low',
      `POST body must carry the triple, got ${stub.calls[0].opts.body}`);
  });

  await run('record() without thinking posts and caches no thinking key', async () => {
    await seed([]);
    const stub = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    try {
      await recentModels.record('p', 'q');
    } finally {
      stub.restore();
    }
    const body = JSON.parse(stub.calls[0].opts.body);
    assert(!('thinking' in body), `POST body must omit thinking entirely, got ${stub.calls[0].opts.body}`);
    assert(!('thinking' in recentModels.get()[0]), 'the cached entry must omit thinking entirely');
  });

  await run('record() updates the cache optimistically even when the POST fails', async () => {
    await seed([]);
    const stub = stubFetch(() => { throw new Error('offline'); });
    try {
      await recentModels.record('opt', 'imist', 'max');
    } finally {
      stub.restore();
    }
    const list = recentModels.get();
    assert(list.length === 1 && list[0].provider === 'opt' && list[0].thinking === 'max',
      'the optimistic cache update must survive a failed POST');
  });

  await run('record() ignores empty provider/model', async () => {
    await seed([]);
    const stub = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    try {
      await recentModels.record('', 'm');
      await recentModels.record('p', '');
    } finally {
      stub.restore();
    }
    assert(recentModels.get().length === 0 && stub.calls.length === 0,
      'incomplete pairs must neither cache nor POST');
  });

  return { passed, failed, errors };
}
