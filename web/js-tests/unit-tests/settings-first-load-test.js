//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings panel first-load gating.
 *
 * /api/providers serves a cache the server fills asynchronously after it starts
 * listening, so for the first moment of a launch it answers 200 with an empty
 * list and `ready: false`. Opening Settings in that window used to render the
 * empty list and then latch `_hasLoadedOnce`, leaving the Provider API Keys page
 * blank for as long as the window stayed open. These tests pin both halves: the
 * unsettled snapshot must not be rendered, and a failed load must not latch.
 * @module unit-tests/settings-first-load-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import providersCache from '../../js/services/providers-cache.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** A keyless provider — the simplest field the providers tab can build. */
const FAKE_PROVIDER = {
  name: 'fake-provider',
  displayName: 'Fake Provider',
  description: 'Stands in for a real provider entry.',
  authType: 'none',
  configKeyName: '',
  envVarName: '',
  apiKeyURL: '',
  keySource: '',
  available: true,
  modelsWithContext: [{ id: 'fake-model', contextWindow: 1000, maxOutputTokens: 100, fromAPI: false }],
};

/**
 * Install a fake backend for the five endpoints loadConfig() fans out over. The
 * returned `state` is live, so a test can heal a failing backend and reopen the
 * same panel.
 * @param {{providersPayload?: any, configOk?: boolean}} [opts]
 * @returns {{restore: () => void, calls: string[], state: {providersPayload: any, configOk: boolean}}} Handle for cleanup/inspection.
 */
function installFetch(opts = {}) {
  const state = {
    providersPayload: opts.providersPayload || { providers: [], ready: false },
    configOk: opts.configOk !== false,
  };
  const orig = window.fetch;
  /** @type {string[]} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url) => {
    const u = String(url);
    calls.push(u);
    const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
    if (u === '/api/config') {
      return state.configOk
        ? ok({ configDir: '/tmp/juggler-test' })
        : { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '', json: async () => ({}) };
    }
    if (u === '/api/providers') return ok(state.providersPayload);
    if (u === '/api/default-model') return ok({ provider: 'fake-provider', model: 'fake-model' });
    if (u === '/api/cheap-model') return ok({ provider: 'fake-provider', model: 'fake-model' });
    if (u === '/api/connectivity') {
      return ok({
        lanEnabled: false, lanURLs: [], tunnelEnabled: false,
        tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [],
      });
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  /**
   * Mount a settings-panel against a fake backend, run body, then clean up.
   * @param {{providersPayload?: any, configOk?: boolean}} opts
   * @param {(el: any, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withPanel = async (opts, body) => {
    const backend = installFetch(opts);
    const priorAlert = window.showAlert;
    // A failed load alerts; keep it from blocking on a real dialog.
    /** @type {any} */ (window).showAlert = async () => {};
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await body(el, backend);
    } finally {
      el.close();
      el.remove();
      /** @type {any} */ (window).showAlert = priorAlert;
      backend.restore();
    }
  };

  // The settled list arrives over the WebSocket; seed the cache the same way the
  // server's post-refresh broadcast does, so waitForReady() resolves.
  const seedSettledProviders = () => {
    wsService._emit('providers-update', [FAKE_PROVIDER]);
    wsService._emit('providers-ready', true);
  };

  await run('an unsettled empty provider snapshot renders the settled list, not a blank page', async () => {
    seedSettledProviders();
    assert(providersCache.hasReceived(), 'the settled push seeded the providers cache');

    await withPanel({ providersPayload: { providers: [], ready: false } }, async (el) => {
      await el.open();

      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 1, `one provider field rendered; got ${fields.length}`);
      assert(el._tabs.providers.providers.length === 1,
        `the tab received the settled list; got ${el._tabs.providers.providers.length} providers`);
      assert(el._hasLoadedOnce === true, 'a successful load latches the first-load flag');
    });
  });

  await run('a settled snapshot from REST is used as-is', async () => {
    await withPanel({ providersPayload: { providers: [FAKE_PROVIDER], ready: true } }, async (el) => {
      await el.open();
      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 1, `one provider field rendered; got ${fields.length}`);
    });
  });

  await run('a failed first load is not latched, so reopening the same panel retries', async () => {
    await withPanel({ configOk: false }, async (el, backend) => {
      await el.open();
      assert(el._hasLoadedOnce === false,
        'a failed load must leave the first-load flag clear so the next open retries');
      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 0, `a failed load renders no fields; got ${fields.length}`);

      // Heal the backend and reopen the SAME panel: the retry must actually
      // re-fetch and render, rather than being skipped by a latched flag.
      el.close();
      backend.state.configOk = true;
      backend.state.providersPayload = { providers: [FAKE_PROVIDER], ready: true };
      await el.open();

      assert(el._hasLoadedOnce === true, 'the retry latched after a successful load');
      const retried = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(retried.length === 1, `the retry rendered the provider field; got ${retried.length}`);
    });
  });

  return { passed, failed, errors };
}
