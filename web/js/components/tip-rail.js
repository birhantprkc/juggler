//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <tip-rail> — an ambient onboarding hint parked in the empty sidebar space just
 * above the Bin, where a new user hasn't yet filled the column with conversations.
 *
 * It slow-rotates through the unseen tips (see {@link module:services/tips-manager}),
 * one at a time. Clicking the tip advances to the next; the × hides tips entirely
 * (the same off switch as the Settings toggle, which replays them). Using a
 * shortcut quietly retires its own tip (learn-by-doing, in shortcut-bindings.js).
 * The rail hides once every tip is seen or the feature is off.
 *
 * Not an ARIA live region — rotating text would spam a screen reader; the same
 * content is available on demand in Settings › Keyboard shortcuts.
 * @module components/tip-rail
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';
import { allTips, isSeen, isOptedOut, setTipsEnabled, TIPS_CHANGED_EVENT } from '../services/tips-manager.js';

/** Rotate to the next unseen tip this often (ms). */
const ROTATE_MS = 15000;

class TipRail extends HTMLElement {
  constructor() {
    super();
    /** @type {string|null} @private Id of the tip currently in the DOM. */
    this._currentId = null;
    /** @type {ReturnType<typeof setInterval>|null} @private */
    this._timer = null;
    /** @type {(() => void)|null} @private window listener for tips-state changes. */
    this._onTipsChanged = null;
  }

  connectedCallback() {
    // Re-sync the instant tips state changes elsewhere — the Settings toggle, or a
    // tip retired by learn-by-doing.
    this._onTipsChanged = () => this._reconcile();
    window.addEventListener(TIPS_CHANGED_EVENT, this._onTipsChanged);
    this._reconcile();
  }

  disconnectedCallback() {
    this._stopRotation();
    if (this._onTipsChanged) {
      window.removeEventListener(TIPS_CHANGED_EVENT, this._onTipsChanged);
      this._onTipsChanged = null;
    }
  }

  /**
   * Re-evaluate visibility. Called by conversation-bar on render.
   * @returns {void}
   */
  update() {
    this._reconcile();
  }

  /**
   * @returns {import('../services/tips-manager.js').Tip[]} The unseen tips, in order.
   * @private
   */
  _unseen() {
    return allTips().filter((t) => !isSeen(t.id));
  }

  /**
   * Show the rail when tips are enabled and some remain unseen; otherwise hide.
   * @private
   */
  _reconcile() {
    const testMode = !!(/** @type {any} */ (window).JUGGLER_TEST_MODE);
    const unseen = this._unseen();
    if (testMode || isOptedOut() || unseen.length === 0) {
      this._stopRotation();
      this.hidden = true;
      this.innerHTML = '';
      this._currentId = null;
      return;
    }

    this.hidden = false;
    // Keep the current tip if still unseen, else start at the top.
    if (!this._currentId || !unseen.some((t) => t.id === this._currentId)) {
      const first = unseen[0];
      if (first) this._render(first);
    }
    this._startRotation();
  }

  /**
   * Advance to the next unseen tip (cycling).
   * @private
   */
  _advance() {
    const unseen = this._unseen();
    if (unseen.length === 0) { this._reconcile(); return; }
    const idx = unseen.findIndex((t) => t.id === this._currentId);
    const next = unseen[(idx + 1) % unseen.length];
    if (next) this._render(next);
  }

  /**
   * Advance on a user click, restarting the rotation clock.
   * @private
   */
  _userAdvance() {
    this._advance();
    this._startRotation(true);
  }

  /**
   * @param {boolean} [restart] - Reset the rotation interval first.
   * @private
   */
  _startRotation(restart) {
    if (restart) this._stopRotation();
    if (this._timer) return;
    this._timer = setInterval(() => this._advance(), ROTATE_MS);
  }

  /** @private */
  _stopRotation() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Render one tip. Built with createElement/textContent (CSP-safe).
   * @param {import('../services/tips-manager.js').Tip} tip
   * @private
   */
  _render(tip) {
    if (!tip) return;
    this._currentId = tip.id;
    this.setAttribute('role', 'note');

    const card = document.createElement('div');
    card.className = 'tip-rail__card';
    // Click the tip to advance — except the × (guard on target, since dismissing
    // tears the card down mid-click).
    card.addEventListener('click', (e) => {
      if (/** @type {Element} */ (e.target).closest('.tip-rail__close')) return;
      this._userAdvance();
    });

    const header = document.createElement('div');
    header.className = 'tip-rail__header';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'tip-rail__eyebrow';
    eyebrow.textContent = 'Tip';
    header.appendChild(eyebrow);

    // × hides tips entirely; Settings replays them.
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tip-rail__close';
    close.setAttribute('aria-label', 'Hide tips');
    close.title = 'Hide tips';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); setTipsEnabled(false); });
    header.appendChild(close);

    card.appendChild(header);

    const title = document.createElement('div');
    title.className = 'tip-rail__title';
    // Shortcut tips lead with the live key glyph (an inline span so the title text
    // wraps around it rather than dropping to its own line).
    if (tip.kind === 'shortcut' && tip.shortcutId) {
      const combo = keyShortcutManager.formatBinding(tip.shortcutId);
      if (combo) {
        const key = document.createElement('span');
        key.className = 'tip-rail__key';
        key.textContent = combo;
        title.appendChild(key);
      }
    }
    title.appendChild(document.createTextNode(tip.title));
    card.appendChild(title);

    const body = document.createElement('p');
    body.className = 'tip-rail__body';
    body.textContent = tip.body;
    card.appendChild(body);

    this.innerHTML = '';
    this.appendChild(card);
  }
}

customElements.define('tip-rail', TipRail);

export default TipRail;
