//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { allInfoCards, isCardEnabled, setCardEnabled, INFO_CARDS_CHANGED_EVENT } from '../../services/info-cards-manager.js';
import { buildToggleRow } from './notifications-tab.js';

/**
 * Info cards tab: one enable/disable toggle per ambient sidebar card (Tips, Git
 * status, …), read from the InfoCardsManager. No server fetch — these are
 * per-window localStorage prefs, so it renders eagerly and keeps its toggles in
 * sync with the sidebar via INFO_CARDS_CHANGED_EVENT.
 */
export class InfoCardsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {((e: Event) => void)|null} @private - Re-syncs the toggles when a card is hidden/re-enabled elsewhere. */
    this._onInfoCardsChanged = null;
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderInfoCardsForm();
  }

  /**
   * Element disconnected: drop the info-cards listener.
   */
  dispose() {
    if (this._onInfoCardsChanged) {
      window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
      this._onInfoCardsChanged = null;
    }
  }

  /**
   * Render the Info cards tab: one enable/disable toggle per ambient sidebar card
   * (Tips, Git status, …), read from the InfoCardsManager. No server fetch — these
   * are per-window localStorage prefs. This is where the Tips toggle now lives
   * (moved out of Keyboard shortcuts).
   * @private
   */
  renderInfoCardsForm() {
    const container = this.host.querySelector('#info-cards-form');
    if (!container) return;
    container.innerHTML = '';

    for (const card of allInfoCards()) {
      const { row, input } = buildToggleRow(
        card.label,
        card.description,
        card.enabled,
        (on) => setCardEnabled(card.id, on),
      );
      input.dataset.cardId = card.id;
      container.appendChild(row);
    }

    // Keep the toggles in sync when a card is hidden/re-enabled elsewhere (the ×
    // on a sidebar card fires INFO_CARDS_CHANGED_EVENT). Rebind to the current
    // inputs; removed in dispose().
    if (this._onInfoCardsChanged) window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
    this._onInfoCardsChanged = () => {
      container.querySelectorAll('input[data-card-id]').forEach((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        if (input.dataset.cardId) input.checked = isCardEnabled(input.dataset.cardId);
      });
    };
    window.addEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
  }
}
