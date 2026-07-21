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

import keyShortcutManager, { isMac } from '../../services/key-shortcut-manager.js';

/**
 * Keyboard shortcuts tab: every command from the KeyShortcutManager, grouped by
 * category, each showing its current binding for this platform. The manager is
 * the single source of truth, so this needs no server fetch — it renders eagerly
 * from the shell's render() and has no pollers or listeners of its own.
 */
export class ShortcutsTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderShortcutsForm();
  }

  /**
   * Render the Keyboard shortcuts tab: every command from the KeyShortcutManager,
   * grouped by category, each showing its current binding for this platform. The
   * manager is the single source of truth, so this needs no server fetch. Read-only
   * for now; each row's `.provider-control` is where a future "record binding"
   * affordance will live.
   * @private
   */
  renderShortcutsForm() {
    const container = this.host.querySelector('#shortcuts-form');
    if (!container) return;
    container.innerHTML = '';

    for (const group of keyShortcutManager.byCategoryForPlatform(isMac())) {
      const heading = document.createElement('h3');
      heading.className = 'settings-section-heading';
      heading.textContent = group.category;
      container.appendChild(heading);

      for (const def of group.shortcuts) {
        container.appendChild(this._buildShortcutRow(def));
      }
    }
  }

  /**
   * Build one shortcut row: label + description on the left, the current key on
   * the right as a `<kbd>`.
   * @param {import('../../services/key-shortcut-manager.js').ShortcutDef} def - The shortcut definition.
   * @returns {HTMLElement} The row element.
   * @private
   */
  _buildShortcutRow(def) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field shortcut-row';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = def.label;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = def.description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control shortcut-control';
    const key = document.createElement('kbd');
    key.className = 'shortcut-keycap';
    key.textContent = keyShortcutManager.formatBinding(def.id);
    ctrl.appendChild(key);

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }
}
