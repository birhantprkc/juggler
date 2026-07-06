//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Disabled-plugin fetch tests.
 *
 * `fetchDisabledPluginIds` gates extension-level system-prompt contributions: a
 * disabled extension contributes nothing. A transient `/api/config/plugins`
 * blip that collapsed the disabled set to empty would resurrect a disabled
 * extension's always-on sections for one assembly — flipping the system-prompt
 * bytes and cold-starting claudecode's warm cache. This pins the last-known-good
 * behaviour: a failure preserves the prior successful set; a genuine reload
 * (`resetExtensionsCache`) clears it so fresh state is re-read.
 *
 * Driven directly against `fetchDisabledPluginIds` (not the higher-level
 * aggregator, which awaits a registries-ready signal a headless unit page never
 * raises), with `globalThis.fetch` stubbed and restored in a finally.
 * @module unit-tests/extensions-disabled-test
 */

import { fetchDisabledPluginIds, resetExtensionsCache } from '../../js/services/extensions.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run extensions disabled-set tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  /**
   * @param {Set<string>} set - Set to render
   * @returns {string} Sorted JSON array for error messages
   */
  const show = (set) => JSON.stringify([...set].sort());

  await test('transient failure preserves the last-known-good disabled set', async () => {
    const realFetch = globalThis.fetch;
    try {
      resetExtensionsCache();

      // 1. Successful fetch yields the disabled set and caches it.
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ disabled: ['X'] }) }));
      const first = await fetchDisabledPluginIds();
      assert(first instanceof Set && first.size === 1 && first.has('X'), `first fetch should yield Set{'X'}, got ${show(first)}`);

      // 2. A thrown (transient) failure must serve last-known-good, NOT empty.
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('network blip'); });
      const second = await fetchDisabledPluginIds();
      assert(second instanceof Set && second.size === 1 && second.has('X'), `thrown failure must preserve last-known-good Set{'X'}, got ${show(second)}`);

      // 3. An HTTP not-ok response must also serve last-known-good.
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: false, json: async () => ({}) }));
      const third = await fetchDisabledPluginIds();
      assert(third instanceof Set && third.size === 1 && third.has('X'), `HTTP not-ok must preserve last-known-good Set{'X'}, got ${show(third)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('first-call-ever failure (no prior success) falls back to empty set', async () => {
    const realFetch = globalThis.fetch;
    try {
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('blip'); });
      const out = await fetchDisabledPluginIds();
      assert(out instanceof Set && out.size === 0, `with no prior success a failure must yield empty Set, got ${show(out)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('resetExtensionsCache clears the last-known-good disabled set', async () => {
    const realFetch = globalThis.fetch;
    try {
      // Seed a known-good disabled set.
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ disabled: ['Y'] }) }));
      const seeded = await fetchDisabledPluginIds();
      assert(seeded.has('Y'), `seed should yield Set{'Y'}, got ${show(seeded)}`);

      // A genuine reload clears the cache — a subsequent failure must NOT
      // resurrect the stale 'Y'; it must fall back to empty.
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('blip'); });
      const out = await fetchDisabledPluginIds();
      assert(out instanceof Set && out.size === 0, `after reset, a failure must fall back to empty Set (not stale 'Y'), got ${show(out)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  return { passed, failed, errors };
}
