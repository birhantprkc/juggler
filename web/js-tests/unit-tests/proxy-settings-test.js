//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Outbound-proxy box — settings UI tests.
 *
 * The proxy box lives at the bottom of the Connectivity tab. It reads the
 * persisted proxy config from GET /api/settings (network.proxy), reflects the
 * mode on a 3-way <select>, reveals the URL field only for Manual, and PUTs
 * changes. These cases drive the component against a stubbed backend to pin: the
 * select reflects the loaded mode, switching to a plain mode PUTs it, Manual
 * persists only once a valid URL is committed, and an invalid URL surfaces an
 * error without a PUT.
 * @module unit-tests/proxy-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Route window.fetch to an in-memory proxy-settings backend.
 * @param {{mode?: string, url?: string}} [opts]
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>, state: {mode: string, url: string}}} Fake backend with restore, recorded calls, and mutable proxy state.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  const state = { mode: opts.mode || 'system', url: opts.url || '' };
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/settings' && method === 'GET') {
      return { ok: true, json: async () => ({ network: { proxy: { mode: state.mode, url: state.url } } }) };
    }
    if (u === '/api/settings' && method === 'PUT') {
      const p = body.network.proxy;
      // Mirror the server's manual-URL validation: reject a manual mode without
      // a usable URL with a 400 rather than persisting it.
      if (p.mode === 'manual') {
        try {
          if (!new URL((p.url || '').trim()).hostname) throw new Error('bad');
        } catch {
          return { ok: false, status: 400, json: async () => ({ error: 'invalid proxy URL' }) };
        }
      }
      state.mode = p.mode;
      state.url = p.url || '';
      return { ok: true, json: async () => ({ network: { proxy: { mode: state.mode, url: state.url } } }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/** Let non-awaitable async chains (fetch → json) settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

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
   * Mount a settings-panel wired to a fake backend, show the Connectivity tab
   * (which loads the proxy box), run body, then clean up.
   * @param {{mode?: string, url?: string}} opts
   * @param {(el: any, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withPanel = async (opts, body) => {
    const backend = installFetch(opts);
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      // The proxy box loads its settings when the Connectivity tab is shown.
      el._tabs.connectivity.show();
      await settle();
      await body(el, backend);
    } finally {
      el.remove();
      backend.restore();
    }
  };

  const modeSelect = (el) => el.querySelector('#proxy-mode');

  await run('select reflects the loaded proxy mode from /api/settings', async () => {
    await withPanel({ mode: 'manual', url: 'http://127.0.0.1:7890' }, async (el) => {
      const select = modeSelect(el);
      assert(select && [...select.options].length === 3, `three modes; got ${select && select.options.length}`);
      assert(select.value === 'manual', `manual is selected; got ${select.value}`);
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && !urlRow.hidden, 'URL row is visible in manual mode');
      const urlInput = el.querySelector('#proxy-url');
      assert(urlInput && urlInput.value === 'http://127.0.0.1:7890', 'URL field shows the loaded URL');
    });
  });

  await run('URL row is hidden for non-manual modes', async () => {
    await withPanel({ mode: 'system' }, async (el) => {
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && urlRow.hidden, 'URL row hidden in system mode');
    });
  });

  await run('switching to Direct PUTs the new mode', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'none';
      select.dispatchEvent(new Event('change'));
      await settle();
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(put, 'a PUT /api/settings was issued');
      assert(put.body.network.proxy.mode === 'none', `PUT mode = ${put.body.network.proxy.mode}`);
      assert(backend.state.mode === 'none', `backend mode persisted; got ${backend.state.mode}`);
    });
  });

  await run('selecting Manual with no URL does not PUT and prompts for a URL', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(!put, 'no PUT issued for manual without a URL');
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && !urlRow.hidden, 'URL row revealed for manual');
      const statusText = el.querySelector('#proxy-status').textContent || '';
      assert(statusText.length > 0, 'a prompt for the URL is shown');
    });
  });

  await run('Manual with a valid URL persists on commit', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const urlInput = el.querySelector('#proxy-url');
      urlInput.value = 'http://proxy.example:8080';
      urlInput.dispatchEvent(new Event('blur'));
      await settle();
      const put = backend.calls.find((c) => c.method === 'PUT' && c.body.network.proxy.mode === 'manual');
      assert(put, 'a manual PUT was issued');
      assert(put.body.network.proxy.url === 'http://proxy.example:8080', `PUT url = ${put.body.network.proxy.url}`);
      assert(backend.state.mode === 'manual' && backend.state.url === 'http://proxy.example:8080', 'manual proxy persisted');
    });
  });

  await run('an invalid manual URL surfaces an error and is not persisted', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const urlInput = el.querySelector('#proxy-url');
      urlInput.value = 'not a url';
      urlInput.dispatchEvent(new Event('blur'));
      await settle();
      const put = backend.calls.find((c) => c.method === 'PUT' && c.body.network.proxy.url === 'not a url');
      assert(!put, 'no PUT for an invalid URL');
      const statusText = el.querySelector('#proxy-status').textContent || '';
      assert(/invalid/i.test(statusText), `an error is shown; got ${JSON.stringify(statusText)}`);
    });
  });

  return { passed, failed, errors };
}
