//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * "Find in conversation" (⌘F) unit tests.
 *
 * Covers three layers: the framework-free {@link FindController} match engine
 * (case-sensitivity, whole-word, next/prev wrap-around, empty queries, and
 * post-mutation refresh), the `find-in-conversation` shortcut definition in the
 * shared {@link keyShortcutManager} table, the singleton {@link findBar}'s DOM
 * interaction (open/focus, debounced typing → counter, Enter/Shift+Enter
 * navigation, whole-word toggle, Escape-to-close focus restoration, and the
 * streaming live-recount), and the {@link expandCollapsibleContaining} auto-open
 * helper the controller uses to reveal a buried match.
 *
 * The CSS Custom Highlight paint is feature-detected and may be absent in the
 * headless engine, so nothing here asserts on `CSS.highlights` or on scroll
 * offsets — only on `total`/`current`, the counter text, and the DOM. All
 * fixtures attach to `document.body` and are torn down (and the bar closed) in
 * `finally` blocks so no state leaks into sibling suites.
 * @module unit-tests/find-test
 */

import { assert } from '../utilities/test-helpers.js';
import FindController from '../../js/services/find-controller.js';
import findBar from '../../js/components/find-bar.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import { expandCollapsibleContaining } from '../../js/utils/collapsible.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Comfortably longer than the bar's 120ms input debounce. */
const INPUT_WAIT_MS = 180;
/** Comfortably longer than the bar's 150ms MutationObserver debounce. */
const OBSERVER_WAIT_MS = 250;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a detached fixture, fill it with `html`, attach it to the document (so
 * layout, focus, scroll, and observers behave), and return it.
 * @param {string} html - Inner HTML for the fixture.
 * @returns {HTMLElement} The attached fixture element.
 */
function attach(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/**
 * Build the column skeleton `findBar.open()` expects — a positioned
 * `conversation-message-list-wrapper` around a `#message-list`, plus the
 * `input-box textarea` composer focus is restored to on close — attach it, and
 * return the column element.
 * @param {string} messagesHtml - Inner HTML for the `#message-list`.
 * @returns {HTMLElement} The attached column element.
 */
function attachColumn(messagesHtml) {
  const col = document.createElement('div');
  col.innerHTML = `
    <conversation-message-list-wrapper style="position:relative;display:block">
      <section id="message-list">${messagesHtml}</section>
    </conversation-message-list-wrapper>
    <input-box><textarea></textarea></input-box>`;
  document.body.appendChild(col);
  return col;
}

/** Three messages: "needle" appears standalone twice and once inside "needles". */
const NEEDLE_MESSAGES = `
  <div class="msg">the needle in the haystack</div>
  <div class="msg">found a needle again</div>
  <div class="msg">needles and pins</div>`;

/**
 * The bar is a singleton that retains its query and toggles across opens; reset
 * them (safe only while closed) so each interaction test starts from a clean,
 * order-independent state.
 * @returns {void}
 */
function resetBarState() {
  findBar._query = '';
  findBar._caseSensitive = false;
  findBar._wholeWord = false;
}

/**
 * @param {HTMLElement} col
 * @returns {string} The live counter's text.
 */
function counterText(col) {
  const c = col.querySelector('.find-bar__counter');
  return c ? (c.textContent || '') : '';
}

/**
 * @param {HTMLElement} col
 * @returns {number} The total from a "current of total" counter (0 otherwise).
 */
function counterTotal(col) {
  const m = counterText(col).match(/of\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {HTMLElement} col
 * @returns {number} The current index from a "current of total" counter (0 otherwise).
 */
function counterCurrent(col) {
  const m = counterText(col).match(/^\s*(\d+)\s+of/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  // ── A. Engine (FindController) ──────────────────────────────────────

  await run('engine: search counts every occurrence, active is 1-based', () => {
    const root = attach('the cat sat on the mat, the cat ran');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const r = fc.search('cat');
      assert(r.total === 2, `expected total 2, got ${r.total}`);
      assert(r.current === 1, `expected current 1, got ${r.current}`);
      assert(fc.total === 2 && fc.current === 1, 'getters mirror the result');
    } finally {
      root.remove();
    }
  });

  await run('engine: case-insensitive by default, case-sensitive on request', () => {
    const root = attach('Cat cat CAT');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 3, 'default search is case-insensitive (3 matches)');
      assert(fc.search('cat', { caseSensitive: true }).total === 1,
        'case-sensitive search matches only the exact-case "cat"');
    } finally {
      root.remove();
    }
  });

  await run('engine: whole-word matches only the standalone token', () => {
    const root = attach('cat category cats scatter');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 4,
        'plain search finds "cat" inside category/cats/scatter too (4)');
      assert(fc.search('cat', { wholeWord: true }).total === 1,
        'whole-word matches only the standalone "cat" (1)');
    } finally {
      root.remove();
    }
  });

  await run('engine: next()/prev() wrap around the match list', () => {
    const root = attach('the cat sat on the mat, the cat ran');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').current === 1, 'starts at match 1');
      assert(fc.next().current === 2, 'next → 2');
      assert(fc.next().current === 1, 'next wraps 2 → 1');
      assert(fc.prev().current === 2, 'prev wraps 1 → 2');
    } finally {
      root.remove();
    }
  });

  await run('engine: empty/whitespace query yields no matches and clear() resets', () => {
    const root = attach('the cat sat');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      assert(fc.search('cat').total === 1, 'baseline has a match');
      let r = fc.search('');
      assert(r.total === 0 && r.current === 0, 'empty query → 0/0');
      r = fc.search('   ');
      assert(r.total === 0 && r.current === 0, 'whitespace query → 0/0');
      fc.search('cat');
      fc.clear();
      assert(fc.total === 0 && fc.current === 0, 'clear() resets total/current');
    } finally {
      root.remove();
    }
  });

  await run('engine: refresh() picks up text appended after a search', () => {
    const root = attach('the cat sat');
    try {
      const fc = new FindController();
      fc.setRoot(root);
      const before = fc.search('cat').total;
      assert(before === 1, `expected 1 match before mutation, got ${before}`);
      root.appendChild(document.createTextNode(' and another cat too'));
      const after = fc.refresh().total;
      assert(after === before + 1, `refresh should add one match (before ${before}, after ${after})`);
    } finally {
      root.remove();
    }
  });

  // ── B. Shortcut definition ──────────────────────────────────────────

  await run('shortcut: find-in-conversation binds Mod+F', () => {
    const b = keyShortcutManager.getBinding('find-in-conversation');
    assert(b && b.mod === true, 'binding uses the command modifier');
    assert(b.key === 'f', `binding key should be "f", got "${b && b.key}"`);
  });

  await run('shortcut: def is in the Search category and allowed in inputs', () => {
    const def = keyShortcutManager.all().find((d) => d.id === 'find-in-conversation');
    assert(!!def, 'find-in-conversation is present in all()');
    assert(def.category === 'Search', `category should be "Search", got "${def.category}"`);
    assert(def.allowInInput === true, 'find-in-conversation is allowed while typing');
  });

  // ── C. Find-bar interaction (singleton) ─────────────────────────────

  await run('find-bar: open mounts and focuses the query input', () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      assert(findBar.isOpen() === true, 'bar reports open');
      const input = col.querySelector('.find-bar__input');
      assert(!!input, 'the find input is mounted in the column');
      assert(document.activeElement === input, 'the find input is focused');
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: typing runs a debounced search and updates the counter', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(INPUT_WAIT_MS);
      assert(counterTotal(col) === 3, `expected "of 3", counter was "${counterText(col)}"`);
      assert(counterCurrent(col) === 1, `expected current 1, counter was "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: Enter advances and Shift+Enter steps back', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(INPUT_WAIT_MS);
      assert(counterCurrent(col) === 1, 'starts at match 1');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert(counterCurrent(col) === 2, `Enter should advance to 2, got "${counterText(col)}"`);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      assert(counterCurrent(col) === 1, `Shift+Enter should step back to 1, got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: whole-word toggle activates and re-counts', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(INPUT_WAIT_MS);
      assert(counterTotal(col) === 3, `plain search should find 3, got "${counterText(col)}"`);
      const wordBtn = /** @type {HTMLElement} */ (col.querySelector('.find-bar__word'));
      assert(!!wordBtn, 'whole-word toggle button exists');
      wordBtn.click(); // click handler re-runs the search synchronously
      assert(wordBtn.getAttribute('aria-pressed') === 'true', 'toggle sets aria-pressed=true');
      assert(wordBtn.classList.contains('is-active'), 'toggle gains is-active');
      assert(counterTotal(col) === 2, `whole-word should drop "needles", got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: Escape closes and restores composer focus', () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(findBar.isOpen() === false, 'bar reports closed');
      assert(col.querySelector('.find-bar') === null, 'bar element is removed from the DOM');
      assert(document.activeElement === col.querySelector('input-box textarea'),
        'focus returns to the composer textarea');
    } finally {
      findBar.close();
      col.remove();
    }
  });

  await run('find-bar: live recount picks up a streamed-in message', async () => {
    resetBarState();
    const col = attachColumn(NEEDLE_MESSAGES);
    try {
      findBar.open(col);
      const input = /** @type {HTMLInputElement} */ (col.querySelector('.find-bar__input'));
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(INPUT_WAIT_MS);
      const before = counterTotal(col);
      assert(before === 3, `expected 3 before append, got ${before}`);
      const list = /** @type {HTMLElement} */ (col.querySelector('#message-list'));
      const added = document.createElement('div');
      added.className = 'msg';
      added.textContent = 'another needle here';
      list.appendChild(added);
      await sleep(OBSERVER_WAIT_MS);
      assert(counterTotal(col) === before + 1,
        `observer should recount to ${before + 1}, got "${counterText(col)}"`);
    } finally {
      findBar.close();
      col.remove();
    }
  });

  // ── D. Auto-expand a collapsed block around a match ──────────────────

  await run('auto-expand: expands the collapsed collapsible around a node', () => {
    const root = attach(
      '<section id="message-list">' +
        '<div class="collapsible is-collapsed"><span class="target">buried treasure</span></div>' +
        '<button class="collapsible-toggle" aria-expanded="false">Show more</button>' +
      '</section>');
    try {
      const target = /** @type {HTMLElement} */ (root.querySelector('.target'));
      const collapsible = /** @type {HTMLElement} */ (root.querySelector('.collapsible'));
      assert(expandCollapsibleContaining(target) === true, 'returns true when it expands something');
      assert(collapsible.classList.contains('is-expanded'), 'block is now expanded');
      assert(!collapsible.classList.contains('is-collapsed'), 'collapsed class removed');
    } finally {
      root.remove();
    }
  });

  await run('auto-expand: returns false outside any collapsed block', () => {
    const root = attach('<p class="loose">nothing collapsed here</p>');
    try {
      const p = /** @type {HTMLElement} */ (root.querySelector('.loose'));
      assert(expandCollapsibleContaining(p) === false, 'returns false with no collapsed ancestor');
    } finally {
      root.remove();
    }
  });

  return { passed, failed, errors };
}
