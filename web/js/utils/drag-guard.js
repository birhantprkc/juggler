//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tell a click apart from the end of a window drag.
 *
 * In the desktop app the header is the window's drag region, so anything sitting
 * in it can be grabbed to move the window — and the release at the end of that
 * drag arrives as a click on whatever was grabbed. Nobody who has just dragged
 * their window across a screen meant to press the thing under the cursor.
 *
 * The window moves with the pointer, so the press and the release land on the
 * same spot of the page: only screen coordinates say the gesture went anywhere.
 * @module utils/drag-guard
 */

/** How far the pointer may travel and still be a click, in screen pixels. */
const SLOP = 4;

/**
 * Watch a press, so the click that follows it can be dismissed when it turns out
 * to be the end of a drag.
 *
 * The move listener is on the document and lasts one gesture: a pointer dragged
 * off the element still counts, and nothing is left behind when it is over.
 * @returns {{watch: (event: Event) => void, dragged: () => boolean}} `watch` on
 *   pointerdown, `dragged` in the click handler.
 */
export function dragGuard() {
  let moved = false;
  return {
    watch: (event) => {
      moved = false;
      const { screenX, screenY } = /** @type {PointerEvent} */ (event);
      /** @param {Event} e - Where the pointer has reached. */
      const onMove = (e) => {
        const at = /** @type {PointerEvent} */ (e);
        if (Math.abs(at.screenX - screenX) > SLOP || Math.abs(at.screenY - screenY) > SLOP) moved = true;
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', () => {
        document.removeEventListener('pointermove', onMove);
      }, { once: true });
    },
    dragged: () => moved,
  };
}
