//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The pinboard's add picker — the menu behind `+`, and behind the empty state's
 * `Add…`. One list, one code path: two lists of what can be added would be two
 * lists to keep true.
 *
 * One heading, saying what the menu does, over one list. The list is short
 * enough that headings above stretches of it would be furniture rather than
 * navigation, and an item type sorts by the `order` it asks for rather than by
 * any taxonomy of where it came from. An item type that cannot be added right
 * now says why instead of quietly vanishing — "No project" is information; an
 * absence is a puzzle. One already on the board is offered as what it is: a row
 * that can no longer be chosen, because it has been.
 *
 * The surface is a standard `.dropdown-menu` presented by
 * {@link module:utils/popup-surface|presentPopup}, so it inherits anchored
 * placement, the phone bottom sheet, Escape, outside-click and focus return.
 * @module components/pinboard-add-picker
 */

import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import pinboardStore from '../services/pinboard-store.js';
import { presentPopup } from '../utils/popup-surface.js';

/** Shared popup id, so opening any other menu dismisses this one. */
const POPUP_ID = 'pinboard-add-picker';

/** Above this many entries the list earns a filter box; below it, the eye is faster. */
const FILTER_THRESHOLD = 8;

/** What the menu is for, over the one list it holds. */
const HEADING = 'Add new pinned item';

/**
 * One row's worth of decisions about an item type.
 * @typedef {object} PickerEntry
 * @property {string} id - Item-type id.
 * @property {string} name - What to call it here.
 * @property {number} order - The sort key it asked for.
 * @property {string} reason - Why it can't be added, or '' when it can.
 * @property {boolean} pinned - Whether a singleton of this type is already on the board.
 */

/**
 * What the picker should offer, given what is enabled and what is already pinned.
 *
 * Sorted by the manifest's `order` and then by registration, so a type that
 * wants the top of the list says so once rather than relying on where its file
 * happens to fall in an alphabetical glob.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} active - Active-context snapshot.
 * @returns {PickerEntry[]} The entries, in the order they are shown.
 */
function collectEntries(active) {
  const pinnedTypes = new Set(pinboardStore.get().map((pin) => pin.type));
  /** @type {PickerEntry[]} */
  const entries = [];
  for (const type of pinboardItemRegistry.getEnabledTypes()) {
    const manifest = type.getManifest();
    if (manifest.addable === false) continue;
    let reason = '';
    try {
      const allowed = type.canAdd(active);
      if (allowed !== true) reason = typeof allowed === 'string' ? allowed : 'Unavailable';
    } catch (err) {
      console.error(`[Pinboard] Item type "${type.id}" failed to answer canAdd:`, err);
      reason = 'Unavailable';
    }
    entries.push({
      id: type.id,
      // What the menu calls it, which is not always what the pin is called: a
      // type that opens a chooser rather than adding on the spot says so here.
      name: manifest.addLabel || type.name,
      order: Number.isFinite(manifest.order) ? Number(manifest.order) : 0,
      reason,
      pinned: !type.allowsMultiple && pinnedTypes.has(type.id),
    });
  }
  // Stable: Array.prototype.sort is, so equal orders keep registration order.
  return entries.sort((a, b) => a.order - b.order);
}

/**
 * Open the add picker.
 * @param {object} opts - Options.
 * @param {HTMLElement} opts.anchor - The control it hangs from.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} opts.active - Active-context snapshot.
 * @param {(typeId: string) => void} opts.onPick - Called with the chosen item-type id.
 * @returns {() => void} Close the picker. Idempotent.
 */
export function openAddPicker({ anchor, active, onPick }) {
  const entries = collectEntries(active);

  const menu = document.createElement('nav');
  menu.className = 'dropdown-menu pinboard-add-picker show';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Add to Pinboard');

  /** @type {(() => void)|null} */
  let release = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    anchor.setAttribute('aria-expanded', 'false');
    release?.();
    release = null;
  };

  /** @type {HTMLInputElement|null} */
  let filter = null;
  if (entries.length > FILTER_THRESHOLD) {
    filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'pinboard-add-picker__filter';
    filter.placeholder = 'Search…';
    filter.setAttribute('aria-label', 'Search pinboard items');
    filter.addEventListener('input', () => render(filter?.value || ''));
    menu.appendChild(filter);
  }

  const list = document.createElement('menu');
  menu.appendChild(list);

  /**
   * Draw the rows matching a filter string.
   * @param {string} query - What the user has typed.
   * @returns {void}
   */
  function render(query) {
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle))
      : entries;

    const heading = document.createElement('li');
    heading.className = 'category-header';
    heading.textContent = HEADING;
    list.replaceChildren(heading);

    if (!shown.length) {
      const empty = document.createElement('li');
      empty.className = 'menu-item unavailable';
      empty.textContent = needle ? 'Nothing.' : 'Nothing to add.';
      list.appendChild(empty);
      return;
    }

    for (const entry of shown) list.appendChild(buildRow(entry));
  }

  /**
   * One entry's row.
   * @param {PickerEntry} entry - The item type.
   * @returns {HTMLElement} The row.
   */
  function buildRow(entry) {
    // A singleton already on the board is a row with nothing left to do. It is
    // shown, so the list stays the same list every time it opens, and it is
    // dead, because "add" is not what a second click on it would mean.
    const spent = entry.pinned || !!entry.reason;
    const row = document.createElement('li');
    row.className = `menu-item pinboard-add-picker__item${spent ? ' unavailable' : ''}`;
    row.setAttribute('role', 'menuitem');
    row.dataset.typeId = entry.id;

    const name = document.createElement('span');
    name.className = 'menu-item-name';
    name.textContent = entry.name;
    row.appendChild(name);

    // Only a refusal has anything to add. A row that is already on the board
    // says so by being dead — a word beside it would be the same fact twice.
    if (entry.reason) {
      const detail = document.createElement('span');
      detail.className = 'pinboard-add-picker__note';
      detail.textContent = entry.reason;
      row.appendChild(detail);
    }

    if (spent) {
      row.setAttribute('aria-disabled', 'true');
      return row;
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      onPick(entry.id);
    });
    return row;
  }

  render('');

  anchor.setAttribute('aria-expanded', 'true');
  release = presentPopup({
    surface: menu,
    anchor,
    id: POPUP_ID,
    onClose: close,
    align: 'right',
    gap: 6,
    insideSelectors: ['.pinboard-add-picker'],
  });

  filter?.focus();
  return close;
}
