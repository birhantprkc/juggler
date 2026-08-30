//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Updating a list of rows in place, for the pins whose bodies are lists.
 *
 * A pin is told to render whenever what it reads may have changed, which for a
 * conversation under way is often and for a list that has not moved is pointless.
 * Rebuilding the rows each time throws away every element and every listener on
 * it, so a row cannot hold focus, a selection or a hover across a render, and the
 * work is proportional to the whole list however little of it differs.
 *
 * The reconciliation here is the tab strip's
 * ({@link module:components/pinboard-tabbar}), in a form the pins can share: rows
 * are matched by a key they carry in `data-row-key`, reused where the key is
 * still wanted, moved only when they are out of place, and dropped when they are
 * not. Building a row and filling it are kept apart so that the parts which never
 * change for a given key — its listeners above all — are written once.
 * @module lib/reconcile
 */

/**
 * One element of a body whose lines come and go with what there is to say — a
 * clean repository has no file list, a pin with nothing to complain about has no
 * error line. The key is what tells "this line again" from "a different line in
 * its place".
 * @typedef {object} PartSpec
 * @property {string} key - Its identity within its container.
 * @property {() => HTMLElement} build - Build it, once.
 * @property {(el: HTMLElement) => void} fill - Write its current words.
 */

/**
 * Write an element's text only when it differs. An assignment that changes
 * nothing still costs a layout invalidation on the row it lands in.
 * @param {HTMLElement} el - The element to write into.
 * @param {string} text - What it should say.
 * @returns {void}
 */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Bring a container's children into line with a keyed list.
 *
 * Everything left in the container that the list does not account for is
 * removed, so a container holding a placeholder is reconciled into a list without
 * the placeholder surviving underneath it. Anything that has to outlive a render
 * without being one of the entries — a trailing error line, say — belongs after
 * this call rather than before it.
 * @template T
 * @param {HTMLElement} parent - The container whose children are the rows.
 * @param {T[]} entries - What the list should hold, in order.
 * @param {(entry: T) => string} keyOf - One entry's stable identity.
 * @param {(entry: T) => HTMLElement} build - Build a row for an entry with no row yet.
 * @param {(row: HTMLElement, entry: T) => void} fill - Write an entry's current values into its row.
 * @returns {void}
 */
export function reconcileRows(parent, entries, keyOf, build, fill) {
  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const key = /** @type {HTMLElement} */ (child).dataset.rowKey;
    if (key !== undefined && !existing.has(key)) existing.set(key, /** @type {HTMLElement} */ (child));
  }

  /** @type {ChildNode|null} */
  let expected = parent.firstChild;
  for (const entry of entries) {
    const key = keyOf(entry);
    let row = existing.get(key);
    if (row) existing.delete(key);
    else {
      row = build(entry);
      row.dataset.rowKey = key;
    }
    fill(row, entry);
    if (row !== expected) parent.insertBefore(row, expected);
    expected = row.nextSibling;
  }

  // Each entry was placed before whatever `expected` pointed at, so every child
  // the list did not claim has been pushed past it and the tail is exactly the
  // leftovers.
  while (expected) {
    const next = expected.nextSibling;
    expected.remove();
    expected = next;
  }
}

/**
 * Bring a container into line with the parts it should hold.
 * @param {HTMLElement} parent - The container.
 * @param {PartSpec[]} parts - What it should hold, in order.
 * @returns {void}
 */
export function reconcileParts(parent, parts) {
  reconcileRows(parent, parts, (part) => part.key, (part) => part.build(), (el, part) => part.fill(el));
}
