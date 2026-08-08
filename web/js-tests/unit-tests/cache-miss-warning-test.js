//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Composer display tests for provider-reported context-cache misses.
 * @module unit-tests/cache-miss-warning-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/composer.js';

/**
 * @returns {{box: any, container: HTMLElement, metadata: Map<string, any>, notify: (key: string) => void}} Mounted composer and metadata controls
 */
function mountComposer() {
  const metadata = new Map();
  /** @type {((event: any) => void)|null} */
  let observer = null;
  const conversation = {
    processingState: undefined,
    isTurnActive: () => true,
    observeMetadata: (/** @type {(event: any) => void} */ cb) => { observer = cb; },
    unobserveMetadata: () => {},
  };
  Object.defineProperty(conversation, 'processingState', {
    get: () => metadata.get('processingState'),
  });

  const container = document.createElement('div');
  const box = /** @type {any} */ (document.createElement('composer-box'));
  container.appendChild(box);
  document.body.appendChild(container);
  box.setupListeners();
  box.setupListeners = () => {};
  box.setConversation(conversation);
  box.threadItemId = null;

  return {
    box,
    container,
    metadata,
    notify(key) { observer?.({ keysChanged: new Set([key]) }); },
  };
}

/**
 * Run composer cache-miss warning tests.
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

  test('provider cache miss flashes the existing warning with its reason', () => {
    const { box, container, metadata, notify } = mountComposer();
    try {
      metadata.set('processingState', {
        status: 'streaming',
        startedAt: 123,
        threadItemId: '',
        cacheMissReason: 'diverged: system prompt changed',
      });
      notify('processingState');

      const warning = /** @type {HTMLElement|null} */ (box.querySelector('#context-cache-warning'));
      assert(!!warning, 'cache warning button must exist');
      assert(!warning.hasAttribute('hidden'), 'provider cache miss must reveal the warning');
      assert(warning.classList.contains('cache-miss-flash'), 'provider cache miss must flash the warning');
      assert((warning.getAttribute('title') || '').includes('system prompt changed'),
        `warning title must include the reason, got ${warning.getAttribute('title')}`);
    } finally {
      container.remove();
    }
  });

  test('cache miss for another thread does not reveal this composer warning', () => {
    const { box, container, metadata, notify } = mountComposer();
    try {
      metadata.set('processingState', {
        status: 'streaming',
        startedAt: 456,
        threadItemId: 'thread-other',
        cacheMissReason: 'model-changed',
      });
      notify('processingState');

      const warning = /** @type {HTMLElement|null} */ (box.querySelector('#context-cache-warning'));
      assert(!!warning?.hasAttribute('hidden'), 'another thread\'s cache miss must stay hidden');
    } finally {
      container.remove();
    }
  });

  return { passed, failed, errors };
}
