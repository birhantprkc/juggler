//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared column-resize wiring for Miller-column children
 * (conversation-area, properties-panel, conversation-bar). The column
 * itself hosts a `col-resize-handle` on its right edge; dragging it
 * sets a rem-based width on the column and persists it to localStorage
 * under the caller-supplied key so all columns of the same kind share
 * a width. Storing in rem means widths track the app zoom level (root
 * font-size) automatically.
 *
 * Hiding the handle on the rightmost column is handled by CSS
 * (`column-container > *:last-child col-resize-handle`), not here.
 * @module utils/column-resize
 */

export const COL_MIN_WIDTH_REM = 12.5;
export const COL_MAX_WIDTH_REM = 100;

/**
 * @returns {number} Current root font-size in CSS pixels.
 */
function _remPx() {
  return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Apply a width (in rem) to `element` and persist it under `storageKey`.
 * @param {HTMLElement} element
 * @param {string} storageKey
 * @param {number} rem
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthRem(element, storageKey, rem, minWidthRem = COL_MIN_WIDTH_REM) {
  const clamped = Math.max(minWidthRem, Math.min(COL_MAX_WIDTH_REM, rem));
  element.style.width = `${clamped}rem`;
  try {
    localStorage.setItem(storageKey, clamped.toString());
  } catch {
    // localStorage unavailable
  }
}

/**
 * Apply a width (in CSS pixels) to `element` and persist it as rem.
 * Convenience for callers that compute widths in px (e.g. auto-fit
 * tab-bar sizing).
 * @param {HTMLElement} element
 * @param {string} storageKey
 * @param {number} px
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthPx(element, storageKey, px, minWidthRem = COL_MIN_WIDTH_REM) {
  applyColumnWidthRem(element, storageKey, px / _remPx(), minWidthRem);
}

/**
 * Attach drag handlers + localStorage persistence to `element`'s
 * `.col-resize-handle` child.
 * @param {HTMLElement} element - The column element (must be position: relative).
 * @param {string} storageKey - localStorage key under which width is persisted.
 * @param {number} [minWidthRem] - Minimum width in rem (defaults to COL_MIN_WIDTH_REM).
 * @param {number} [defaultWidthRem] - Initial width (rem) to apply when nothing
 *   is persisted yet. Applied as an inline style only (NOT persisted), so it
 *   gives new users a sensible fixed width instead of the flex-fill default —
 *   which otherwise makes the column resize to fill the page as sibling columns
 *   are shown/hidden. The first drag replaces it with a persisted width.
 */
export function setupColumnResize(
  element,
  storageKey,
  minWidthRem = COL_MIN_WIDTH_REM,
  defaultWidthRem = undefined,
) {
  const handle = element.querySelector('col-resize-handle');
  if (!handle) return;

  _loadColumnWidth(element, storageKey, minWidthRem, defaultWidthRem);

  // Prevent resize-handle clicks from bubbling to the column-container's
  // click handler, which would change active column and scroll into view.
  handle.addEventListener('click', (e) => e.stopPropagation());

  // Only highlight on mouse hover — touch devices don't get a hover state.
  handle.addEventListener('pointerenter', (e) => {
    if (/** @type {PointerEvent} */ (e).pointerType === 'mouse') handle.classList.add('hovered');
  });
  handle.addEventListener('pointerleave', () => handle.classList.remove('hovered'));

  handle.addEventListener('pointerdown', (/** @type {Event} */ e) => {
    const pointerEvent = /** @type {PointerEvent} */ (e);
    pointerEvent.preventDefault();
    /** @type {HTMLElement} */ (handle).setPointerCapture(pointerEvent.pointerId);

    const startX = pointerEvent.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const remPx = _remPx();
    const minPx = minWidthRem * remPx;
    const maxPx = COL_MAX_WIDTH_REM * remPx;

    handle.classList.add('dragging');

    const onMove = (/** @type {Event} */ e) => {
      const moveEvent = /** @type {PointerEvent} */ (e);
      const deltaX = moveEvent.clientX - startX;
      let newWidth = startWidth + deltaX;
      newWidth = Math.max(minPx, Math.min(maxPx, newWidth));
      // Use px during drag for smooth pixel-accurate feedback;
      // converted back to rem on pointerup.
      element.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      const finalPx = element.getBoundingClientRect().width;
      applyColumnWidthPx(element, storageKey, finalPx, minWidthRem);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/**
 * @param {HTMLElement} element
 * @param {string} storageKey
 * @param {number} minWidthRem
 * @param {number} [defaultWidthRem] - Non-persisted fallback width (rem) when
 *   nothing valid is stored under `storageKey`.
 */
function _loadColumnWidth(element, storageKey, minWidthRem, defaultWidthRem = undefined) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const rem = parseFloat(saved);
      if (Number.isFinite(rem) && rem > 0) {
        applyColumnWidthRem(element, storageKey, rem, minWidthRem);
        return;
      }
    }
  } catch {
    // localStorage unavailable
  }
  // No usable saved width — apply the caller's default without persisting it, so
  // it stays a plain default (the first drag is what writes to localStorage).
  if (typeof defaultWidthRem === 'number') {
    const clamped = Math.max(minWidthRem, Math.min(COL_MAX_WIDTH_REM, defaultWidthRem));
    element.style.width = `${clamped}rem`;
  }
}
