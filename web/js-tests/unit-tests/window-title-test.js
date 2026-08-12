//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Native window titles — the string the macOS "Window" menu and the
 * Windows/Linux taskbar label each window with.
 *
 * The invariant these pin: the title carries the project's own directory name
 * and nothing above it. Those surfaces are narrow and truncate from the END, so
 * a full path clips down to a shared prefix ("~/code/jugg…") and sibling
 * projects become indistinguishable again — which is the whole reason the
 * window reports a title at all.
 * @module unit-tests/window-title-test
 */

import { windowTitleForProject } from '../../js/utils/window-title.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run window-title tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>|void} fn - Test body
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

  await test('title is the app name plus the project directory', () => {
    assert(windowTitleForProject('/Users/me/code/juggler-pro') === 'Juggler - juggler-pro',
      'expected "Juggler - juggler-pro"');
  });

  await test('no path above the project leaks into the title', () => {
    const title = windowTitleForProject('/Users/me/code/juggler-pro');
    assert(!title.includes('/'), `path separator survived into "${title}"`);
    assert(!title.includes('me'), `parent directories survived into "${title}"`);
  });

  await test('siblings under one parent stay distinguishable', () => {
    // The reason the title is the leaf: these two differ only in their last
    // component, which is exactly what end-truncation would eat from a path.
    const a = windowTitleForProject('/Users/me/code/juggler');
    const b = windowTitleForProject('/Users/me/code/juggler-studio');
    assert(a !== b, `sibling projects both titled "${a}"`);
  });

  await test('native Windows paths split on backslashes', () => {
    // The desktop app reports the OS's own path, unnormalised.
    assert(windowTitleForProject('C:\\Users\\me\\code\\juggler') === 'Juggler - juggler',
      'backslash-separated path should yield its leaf');
  });

  await test('a trailing separator does not blank the name', () => {
    assert(windowTitleForProject('/Users/me/code/juggler/') === 'Juggler - juggler',
      'trailing slash should be ignored, not read as an empty leaf');
  });

  await test('a project-less window gets a meaningful placeholder', () => {
    // A freshly opened window sits at the picker with no project; its entry
    // must still read as something rather than a bare app name.
    assert(windowTitleForProject('') === 'Juggler - New Window',
      'expected the "New Window" placeholder');
  });

  return { passed, failed, errors };
}
