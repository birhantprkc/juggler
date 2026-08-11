//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <info-cards-button> — the small "i" control heading the info rail in the tab
 * column, managing the per-window visibility of the ambient info cards (Tips,
 * Usage, Git status, …). It is mounted as the rail's first child (see
 * {@link module:components/info-rail}), so it sits immediately above the cards.
 *
 * It is the un-hide surface for gate 2: the × on a card {@link module:services/info-cards-manager|hides}
 * it in this window, and this menu brings it back. It lists every gate-1 enabled
 * card (from the info-card registry) with a show/hide toggle apiece; toggling
 * fires INFO_CARDS_CHANGED_EVENT so the rail reconciles live. Installing/removing
 * a card (gate 1) stays in the Extensions catalog.
 *
 * The button shows whenever at least one gate-1 enabled card exists, so it is an
 * always-available manage entry point. It stays out of the way in automated UI
 * tests (JUGGLER_TEST_MODE), matching the rail.
 *
 * The menu is a standard `.dropdown-menu` surface presented by
 * {@link module:utils/popup-surface|presentPopup} — same as the model/strategy
 * pickers — so it inherits the shared chrome, anchored placement (or phone
 * bottom-sheet), and mutual-exclusion / Escape / outside-click dismissal for
 * free. Rows use the app's material check glyph, never a text tick.
 * @module components/info-cards-button
 */

import {
  providers,
  allInfoCards,
  hideCard,
  showCard,
  INFO_CARDS_CHANGED_EVENT,
} from '../services/info-cards-manager.js';
import { presentPopup } from '../utils/popup-surface.js';
import { CHECK_SVG } from '../utils/icons.js';

// Material "info" (outline) icon, matching the bin icon's 0 -960 960 960 viewBox.
const INFO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="1rem" viewBox="0 -960 960 960" width="1rem" fill="currentColor" aria-hidden="true"><path d="M440-280h80v-240h-80v240Zm40-320q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm0 520q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>`;

/** Shared popup id: opening any other popup dismisses this menu, and vice versa. */
const POPUP_ID = 'info-cards-menu';

class InfoCardsButton extends HTMLElement {
  constructor() {
    super();
    /** @type {HTMLButtonElement|null} @private */
    this._button = null;
    /** @type {HTMLElement|null} @private - The body-hosted menu surface while open. */
    this._menu = null;
    /** @type {boolean} @private */
    this._open = false;
    /** @type {(() => void)|null} @private */
    this._onChange = null;
    /** @type {(() => void)|null} @private - presentPopup teardown for the open menu. */
    this._popupRelease = null;
  }

  connectedCallback() {
    this._buildButton();
    this._onChange = () => this._reconcile();
    window.addEventListener(INFO_CARDS_CHANGED_EVENT, this._onChange);
    this._reconcile();
  }

  disconnectedCallback() {
    if (this._onChange) {
      window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onChange);
      this._onChange = null;
    }
    this._closeMenu();
  }

  /**
   * Build the trigger button once.
   * @private
   */
  _buildButton() {
    if (this._button) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-cards-button';
    btn.title = 'Show info cards';
    btn.setAttribute('aria-label', 'Show info cards');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = INFO_ICON_SVG;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleMenu(); });
    this.appendChild(btn);
    this._button = btn;
  }

  /**
   * Reconcile visibility (and any open menu) with the current enabled-card set.
   * Shown whenever ≥1 gate-1 enabled card exists; hidden in test mode.
   * @private
   */
  _reconcile() {
    const testMode = !!(/** @type {any} */ (window).JUGGLER_TEST_MODE);
    const hasCards = providers().length > 0;
    this.hidden = testMode || !hasCards;
    if (this.hidden) {
      this._closeMenu();
    } else if (this._open) {
      this._renderMenu();
    }
  }

  /** @private */
  _toggleMenu() {
    if (this._open) this._closeMenu();
    else this._openMenu();
  }

  /** @private */
  _openMenu() {
    if (this._open || !this._button) return;
    this._open = true;
    this._button.setAttribute('aria-expanded', 'true');

    // A standard dropdown surface, built detached — presentPopup owns appending
    // it to <body>, placement (anchored dropdown or phone sheet), and the full
    // dismissal wiring (Escape, outside-click, mutual exclusion). `show` up front
    // because display comes from the base `.dropdown-menu` rule.
    const menu = document.createElement('nav');
    menu.className = 'dropdown-menu info-cards-menu show';
    menu.setAttribute('role', 'menu');
    this._menu = menu;
    this._renderMenu();

    this._popupRelease = presentPopup({
      surface: menu,
      anchor: this._button,
      id: POPUP_ID,
      onClose: () => this._closeMenu(),
      // Left-aligned trigger → pin the menu's left edge to the button's.
      align: 'left',
      gap: 6,
      insideSelectors: ['info-cards-button', '.info-cards-menu'],
    });
  }

  /**
   * Populate the open menu with a toggle row per enabled card. Rebuilds the
   * surface's contents in place, so it also drives the live refresh when a toggle
   * fires INFO_CARDS_CHANGED_EVENT while the menu is open (presentPopup's
   * observer re-anchors on the content change).
   * @private
   */
  _renderMenu() {
    if (!this._menu) return;
    const cards = allInfoCards();

    const list = document.createElement('menu');

    const heading = document.createElement('li');
    heading.className = 'category-header';
    heading.textContent = 'Info cards';
    list.appendChild(heading);

    if (cards.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'menu-item unavailable';
      empty.textContent = 'No info cards available';
      list.appendChild(empty);
      this._menu.replaceChildren(list);
      return;
    }

    for (const card of cards) {
      const shown = !card.hidden;
      const row = document.createElement('li');
      // `.active` greens the row + its tick, matching the app's selected-item look.
      row.className = `menu-item info-cards-menu__item${shown ? ' active' : ''}`;
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(shown));

      const check = document.createElement('span');
      check.className = 'info-cards-menu__check';
      check.setAttribute('aria-hidden', 'true');
      // The shared material check glyph — a fixed-width gutter keeps unticked
      // rows aligned with ticked ones.
      if (shown) check.innerHTML = CHECK_SVG;

      const label = document.createElement('span');
      label.className = 'menu-item-name';
      label.textContent = card.name;

      row.append(check, label);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (card.hidden) showCard(card.id);
        else hideCard(card.id);
        // The change event re-renders the menu (and the rail) via _reconcile.
      });
      list.appendChild(row);
    }

    this._menu.replaceChildren(list);
  }

  /** @private */
  _closeMenu() {
    this._open = false;
    if (this._button) this._button.setAttribute('aria-expanded', 'false');
    // Release tears down the surface, scrim, observer and dismissal wiring.
    if (this._popupRelease) { this._popupRelease(); this._popupRelease = null; }
    this._menu = null;
  }
}

customElements.define('info-cards-button', InfoCardsButton);

export default InfoCardsButton;
