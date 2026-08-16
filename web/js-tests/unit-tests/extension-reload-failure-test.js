//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Hot-reload failure-notice tests.
 *
 * An extension edit reloads silently — the user made the change, so being told
 * it happened is not news. The one thing they cannot otherwise see is a
 * capability that stopped loading: a failed import leaves nothing in the UI, the
 * capability is simply gone. `newlyFailedModules` decides what is worth
 * interrupting for, and its whole job is restraint:
 *
 *   1. Something that just broke is reported.
 *   2. Something that was already broken the same way is NOT reported again —
 *      one permanently broken extension must not toast on every unrelated
 *      reload for the rest of the session.
 *   3. A module that broke differently IS reported: the file was edited and
 *      still doesn't load, which is fresh information.
 *   4. A module that now loads produces nothing (recovery is silent).
 * @module unit-tests/extension-reload-failure-test
 */

import { assert } from '../utilities/test-helpers.js';
import { newlyFailedModules } from '../../js/registries/reload-registries.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors collected error messages
 */

/**
 * @param {Array<[string, string]>} entries path/error pairs
 * @returns {Map<string, string>} a failure snapshot
 */
function snapshot(entries) {
  return new Map(entries);
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} aggregate pass/fail counts and errors.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const BROKEN = '/user-extensions/e1/my-ext/context-items/word-count-context-item.js';
  const OTHER = '/user-extensions/e1/my-ext/commands/hi-command-type.js';

  run('a module that just broke is reported', () => {
    const fresh = newlyFailedModules(snapshot([]), snapshot([[BROKEN, 'SyntaxError: bad']]));
    assert(fresh.length === 1, `expected 1 new failure, got ${fresh.length}`);
    assert(fresh[0].path === BROKEN, `wrong path: ${fresh[0].path}`);
    assert(fresh[0].error === 'SyntaxError: bad',
      `error text must survive verbatim, got: ${fresh[0].error}`);
  });

  run('an unchanged failure is not reported again', () => {
    const before = snapshot([[BROKEN, 'SyntaxError: bad']]);
    const fresh = newlyFailedModules(before, snapshot([[BROKEN, 'SyntaxError: bad']]));
    assert(fresh.length === 0, `a standing failure must stay quiet, got ${fresh.length}`);
  });

  run('a changed error on the same module is reported', () => {
    const before = snapshot([[BROKEN, 'SyntaxError: bad']]);
    const fresh = newlyFailedModules(before, snapshot([[BROKEN, 'TypeError: worse']]));
    assert(fresh.length === 1, `an edit that fails differently is news, got ${fresh.length}`);
    assert(fresh[0].error === 'TypeError: worse', `wrong error: ${fresh[0].error}`);
  });

  run('a recovered module reports nothing', () => {
    const before = snapshot([[BROKEN, 'SyntaxError: bad']]);
    const fresh = newlyFailedModules(before, snapshot([]));
    assert(fresh.length === 0, `recovery is silent, got ${fresh.length}`);
  });

  run('only the newly broken module of several is reported', () => {
    const before = snapshot([[BROKEN, 'SyntaxError: bad']]);
    const after = snapshot([[BROKEN, 'SyntaxError: bad'], [OTHER, 'ReferenceError: nope']]);
    const fresh = newlyFailedModules(before, after);
    assert(fresh.length === 1, `expected only the new one, got ${fresh.length}`);
    assert(fresh[0].path === OTHER, `wrong path: ${fresh[0].path}`);
  });

  return { passed, failed, errors };
}
