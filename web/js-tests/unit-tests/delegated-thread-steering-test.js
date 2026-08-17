//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Delegated threads are not user-steerable.
 *
 * A thread spawned by a delegating tool (a sub-agent call) runs under a strategy
 * the calling tool pinned — usually a hidden one, which is not in the selector's
 * list at all. Left alone, that column's button would read "Select Strategy" and
 * a Shift+Tab landing there would cycle a running sub-agent onto a real
 * strategy mid-run.
 *
 * So: the thread reports `isDelegated`, the selector hides itself for such a
 * thread, and the switcher refuses to resolve a hidden selector — the gesture
 * stands down rather than driving an invisible control.
 * @module unit-tests/delegated-thread-steering-test
 */

import { assert } from '../utilities/test-helpers.js';
import MessageThread from '../../js/model/message-thread.js';
import StrategySwitcher from '../../js/services/strategy-switcher.js';
import '../../js/components/strategy-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * A MessageThread over hand-rolled Y.Map stand-ins — enough for the two reads
 * under test (the thread's own fields, and the conversation default the
 * constructor resolves a strategy from).
 * @param {Record<string, any>} fields - The thread container's fields
 * @returns {MessageThread} A thread bound to those fields
 */
function threadWithFields(fields) {
  const container = /** @type {any} */ ({ get: (/** @type {string} */ k) => fields[k] });
  const conversation = /** @type {any} */ ({
    session: {},
    findParentContainer: () => null,
    _doc: { metadata: { get: () => 'default' } }
  });
  return new MessageThread(conversation, container, 'thread-1');
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  await run('isDelegated reads the flag the worker stamps at creation', () => {
    assert(threadWithFields({ delegated: true }).isDelegated === true,
      'a thread carrying delegated=true must report isDelegated');
    assert(threadWithFields({}).isDelegated === false,
      'an ordinary sub-thread must not report isDelegated');
  });

  await run('the selector hides itself for a delegated thread, and reappears otherwise', () => {
    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);
    try {
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: 'default', isDelegated: true }));
      assert(selector.hidden === true, 'a delegated thread hides its strategy control');

      // Columns are rebound constantly as the doc updates, so the flag must be
      // cleared as readily as it is set — a selector stuck hidden would leave a
      // perfectly ordinary thread unsteerable.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: 'default', isDelegated: false }));
      assert(selector.hidden === false, 'an ordinary thread shows its strategy control again');
    } finally {
      selector.remove();
    }
  });

  await run('the switcher stands down in a delegated column rather than driving the root', () => {
    // Two columns, as a conversation with an open sub-thread has: the root's
    // selector (visible) and the delegated child's (hidden). Focus sits in the
    // child's composer.
    // Built in an inert document: `composer-box` is a real custom element that
    // renders a whole composer (its own strategy-selector included) the moment
    // it connects, which would decide the outcome for us. A document with no
    // browsing context never upgrades custom elements, so these stay the plain
    // shells the resolver's selectors are written against.
    const doc = document.implementation.createHTMLDocument('columns');
    const rootBox = doc.createElement('composer-box');
    const rootSelector = doc.createElement('strategy-selector');
    const rootInput = doc.createElement('textarea');
    rootBox.append(rootSelector, rootInput);
    const childBox = doc.createElement('composer-box');
    const childSelector = /** @type {HTMLElement} */ (doc.createElement('strategy-selector'));
    childSelector.hidden = true;
    const childInput = doc.createElement('textarea');
    childBox.append(childSelector, childInput);
    doc.body.append(rootBox, childBox);

    // The test window is not the focused window, so a real focus() call may not
    // take. The resolver reads exactly one thing to find the focused column —
    // document.activeElement — so stub that, and put it back afterwards.
    const setFocus = (/** @type {Element} */ el) =>
      Object.defineProperty(document, 'activeElement', { value: el, configurable: true });

    const switcher = new StrategySwitcher();
    try {
      setFocus(childInput);
      assert(/** @type {any} */ (switcher)._resolveActiveSelector() === null,
        'a hidden selector in the focused column must resolve to null — NOT fall through to the root column');

      setFocus(rootInput);
      assert(/** @type {any} */ (switcher)._resolveActiveSelector() === rootSelector,
        'an ordinary column still resolves its own selector');
    } finally {
      delete (/** @type {any} */ (document).activeElement);
    }
  });

  return { passed, failed, errors };
}
