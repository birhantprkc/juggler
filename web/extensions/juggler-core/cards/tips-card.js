//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Tips info card — an ambient onboarding hint that slow-rotates through the
 * unseen tips (see {@link module:services/tips-manager}), one at a time. Clicking
 * the card advances to the next tip; using a shortcut quietly retires its own tip
 * (learn-by-doing, in shortcut-bindings.js). The card drops out once every tip is
 * seen (its `hasContent()` goes false) or the user hides it.
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region
 * and manages its own rotation. Not an ARIA live region — rotating text would
 * spam a screen reader; the same content is available on demand in Settings ›
 * Keyboard shortcuts.
 * @module extensions/juggler-core/cards/tips-card
 */

import InfoCardType from 'juggler/info-card-type';
import keyShortcutManager from '../../../js/services/key-shortcut-manager.js';
import { allTips, isSeen, resetSeen } from '../../../js/services/tips-manager.js';

/** Rotate to the next unseen tip this often (ms). */
const ROTATE_MS = 20000;

/**
 * @returns {import('../../../js/services/tips-manager.js').Tip[]} The unseen tips, in order.
 */
function unseen() {
  return allTips().filter((t) => !isSeen(t.id));
}

/**
 * Build the title node for a tip. Shortcut tips lead with the live key glyph (an
 * inline span so the title text wraps around it rather than dropping to its own
 * line). Built with createElement/textContent (CSP-safe).
 * @param {import('../../../js/services/tips-manager.js').Tip} tip
 * @returns {HTMLElement} The title node, keycap first for shortcut tips.
 */
function buildTitle(tip) {
  const title = document.createElement('div');
  title.className = 'info-card__title';
  if (tip.kind === 'shortcut' && tip.shortcutId) {
    const combo = keyShortcutManager.formatBinding(tip.shortcutId);
    if (combo) {
      const key = document.createElement('span');
      key.className = 'info-card__key';
      key.textContent = combo;
      title.appendChild(key);
    }
  }
  title.appendChild(document.createTextNode(tip.title));
  return title;
}

/**
 * The Tips info card.
 */
export default class TipsCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'tips',
    name: 'Tips',
    version: '1.0.0',
    description: 'Show occasional onboarding tips in the sidebar, one at a time. Turning this on again replays them all.',
    eyebrow: 'Tips',
    priority: 30,
  };

  /** @returns {boolean} Whether any tip is still unseen. */
  hasContent() {
    return unseen().length > 0;
  }

  /**
   * Replay every tip when the card is re-shown — otherwise, once they've all
   * been seen, un-hiding it would show nothing.
   * @returns {void}
   */
  onEnabled() {
    resetSeen();
  }

  /**
   * Populate the content region with the current tip and start rotating.
   * @param {HTMLElement} contentEl
   * @returns {() => void} Teardown that stops rotation and unbinds the click.
   */
  mount(contentEl) {
    contentEl.classList.add('info-card__content--interactive');
    /** @type {string|null} Id of the tip currently in the DOM. */
    let currentId = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    const render = (/** @type {import('../../../js/services/tips-manager.js').Tip} */ tip) => {
      if (!tip) return;
      currentId = tip.id;
      const body = document.createElement('p');
      body.className = 'info-card__body';
      body.textContent = tip.body;
      contentEl.replaceChildren(buildTitle(tip), body);
    };

    const advance = () => {
      const u = unseen();
      if (u.length === 0) return;
      const idx = u.findIndex((t) => t.id === currentId);
      const next = u[(idx + 1) % u.length];
      if (next) render(next);
    };

    const startRotation = (/** @type {boolean} */ restart = false) => {
      if (restart && timer) { clearInterval(timer); timer = null; }
      if (!timer) timer = setInterval(advance, ROTATE_MS);
    };

    // Click the card to advance, restarting the rotation clock.
    const onClick = () => { advance(); startRotation(true); };
    contentEl.addEventListener('click', onClick);

    const first = unseen()[0];
    if (first) render(first);
    startRotation();

    return () => {
      if (timer) { clearInterval(timer); timer = null; }
      contentEl.removeEventListener('click', onClick);
    };
  }
}
