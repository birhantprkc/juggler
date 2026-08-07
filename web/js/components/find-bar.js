//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import FindController from '../services/find-controller.js';
import { isMac } from '../services/key-shortcut-manager.js';
import { EXPAND_LESS_SVG, EXPAND_MORE_SVG } from '../utils/icons.js';

/**
 * The presentational "Find in conversation" (⌘F) bar. A body/column-mounted
 * singleton (module-level instance + default export, in the same shape as
 * `disconnection-overlay.js`) that owns exactly one {@link FindController} and
 * drives it — it never touches highlighting itself.
 *
 * The bar pins to the top-right of whichever `<conversation-area>` currently
 * owns the search, mounted as an absolutely-positioned overlay inside that
 * column's `conversation-message-list-wrapper` (a `position: relative` box) so
 * it floats above the reversed `#message-list` scroller without becoming a
 * scrolling child of it. It handles its OWN keydown (Enter / Shift+Enter /
 * Escape / ⌘G / ⌘⇧G) directly on its input — deliberately NOT via the global
 * shortcut manager — and keeps matches live during streaming with a debounced
 * `MutationObserver` on the message list.
 * @module components/find-bar
 */

/** Debounce for the query input before running a search. */
const SEARCH_DEBOUNCE_MS = 120;
/** Debounce for the streaming MutationObserver before refreshing matches. */
const OBSERVER_DEBOUNCE_MS = 150;

/**
 * Singleton find bar. One instance (exported default) is shared across every
 * conversation column; `open(columnEl)` re-homes it onto the active column.
 */
class FindBar {
  constructor() {
    /** @type {HTMLElement|null} @private - The bar's root element while open. */
    this._element = null;
    /** @type {HTMLInputElement|null} @private - The query input. */
    this._input = null;
    /** @type {HTMLElement|null} @private - The `n of m` live counter. */
    this._counter = null;
    /** @type {HTMLElement|null} @private - The `<conversation-area>` currently searched. */
    this._columnEl = null;
    /** @type {FindController} @private - The one match engine this bar drives. */
    this._controller = new FindController();
    /** @type {MutationObserver|null} @private - Watches the message list while open. */
    this._observer = null;
    /** @type {number|null} @private - Pending search-debounce timer. */
    this._searchTimer = null;
    /** @type {number|null} @private - Pending observer-debounce timer. */
    this._observerTimer = null;
    /** @type {string} @private - Query retained across opens so ⌘F re-runs the last find. */
    this._query = '';
    /** @type {boolean} @private - Case-sensitive toggle, retained across opens. */
    this._caseSensitive = false;
    /** @type {boolean} @private - Whole-word toggle, retained across opens. */
    this._wholeWord = false;
  }

  /** @returns {boolean} Whether the bar is currently mounted. */
  isOpen() {
    return !!this._element;
  }

  /**
   * Open (or refocus) the bar on `columnEl`. Closed → mount, point the
   * controller at the column's `#message-list`, focus + select the input, start
   * the observer, and re-run any retained query. Already open on the SAME column
   * → just focus + select-all (the "⌘F while open" behavior). Open on a
   * DIFFERENT column → move the bar, re-point the controller, and re-run.
   * @param {HTMLElement} columnEl - The active `<conversation-area>`.
   * @returns {void}
   */
  open(columnEl) {
    if (!columnEl) return;

    if (this._element && this._columnEl === columnEl) {
      this._focusInput();
      return;
    }

    if (this._element && this._columnEl !== columnEl) {
      // Move the bar to a different column without a full teardown.
      this._teardownObserver();
      this._mountPoint(columnEl).appendChild(this._element);
      this._columnEl = columnEl;
      this._controller.setRoot(columnEl.querySelector('#message-list'));
      this._startObserver();
      this._runSearch();
      this._focusInput();
      return;
    }

    // Fresh open.
    this._columnEl = columnEl;
    this._build();
    if (this._element) this._mountPoint(columnEl).appendChild(this._element);
    this._controller.setRoot(columnEl.querySelector('#message-list'));
    this._startObserver();
    this._runSearch();
    this._focusInput();
  }

  /**
   * Close the bar: clear the controller (removes highlights), stop the observer,
   * remove the element, and restore focus to the column's composer.
   * @returns {void}
   */
  close() {
    if (!this._element) return;

    if (this._searchTimer !== null) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    this._teardownObserver();
    this._controller.clear();

    const columnEl = this._columnEl;
    this._element.remove();
    this._element = null;
    this._input = null;
    this._counter = null;
    this._columnEl = null;

    this._restoreComposerFocus(columnEl);
  }

  /**
   * Open the bar (or refocus if already open on this column) when closed; close
   * it when open. Suitable as the single ⌘F entry point.
   * @param {HTMLElement} columnEl - The active `<conversation-area>`.
   * @returns {void}
   */
  toggle(columnEl) {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open(columnEl);
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The element the bar is appended to: the column's positioned message-list
   * wrapper (falls back to the column itself if the wrapper is absent).
   * @param {HTMLElement} columnEl - The active conversation column.
   * @returns {HTMLElement} The element the bar is appended to.
   * @private
   */
  _mountPoint(columnEl) {
    return /** @type {HTMLElement} */ (
      columnEl.querySelector('conversation-message-list-wrapper') || columnEl
    );
  }

  /**
   * Build the bar element, wire its controls, and cache child references.
   * @returns {void}
   * @private
   */
  _build() {
    const el = document.createElement('div');
    el.className = 'find-bar';
    el.setAttribute('role', 'search');
    el.innerHTML = `
      <input type="text" class="find-bar__input" aria-label="Find in conversation"
        placeholder="Find" spellcheck="false" autocomplete="off" />
      <span class="find-bar__counter" aria-live="polite"></span>
      <button type="button" class="find-bar__btn find-bar__prev" aria-label="Previous match" title="Previous match (⇧⏎)">${EXPAND_LESS_SVG}</button>
      <button type="button" class="find-bar__btn find-bar__next" aria-label="Next match" title="Next match (⏎)">${EXPAND_MORE_SVG}</button>
      <button type="button" class="find-bar__btn find-bar__toggle find-bar__case" aria-label="Match case" aria-pressed="false" title="Match case">Aa</button>
      <button type="button" class="find-bar__btn find-bar__toggle find-bar__word" aria-label="Match whole word" aria-pressed="false" title="Match whole word">W</button>
      <button type="button" class="find-bar__btn find-bar__close" aria-label="Close find" title="Close (Esc)">&#x2715;</button>
    `;

    const input = /** @type {HTMLInputElement} */ (el.querySelector('.find-bar__input'));
    const counter = /** @type {HTMLElement} */ (el.querySelector('.find-bar__counter'));
    const prevBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__prev'));
    const nextBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__next'));
    const caseBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__case'));
    const wordBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__word'));
    const closeBtn = /** @type {HTMLElement} */ (el.querySelector('.find-bar__close'));

    input.value = this._query;
    this._reflectToggle(caseBtn, this._caseSensitive);
    this._reflectToggle(wordBtn, this._wholeWord);

    input.addEventListener('input', () => {
      this._query = input.value;
      this._scheduleSearch();
    });
    input.addEventListener('keydown', (e) => this._onKeydown(e));

    prevBtn.addEventListener('click', () => this._updateCounter(this._controller.prev()));
    nextBtn.addEventListener('click', () => this._updateCounter(this._controller.next()));
    caseBtn.addEventListener('click', () => {
      this._caseSensitive = !this._caseSensitive;
      this._reflectToggle(caseBtn, this._caseSensitive);
      this._runSearch();
      this._focusInput(false);
    });
    wordBtn.addEventListener('click', () => {
      this._wholeWord = !this._wholeWord;
      this._reflectToggle(wordBtn, this._wholeWord);
      this._runSearch();
      this._focusInput(false);
    });
    closeBtn.addEventListener('click', () => this.close());

    this._element = el;
    this._input = input;
    this._counter = counter;
  }

  /**
   * Reflect a toggle's pressed state via `aria-pressed` + the `is-active` class.
   * @param {HTMLElement} btn
   * @param {boolean} on
   * @returns {void}
   * @private
   */
  _reflectToggle(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
  }

  /**
   * The bar's own keyboard map (Enter / Shift+Enter / Escape / ⌘G / ⌘⇧G).
   * Handled keys `preventDefault()` so native find/typeahead never doubles up.
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _onKeydown(e) {
    const cmd = isMac() ? e.metaKey : e.ctrlKey;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this._updateCounter(e.shiftKey ? this._controller.prev() : this._controller.next());
      return;
    }
    if (cmd && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      this._updateCounter(e.shiftKey ? this._controller.prev() : this._controller.next());
    }
  }

  /**
   * Debounce a search from the query input.
   * @returns {void}
   * @private
   */
  _scheduleSearch() {
    if (this._searchTimer !== null) clearTimeout(this._searchTimer);
    this._searchTimer = window.setTimeout(() => {
      this._searchTimer = null;
      this._runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Run the current query/options immediately and update the counter. Does NOT
   * auto-scroll — revealing the active match is reserved for Enter/next/prev.
   * @returns {void}
   * @private
   */
  _runSearch() {
    const query = this._input ? this._input.value : this._query;
    this._updateCounter(
      this._controller.search(query, {
        caseSensitive: this._caseSensitive,
        wholeWord: this._wholeWord,
      }),
    );
  }

  /**
   * Render the `{ total, current }` summary into the live counter: empty for an
   * empty query, "No results" for a non-empty query with no matches, else
   * "current of total".
   * @param {{ total: number, current: number }} result
   * @returns {void}
   * @private
   */
  _updateCounter(result) {
    if (!this._counter) return;
    const hasQuery = !!(this._input && this._input.value.trim());
    let text = '';
    let empty = false;
    if (!hasQuery) {
      text = '';
    } else if (result.total === 0) {
      text = 'No results';
      empty = true;
    } else {
      text = `${result.current} of ${result.total}`;
    }
    this._counter.textContent = text;
    this._counter.classList.toggle('find-bar__counter--empty', empty);
  }

  /**
   * Start the debounced MutationObserver so streamed/new text is re-matched and
   * the active match preserved. No-op if already observing.
   * @returns {void}
   * @private
   */
  _startObserver() {
    if (this._observer || !this._columnEl) return;
    const target = this._columnEl.querySelector('#message-list');
    if (!target) return;
    this._observer = new MutationObserver(() => {
      if (this._observerTimer !== null) clearTimeout(this._observerTimer);
      this._observerTimer = window.setTimeout(() => {
        this._observerTimer = null;
        if (this._element) this._updateCounter(this._controller.refresh());
      }, OBSERVER_DEBOUNCE_MS);
    });
    this._observer.observe(target, { subtree: true, childList: true, characterData: true });
  }

  /**
   * Detach the observer and cancel any pending refresh.
   * @returns {void}
   * @private
   */
  _teardownObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._observerTimer !== null) {
      clearTimeout(this._observerTimer);
      this._observerTimer = null;
    }
  }

  /**
   * Focus the query input, optionally selecting its text (default: select).
   * @param {boolean} [select=true]
   * @returns {void}
   * @private
   */
  _focusInput(select = true) {
    if (!this._input) return;
    this._input.focus();
    if (select) this._input.select();
  }

  /**
   * Return focus to the column's composer on close: the `composer-box`'s textarea
   * if present, else blur so focus doesn't linger on a removed node.
   * @param {HTMLElement|null} columnEl
   * @returns {void}
   * @private
   */
  _restoreComposerFocus(columnEl) {
    const textarea = columnEl && columnEl.querySelector('composer-box textarea');
    if (textarea) {
      /** @type {HTMLElement} */ (textarea).focus();
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }
}

/** The shared singleton instance. */
const findBar = new FindBar();

export default findBar;
