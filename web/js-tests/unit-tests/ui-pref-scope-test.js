//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI preference scope unit test.
 *
 * Zoom and theme are the desktop window's settings, kept per project in the
 * session — but a phone or laptop browsing in remotely has its own screen and
 * its own opinion, so there they belong to the device and live in localStorage.
 * utils/ui-pref-scope.js holds that rule for both managers. This pins it: which
 * store wins for each kind of client, that a remote viewer still starts from the
 * project's value when it has none of its own, and that the localStorage key is
 * namespaced by project (the origin identifies a port, so an unnamespaced key
 * hands this project whatever the last one left behind).
 * @module unit-tests/ui-pref-scope-test
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { scopedKey, resolvePref } = await import('../../js/utils/ui-pref-scope.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  };

  const originalProjectKey = window.__projectKey;

  try {
    // --- scopedKey -------------------------------------------------------

    run('scopedKey namespaces by project', () => {
      window.__projectKey = 'abc123';
      eq(scopedKey('juggler-zoom'), 'juggler-zoom:abc123', 'scoped key');
    });

    run('scopedKey separates two projects', () => {
      window.__projectKey = 'aaa';
      const first = scopedKey('juggler-theme');
      window.__projectKey = 'bbb';
      if (first === scopedKey('juggler-theme')) {
        throw new Error('two projects produced the same key, so their themes would collide');
      }
    });

    run('scopedKey falls back to the bare key with no project', () => {
      window.__projectKey = '';
      eq(scopedKey('juggler-zoom'), 'juggler-zoom', 'no-project key');
    });

    // --- resolvePref: desktop window --------------------------------------

    run('desktop takes the project session first', () => {
      eq(resolvePref({ desktop: true, session: 130, device: 90, windowScoped: [70], fallback: 110 }),
        130, 'desktop resolved zoom');
    });

    run('desktop falls to the inherited seed, then the device', () => {
      eq(resolvePref({ desktop: true, session: null, device: 90, windowScoped: [70], fallback: 110 }),
        70, 'seed outranks device on desktop');
      eq(resolvePref({ desktop: true, session: null, device: 90, windowScoped: [null], fallback: 110 }),
        90, 'device used when no session or seed');
    });

    // --- resolvePref: remote browser --------------------------------------

    // The regression this whole rule exists for: zooming out on a phone must not
    // come home and shrink the desktop window it dialled into.
    run('remote takes this device over the project session', () => {
      eq(resolvePref({ desktop: false, session: 130, device: 70, fallback: 110 }),
        70, 'remote resolved zoom');
    });

    run('remote still starts from the session when the device has nothing', () => {
      eq(resolvePref({ desktop: false, session: 130, device: null, fallback: 110 }),
        130, 'first-visit remote zoom');
    });

    run('remote uses the fallback when nothing is stored anywhere', () => {
      eq(resolvePref({ desktop: false, session: null, device: null, fallback: 110 }),
        110, 'stock default');
    });

    // The window-scoped hints keep their middle rank either way; only the
    // bookends swap. Theme relies on this so a project switch keeps 'system'.
    run('window-scoped hints stay between the two stores', () => {
      eq(resolvePref({ desktop: false, session: 'dark', device: null, windowScoped: ['system'], fallback: 'system' }),
        'system', 'remote window hint outranks the session');
      eq(resolvePref({ desktop: false, session: 'dark', device: 'light', windowScoped: ['system'], fallback: 'system' }),
        'light', 'device still outranks the window hint');
    });

    run('undefined is skipped like null', () => {
      eq(resolvePref({ desktop: true, session: undefined, device: 90, fallback: 110 }),
        90, 'undefined session');
    });
  } finally {
    window.__projectKey = originalProjectKey;
  }

  return { passed, failed, errors };
}
