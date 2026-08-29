//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Sign-in state on a keyless provider row.
 *
 * A keyless provider is a switch: on or off. That was enough while "switched on"
 * and "can serve a turn" were the same thing, and they stop being the same the
 * moment a CLI is installed and enabled but not signed in. Its models vanish
 * from the menu, the switch still reads on, and nothing anywhere says why — the
 * first news of it is a failed turn.
 *
 * Two things are pinned here. The switch must keep showing what the user chose
 * (`credentialed`), never whether the provider happens to be usable this second
 * (`available`), or an expired sign-in would look like something they had turned
 * off themselves. And a provider that is on but reporting a hint must show that
 * hint, with the same re-check the OAuth rows get.
 * @module unit-tests/keyless-signin-status-test
 */

import { assert } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const SIGN_IN_HINT = "Claude Code isn't signed in. Run claude in a terminal and use /login.";

/**
 * A keyless provider row, in whichever of the three states a test needs.
 * @param {{available: boolean, credentialed: boolean, authHint?: string}} state - Row state
 * @returns {any} A provider entry shaped like /api/providers serves one
 */
function keylessProvider(state) {
  return {
    name: 'fake-cli',
    displayName: 'Fake CLI',
    description: 'Stands in for a CLI-backed provider.',
    authType: 'toggle',
    // An empty configKeyName is what routes a provider to the keyless field.
    configKeyName: '',
    envVarName: '',
    apiKeyURL: '',
    keySource: '',
    available: state.available,
    credentialed: state.credentialed,
    authHint: state.authHint || '',
    modelsWithContext: [{ id: 'fake-model', contextWindow: 1000, maxOutputTokens: 100, fromAPI: false }],
  };
}

/**
 * Install a fake backend for the endpoints the settings panel's load fans out
 * over.
 * @param {any[]} providers - The provider list to serve
 * @returns {{restore: () => void}} Handle for cleanup
 */
function installFetch(providers) {
  const orig = window.fetch;
  window.fetch = /** @type {any} */ (async (url) => {
    const u = String(url);
    const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
    if (u === '/api/config') return ok({ configDir: '/tmp/juggler-test' });
    if (u === '/api/providers') return ok({ providers, ready: true });
    if (u === '/api/default-model') return ok({ provider: 'fake-cli', model: 'fake-model' });
    if (u === '/api/cheap-model') return ok({ provider: 'fake-cli', model: 'fake-model' });
    if (u === '/api/connectivity') {
      return ok({
        lanEnabled: false, lanURLs: [], tunnelEnabled: false,
        tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [],
      });
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; } };
}

/**
 * Run keyless sign-in status tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test case name
   * @param {() => Promise<void>} fn - Test case body
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
   * Mount a settings-panel showing one keyless provider in the given state.
   * @param {any} provider - The provider entry to render
   * @param {(el: any) => Promise<void>} body - Assertions against the open panel
   */
  const withPanel = async (provider, body) => {
    const backend = installFetch([provider]);
    const priorShowModal = /** @type {any} */ (window).showModal;
    /** @type {any} */ (window).showModal = async () => {};
    // The settled list arrives over the WebSocket; seed the cache the same way
    // the server's post-refresh broadcast does.
    wsService._emit('providers-update', [provider]);
    wsService._emit('providers-ready', true);
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await el.open();
      await body(el);
    } finally {
      el.close();
      el.remove();
      /** @type {any} */ (window).showModal = priorShowModal;
      backend.restore();
    }
  };

  await run('a healthy provider shows the switch and nothing else', async () => {
    await withPanel(keylessProvider({ available: true, credentialed: true }), async (el) => {
      const toggle = el.querySelector('#fake-cli-toggle');
      assert(!!toggle, 'the keyless row must render its toggle');
      assert(toggle.checked === true, 'an available provider reads as on');
      assert(!el.querySelector('#fake-cli-oauth-status'),
        'a provider with nothing to report must not grow a status line');
    });
  });

  await run('a switched-off provider stays off and silent', async () => {
    await withPanel(keylessProvider({ available: false, credentialed: false }), async (el) => {
      const toggle = el.querySelector('#fake-cli-toggle');
      assert(toggle.checked === false, 'a provider the user turned off reads as off');
      assert(!el.querySelector('#fake-cli-oauth-status'),
        'an off provider has no sign-in to report on');
    });
  });

  await run('an enabled but unusable provider keeps its switch on and says why', async () => {
    const provider = keylessProvider({ available: false, credentialed: true, authHint: SIGN_IN_HINT });
    await withPanel(provider, async (el) => {
      const toggle = el.querySelector('#fake-cli-toggle');
      // The regression this guards: drawing the switch from `available` would
      // flip it off and tell the user they had disabled something they hadn't.
      assert(toggle.checked === true,
        'a provider that is on but not signed in must still read as on');

      const status = el.querySelector('#fake-cli-oauth-status');
      assert(!!status, 'an unusable enabled provider must say so on its row');
      assert((status.textContent || '').includes('/login'),
        `the row must carry the remediation, got ${status.textContent}`);

      const refresh = el.querySelector('#provider-fields-container .settings-btn.icon');
      assert(!!refresh, 'the row must offer a re-check');
      assert((refresh.getAttribute('aria-label') || '').includes('Fake CLI'),
        `the re-check must name its provider, got ${refresh.getAttribute('aria-label')}`);
    });
  });

  await run('an older server that sends no credentialed field still works', async () => {
    // Forward compatibility runs both ways: a viewer newer than its server sees
    // `credentialed` absent and must fall back to availability rather than
    // rendering every keyless row switched off.
    const provider = keylessProvider({ available: true, credentialed: true });
    delete provider.credentialed;
    await withPanel(provider, async (el) => {
      const toggle = el.querySelector('#fake-cli-toggle');
      assert(toggle.checked === true,
        'with no credentialed field the switch falls back to availability');
    });
  });

  return { passed, failed, errors };
}
