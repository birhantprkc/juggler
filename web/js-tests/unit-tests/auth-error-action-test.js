//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The error row's Provider settings offer, which appears only on a failure the
 * worker classified as an authentication problem.
 *
 * The classification is the worker's (`data.errorKind`) and the row only reads
 * the verdict — matching on the error text here would put the taxonomy in two
 * places and let them disagree. Unlike Retry the offer is not gated on the error
 * being last: opening settings can never damage a transcript, and the fix for an
 * expired sign-in is somewhere else entirely, which is exactly what a first-time
 * reader of one of these errors does not know.
 * @module unit-tests/auth-error-action-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/error-message.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import {
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';

/**
 * A plain-object stand-in for a conversation item Y.Map.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * An error item carrying the worker's `data` blob as a JSON string, which is one
 * of the shapes it genuinely arrives in.
 * @param {string} id - Item id
 * @param {Record<string, any>|null} data - The item's data blob, or null for none
 * @returns {{get: (key: string) => any}} A Y.Map-shaped error item
 */
function errorItem(id, data) {
  return item({
    itemId: id,
    type: 'error',
    content: `boom ${id}`,
    data: data ? JSON.stringify(data) : undefined,
  });
}

/** An auth failure exactly as the worker now reports one. */
const AUTH_DATA = { provider: 'claudecode', model: 'sonnet', duration: 1200, errorKind: 'auth' };

/**
 * Mount a message list with the trailing managed non-item the diff positions
 * against.
 * @returns {{list: HTMLElement, render: (items: any[]) => void, teardown: () => void}} The mounted list and a render pass over it
 */
function mountList() {
  const list = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.className = 'thread-result-final';
  list.appendChild(anchor);
  document.body.appendChild(list);

  return {
    list,
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
 * @param {string} cls - Action button class
 * @returns {HTMLElement|null} That action's button on the row, if it has one
 */
function actionButton(list, id, cls) {
  return list.querySelector(`error-message[message-id="${id}"] .${cls}`);
}

/**
 * Run auth error action tests.
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

  test('an auth failure offers Provider settings', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const btn = actionButton(list, 'ERR_AUTH', 'error-settings-btn');
      assert(!!btn, 'an authentication failure must offer the settings that fix it');
      assert((btn.textContent || '').includes('Provider settings'),
        `the action must be labelled, got ${btn.textContent}`);
    } finally {
      teardown();
    }
  });

  test('an ordinary failure does not', () => {
    const { list, render, teardown } = mountList();
    try {
      // Same shape, no classification: the row must not guess from the text.
      render([errorItem('ERR_PLAIN', { provider: 'claudecode', duration: 12 })]);
      assert(!actionButton(list, 'ERR_PLAIN', 'error-settings-btn'),
        'an unclassified failure has no reason to send anyone to settings');
      assert(!!actionButton(list, 'ERR_PLAIN', 'error-retry-btn'),
        'precondition: an ordinary last-item error still offers Retry');
    } finally {
      teardown();
    }
  });

  test('an error with no data at all is handled', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_BARE', null)]);
      assert(!actionButton(list, 'ERR_BARE', 'error-settings-btn'),
        'an error carrying no data must render without one');
    } finally {
      teardown();
    }
  });

  test('settings reads before Retry', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const row = list.querySelector('error-message[message-id="ERR_AUTH"] .error-message-actions');
      assert(!!row, 'the action row must exist');
      const classes = Array.from(row.children).map((c) => c.className);
      // Retrying an expired sign-in only reproduces it, so the action that
      // actually fixes the cause has to come first.
      assert(classes[0].includes('error-settings-btn'),
        `settings must lead the action row, got ${JSON.stringify(classes)}`);
      assert(classes[1].includes('error-retry-btn'),
        `retry must follow it, got ${JSON.stringify(classes)}`);
    } finally {
      teardown();
    }
  });

  test('the offer survives the error no longer being last', () => {
    const { list, render, teardown } = mountList();
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      assert(!!actionButton(list, 'ERR_AUTH', 'error-retry-btn'),
        'precondition: the auth error starts out last');

      render([errorItem('ERR_AUTH', AUTH_DATA), errorItem('ERR_2', null)]);
      assert(!actionButton(list, 'ERR_AUTH', 'error-retry-btn'),
        'Retry withdraws once the conversation has moved past the error');
      assert(!!actionButton(list, 'ERR_AUTH', 'error-settings-btn'),
        'the sign-in still needs fixing wherever the error sits');
    } finally {
      teardown();
    }
  });

  test('pressing it opens the providers tab', () => {
    const { list, render, teardown } = mountList();
    /** @type {string[]} */
    const opened = [];
    const restore = registerSettingsOpener((tab) => { opened.push(tab || ''); });
    try {
      render([errorItem('ERR_AUTH', AUTH_DATA)]);
      const btn = actionButton(list, 'ERR_AUTH', 'error-settings-btn');
      assert(!!btn, 'precondition: the action is present');
      btn.click();
      assert(opened.length === 1, `expected one settings open, got ${opened.length}`);
      assert(opened[0] === 'providers',
        `settings must open on the providers tab, got ${JSON.stringify(opened[0])}`);
    } finally {
      restore();
      teardown();
    }
  });

  return { passed, failed, errors };
}
