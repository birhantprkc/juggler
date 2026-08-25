//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: a streaming delta refreshes only the row it changed.
 *
 * conversation-area watches the whole thread container with observeDeep, so a
 * single streaming token arrives as an event batch covering every row. Left
 * unscoped, each token refreshed every streamable row in the transcript and
 * measured each one for the height glide — two forced layouts per row, per
 * token, for the length of the conversation. A long thinking block streaming
 * into a long transcript is then quadratic in the worst place possible.
 *
 * These tests pin the scoping rule: derive the touched item ids from the
 * events, refresh only those rows, and fall back to refreshing everything
 * whenever the batch can't be attributed — an array-level delta (an item was
 * inserted or removed) or a target below the item level (a tool-action's
 * nested displayData). The fallback is the conservative answer and must stay.
 * @module unit-tests/streaming-row-scope-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-area.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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

  const ConversationArea = /** @type {any} */ (customElements.get('conversation-area'));

  const ROW_IDS = ['item-1', 'item-2', 'item-3'];

  /**
   * A Yjs-shaped event for a field change on one item's own Y.Map.
   * @param {string} itemId - The item whose field changed.
   * @returns {any} Fake YMapEvent.
   */
  const fieldEvent = (itemId) => ({
    changes: {},
    target: { get: (/** @type {string} */ k) => (k === 'itemId' ? itemId : undefined) },
  });

  /**
   * A Yjs-shaped event for an array-level insert or remove.
   * @returns {any} Fake YArrayEvent.
   */
  const deltaEvent = () => ({ changes: { delta: [{ insert: [{}] }] }, target: {} });

  /**
   * A Yjs-shaped event for a map nested below the item, carrying no itemId.
   * @returns {any} Fake YMapEvent.
   */
  const nestedEvent = () => ({ changes: {}, target: { get: () => undefined } });

  /**
   * Build a transcript of thinking rows plus a stand-in for the observer host,
   * and return what one event batch touched.
   * @returns {{ fire: (events: any[]) => {refreshed: string[], measured: string[]}, teardown: () => void }} Harness.
   */
  const makeArea = () => {
    const root = document.createElement('div');
    root.innerHTML = '<div id="message-list"></div>';
    document.body.appendChild(root);
    const list = /** @type {HTMLElement} */ (root.querySelector('#message-list'));

    /** @type {string[]} */
    const refreshed = [];
    /** @type {string[]} */
    const measured = [];

    for (const id of ROW_IDS) {
      const el = /** @type {any} */ (document.createElement('thinking-message'));
      el.setAttribute('message-id', id);
      // Shadow the prototype method: this test is about WHICH rows are visited,
      // not what the row does when it is.
      el.updateFromItem = () => { refreshed.push(id); };
      list.appendChild(el);
    }

    const items = ROW_IDS.map((id) => ({
      get: (/** @type {string} */ k) => (k === 'itemId' ? id : k === 'type' ? 'thinking' : undefined),
    }));

    /** @type {(events: any[]) => void} */
    let observer = () => {};

    const area = {
      _messageThread: {
        items,
        container: { observeDeep: (/** @type {any} */ fn) => { observer = fn; } },
      },
      _memberToGroup: new Map(),
      querySelector: (/** @type {string} */ sel) => root.querySelector(sel),
      _holdReaderAnchorOver: (/** @type {() => void} */ fn) => fn(),
      _snapshotLiveStatus: () => null,
      _computeDisplay: () => ({ entries: [], memberToGroup: new Map() }),
      _animateStreamingResize: (/** @type {HTMLElement} */ el) => {
        measured.push(el.getAttribute('message-id') || '');
      },
      _notifyChangedElements: ConversationArea.prototype._notifyChangedElements,
    };
    ConversationArea.prototype._setupStreamingScrollObserver.call(area, null);

    return {
      fire: (/** @type {any[]} */ events) => {
        refreshed.length = 0;
        measured.length = 0;
        observer(events);
        return { refreshed: [...refreshed], measured: [...measured] };
      },
      teardown: () => root.remove(),
    };
  };

  // The glide only runs when motion is allowed; pin it so the measurement
  // assertions mean the same thing on a machine set to reduce motion.
  const realMatchMedia = window.matchMedia;
  window.matchMedia = /** @type {any} */ (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

  try {
    await run('a streaming token refreshes only the row it changed', () => {
      const area = makeArea();
      try {
        const { refreshed } = area.fire([fieldEvent('item-2')]);
        assert(
          refreshed.length === 1 && refreshed[0] === 'item-2',
          `expected only item-2 refreshed, got [${refreshed.join(', ')}]`
        );
      } finally { area.teardown(); }
    });

    await run('a streaming token measures only the row it changed', () => {
      const area = makeArea();
      try {
        const { measured } = area.fire([fieldEvent('item-3')]);
        assert(
          measured.length === 1 && measured[0] === 'item-3',
          `measuring a row costs a forced layout; expected only item-3, got [${measured.join(', ')}]`
        );
      } finally { area.teardown(); }
    });

    await run('a batch touching two rows refreshes both', () => {
      const area = makeArea();
      try {
        const { refreshed } = area.fire([fieldEvent('item-1'), fieldEvent('item-3')]);
        assert(
          refreshed.length === 2 && refreshed.includes('item-1') && refreshed.includes('item-3'),
          `expected item-1 and item-3, got [${refreshed.join(', ')}]`
        );
      } finally { area.teardown(); }
    });

    await run('an array-level delta falls back to refreshing every row', () => {
      const area = makeArea();
      try {
        const { refreshed } = area.fire([deltaEvent()]);
        assert(
          refreshed.length === ROW_IDS.length,
          `a structural change must not be narrowed; got [${refreshed.join(', ')}]`
        );
      } finally { area.teardown(); }
    });

    await run('a thinking row updates its label without copying the text into the DOM', () => {
      const el = /** @type {any} */ (document.createElement('thinking-message'));
      el.setAttribute('content', 'seed');
      document.body.appendChild(el);
      try {
        const accumulated = 'x'.repeat(40000);
        el.updateFromItem({ get: (/** @type {string} */ k) => (k === 'content' ? accumulated : undefined) });

        const span = el.querySelector('.thinking-summary');
        assert(!!span && span.textContent === 'Thinking · 10k tokens',
          `expected the count to track the stream, got "${span && span.textContent}"`);
        assert(el.getAttribute('content') === 'seed',
          'the accumulated reasoning must not be copied into the DOM on every delta');
        assert(el.content === accumulated, 'the row still reports the streamed text');
      } finally { el.remove(); }
    });

    await run('an explicit content attribute supersedes the streamed text', () => {
      const el = /** @type {any} */ (document.createElement('thinking-message'));
      document.body.appendChild(el);
      try {
        el.updateFromItem({ get: (/** @type {string} */ k) => (k === 'content' ? 'streamed' : undefined) });
        el.setAttribute('content', 'rebuilt');
        assert(el.content === 'rebuilt', `a rebuild must win, got "${el.content}"`);
      } finally { el.remove(); }
    });

    await run('an event below the item level falls back to refreshing every row', () => {
      const area = makeArea();
      try {
        const { refreshed } = area.fire([nestedEvent()]);
        assert(
          refreshed.length === ROW_IDS.length,
          `an unattributable change must not be narrowed; got [${refreshed.join(', ')}]`
        );
      } finally { area.teardown(); }
    });
  } finally {
    window.matchMedia = realMatchMedia;
  }

  return { passed, failed, errors };
}
