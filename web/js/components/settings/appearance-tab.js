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

import { getMode, setMode, MODES, THEME_MODE_EVENT } from '../../utils/theme-manager.js';

/** The three modes in menu order, with their labels. */
const THEME_OPTIONS = [
  { value: MODES.SYSTEM, label: 'System' },
  { value: MODES.LIGHT, label: 'Light' },
  { value: MODES.DARK, label: 'Dark' },
];

/**
 * Appearance tab: the explicit theme mode.
 *
 * The header button is a two-state light switch and never says the word
 * "system" — it picks the mode for you, following the OS unless you ask for the
 * theme the OS isn't showing (see toggleTheme in theme-manager.js). This is
 * where the third mode is offered by name, for choosing what the app should do
 * in future rather than what it should look like right now. Reads straight from
 * the theme-manager (no server fetch) and stays in sync with the header button
 * via THEME_MODE_EVENT.
 */
export class AppearanceTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {HTMLElement} @private */
    this.host = host;
    /** @type {((e: Event) => void)|null} @private - Re-syncs the menu when the theme changes elsewhere (the header button, the OS). */
    this._onThemeMode = null;
  }

  /** Eager render into the tab's section (called from the shell's render()). */
  render() {
    this.renderAppearanceForm();
  }

  /**
   * Element disconnected: drop the theme listener.
   */
  dispose() {
    if (this._onThemeMode) {
      document.removeEventListener(THEME_MODE_EVENT, this._onThemeMode);
      this._onThemeMode = null;
    }
  }

  /**
   * Render the Appearance tab: the theme mode menu.
   * @private
   */
  renderAppearanceForm() {
    const container = this.host.querySelector('#appearance-form');
    if (!container) return;

    container.innerHTML = '';

    const themeRow = this._buildThemeRow(getMode());
    container.appendChild(themeRow.row);

    // Keep the menu in step with the header button, which changes the same
    // setting, and with the OS while the mode is System. Registered once;
    // removed in dispose().
    if (!this._onThemeMode) {
      this._onThemeMode = () => {
        themeRow.select.value = getMode();
      };
      document.addEventListener(THEME_MODE_EVENT, this._onThemeMode);
    }
  }

  /**
   * Build the theme row: a labelled popup menu over the three modes.
   * @param {string} mode - The currently-selected mode (one of MODES).
   * @returns {{row: HTMLElement, select: HTMLSelectElement}} The row and its menu.
   * @private
   */
  _buildThemeRow(mode) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Theme';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Follow the system setting, or hold this app to light or dark. '
      + 'The header button flips between light and dark without coming here.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'settings-select';
    select.id = 'appearance-theme-select';
    select.setAttribute('aria-label', 'Theme');
    for (const opt of THEME_OPTIONS) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }
    select.value = mode;
    select.addEventListener('change', () => setMode(select.value));
    ctrl.appendChild(select);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, select };
  }
}
