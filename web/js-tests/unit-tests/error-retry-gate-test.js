//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The error row's Retry offer, which exists only at the end of a thread.
 *
 * Retry deletes the error and continues, and a continue always resumes from the
 * end of the transcript — so on an error with items after it there is no failed
 * turn left to retry, and pressing it would delete a piece of history on its way
 * to an ordinary continue. The gate is a rendering-pass marker rather than
 * anything the component can work out for itself: an item element is created
 * once and afterwards only moved, so an error that stops being last is never
 * asked to render again unless something tells it.
 * @module unit-tests/error-retry-gate-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/error-message.js';
import {
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';

/**
 * A plain-object stand-in for a conversation item Y.Map — enough for the
 * rendering pass's `.get()` reads.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * An error item, the only kind this suite renders: two of them make a thread
 * where one error is last and one is not, without dragging in the components
 * every other item type would need.
 * @param {string} id - Item id
 * @returns {{get: (key: string) => any}} A Y.Map-shaped error item
 */
function errorItem(id) {
  return item({ itemId: id, type: 'error', content: `boom ${id}` });
}

/**
 * Mount a message list with the trailing managed non-item the diff positions
 * against (the real thing is the conversation footer; any managed element does,
 * and this one needs no wiring).
 * @returns {{list: HTMLElement, anchor: HTMLElement, render: (items: any[]) => void, teardown: () => void}} The mounted list and a render pass over it
 */
function mountList() {
  const list = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.className = 'thread-result-final';
  list.appendChild(anchor);
  document.body.appendChild(list);

  return {
    list,
    anchor,
    render(items) {
      const currentElements = buildElementMap(list);
      removeDeletedElements(currentElements, identifyElementsToKeep(items, currentElements));
      positionElements(null, list, anchor, items, currentElements);
    },
    teardown() {
      list.remove();
    },
  };
}

/**
 * @param {HTMLElement} list - The mounted message list
 * @param {string} id - Item id
 * @returns {HTMLElement|null} The Retry button on that error's row, if it has one
 */
function retryButton(list, id) {
  return list.querySelector(`error-message[message-id="${id}"] .error-retry-btn`);
}

/**
 * Run error Retry gate tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => void} fn - Test case body
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  test('the last item’s error offers Retry', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_1')]);
      const btn = retryButton(list, 'ERR_1');
      assert(!!btn, 'an error at the end of the thread must offer a retry');
      assert((btn.textContent || '').includes('Retry'), `retry must be labelled, got ${btn.textContent}`);
    } finally {
      teardown();
    }
  });

  test('an error with anything after it withdraws the offer', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_1')]);
      assert(!!retryButton(list, 'ERR_1'), 'precondition: the first error starts out last');

      // The element is reused across this pass, never rebuilt — which is the
      // whole reason the marker exists.
      const firstRow = list.querySelector('error-message[message-id="ERR_1"]');
      render([errorItem('ERR_1'), errorItem('ERR_2')]);
      assert(list.querySelector('error-message[message-id="ERR_1"]') === firstRow,
        'the diff must reuse the existing row rather than rebuilding it');

      assert(!retryButton(list, 'ERR_1'),
        'an error the conversation moved past has no turn left to retry');
      assert(!!retryButton(list, 'ERR_2'), 'the error now at the end offers the retry');
    } finally {
      teardown();
    }
  });

  test('deleting what followed hands the offer back', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_1'), errorItem('ERR_2')]);
      assert(!retryButton(list, 'ERR_1'), 'precondition: the first error is not last');

      render([errorItem('ERR_1')]);
      assert(!!retryButton(list, 'ERR_1'),
        'an error that is last again is retryable again');
      assert(!list.querySelector('error-message[message-id="ERR_2"]'),
        'the deleted error must be gone from the row list');
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
