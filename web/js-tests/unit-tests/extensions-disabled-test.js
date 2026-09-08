//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Disabled-plugin fetch tests.
 *
 * `fetchDisabledPluginIds` is the single reader of `/api/config/plugins`: every
 * registry's disabled split, the extensions catalog, the pin-agent descriptors
 * and the extension-level system-prompt gate all come through it. So what it
 * returns when the config cannot be read decides whether a network blip can
 * switch capabilities on behind the user's back.
 *
 * Two things are pinned here, and they pull in opposite directions:
 *
 *   - A successful read is CACHED, so one rebuild reads the config once and no
 *     two registries can split on different sets. `resetExtensionsCache()`
 *     invalidates it, which is what a real toggle does via `reloadRegistries()`.
 *   - The last successful set is kept as a failure fallback and is deliberately
 *     NOT dropped by that invalidation. It is knowledge, not cache: if the
 *     re-read after a toggle fails, serving the set from before the toggle is
 *     wrong by one capability, whereas serving empty would switch EVERY disabled
 *     capability back on — and for an extension-level disable that also
 *     resurrects its always-on system-prompt sections for one assembly, flipping
 *     the prompt bytes and cold-starting claudecode's warm cache.
 *
 * With no successful read ever, the answer is `null` — "unknown" — and every
 * caller is required to treat that as "change nothing" rather than "nothing is
 * disabled".
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
   * @param {Set<string>|null} set - Set to render
   * @returns {string} Sorted JSON array for error messages
   */
  const show = (set) => (set ? JSON.stringify([...set].sort()) : 'null');

  await test('a successful read is shared, and invalidation forces a fresh one', async () => {
    const realFetch = globalThis.fetch;
    try {
      resetExtensionsCache();
      let reads = 0;
      globalThis.fetch = /** @type {any} */ (async () => {
        reads++;
        return { ok: true, json: async () => ({ disabled: ['X'] }) };
      });

      const first = await fetchDisabledPluginIds();
      const second = await fetchDisabledPluginIds();
      assert(reads === 1, `repeat readers should share one read; made ${reads}`);
      assert(first === second, 'and get the identical set, so they cannot disagree');
      assert(first?.has('X'), `the set is what the server reported, got ${show(first)}`);

      resetExtensionsCache();
      await fetchDisabledPluginIds();
      assert(reads === 2, `invalidation should force a fresh read; made ${reads}`);
    } finally {
      globalThis.fetch = realFetch;
      resetExtensionsCache();
    }
  });

  await test('a failed re-read serves the last-known-good set, never empty', async () => {
    const realFetch = globalThis.fetch;
    try {
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ disabled: ['X'] }) }));
      const first = await fetchDisabledPluginIds();
      assert(first?.has('X'), `first read should yield Set{'X'}, got ${show(first)}`);

      // A thrown (transient) failure must serve last-known-good, NOT empty.
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('network blip'); });
      const second = await fetchDisabledPluginIds();
      assert(second?.size === 1 && second.has('X'),
        `a thrown failure must preserve last-known-good Set{'X'}, got ${show(second)}`);

      // An HTTP not-ok response must also serve last-known-good.
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: false, json: async () => ({}) }));
      const third = await fetchDisabledPluginIds();
      assert(third?.size === 1 && third.has('X'),
        `an HTTP not-ok must preserve last-known-good Set{'X'}, got ${show(third)}`);
    } finally {
      globalThis.fetch = realFetch;
      resetExtensionsCache();
    }
  });

  // The fallback survives invalidation on purpose. Dropping it there — which is
  // what used to happen — meant that a blip on the re-read immediately after a
  // toggle answered "nothing is disabled", switching every disabled capability
  // back on at the exact moment the user was changing one of them.
  await test('invalidation clears the cache but keeps the failure fallback', async () => {
    const realFetch = globalThis.fetch;
    try {
      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ disabled: ['Y'] }) }));
      const seeded = await fetchDisabledPluginIds();
      assert(seeded?.has('Y'), `seed should yield Set{'Y'}, got ${show(seeded)}`);

      resetExtensionsCache();
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('blip'); });
      const out = await fetchDisabledPluginIds();
      assert(out?.has('Y'),
        `a failed re-read must not answer "nothing is disabled", got ${show(out)}`);
    } finally {
      globalThis.fetch = realFetch;
      resetExtensionsCache();
    }
  });

  // Never read successfully: the honest answer is "unknown", not "empty". Every
  // caller turns that into leaving things alone rather than switching them on.
  //
  // Driven against a SEPARATE module instance (the query string defeats the
  // module cache), because the fallback is process-lifetime state: the suites of
  // a lane share one realm and the app's own boot has already read the config
  // successfully, so "has never been read" is not reachable in this one.
  await test('with no successful read ever, the answer is unknown rather than empty', async () => {
    const realFetch = globalThis.fetch;
    try {
      const fresh = await import('../../js/services/extensions.js?no-prior-read');
      globalThis.fetch = /** @type {any} */ (async () => { throw new Error('blip'); });
      const out = await fresh.fetchDisabledPluginIds();
      assert(out === null, `an unknown set must be null, not a set; got ${show(out)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  return { passed, failed, errors };
}
