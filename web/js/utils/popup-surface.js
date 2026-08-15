//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Popup Surface — the single authority for presenting a button-anchored popup.
 *
 * The single home for the ~20-line dance every transient surface needs
 * (model/strategy/permission pickers, the commands and at-mention/slash
 * autocompletes, context-add and extension dropdowns): append to <body>, wire
 * dismissal via `registerOpenPopup`, place with `positionDropdown`, run a
 * `MutationObserver` to reposition on content change, then unwind all of it on
 * close.
 *
 * Presentation is chosen from a single media query and is the ONLY place that
 * knows the difference between a desktop dropdown and a phone sheet:
 *   - Wide viewport → anchored dropdown next to the trigger (`positionDropdown`
 *     + the reposition observer).
 *   - Narrow viewport (≤ 36rem) → a bottom sheet. Modal sheets (the pickers)
 *     get a dimmed scrim + grabber and dismiss on scrim-tap / Escape / back;
 *     non-modal sheets (caret autocompletes) dock to the bottom without a scrim
 *     so the textarea behind them keeps focus and the typing that drives them
 *     continues. The class `.popup-sheet` carries every sheet visual in CSS.
 *
 * The narrow/wide decision re-runs if the viewport crosses the breakpoint while
 * the popup is open (rotation, window resize), so an open popup is never left
 * in the wrong presentation.
 * @see web/sdk/lib/dropdown-positioning.js — anchored placement maths.
 * @see web/js/utils/popup-manager.js — `registerOpenPopup` dismissal wiring.
 */

import { positionDropdown } from '../../sdk/lib/dropdown-positioning.js';
import { registerOpenPopup } from './popup-manager.js';

/**
 * Viewport width at or below which popups present as bottom sheets. Matches the
 * phone breakpoint used by the rest of the app (see styles.css responsive
 * section) and the `.popup-sheet` CSS block in styles.css.
 * @type {string}
 */
const SHEET_QUERY = '(width <= 36rem)';

/**
 * Present an already-built popup surface and wire everything it needs.
 *
 * Call when the popup OPENS; run the returned `release` exactly once when it
 * closes (idempotent). The surface must NOT already be in the DOM — this owns
 * appending it to <body> and removing it on release.
 * @param {object} opts
 * @param {HTMLElement} opts.surface - The popup element to present (detached).
 * @param {HTMLElement} opts.anchor - The trigger element it anchors to (wide).
 * @param {string} opts.id - Unique popup id for mutual exclusion.
 * @param {() => void} opts.onClose - Idempotent close callback.
 * @param {'left'|'right'} [opts.align='left'] - Anchored horizontal alignment.
 * @param {number} [opts.gap=8] - Gap (px) between anchor and dropdown (wide).
 * @param {string[]} [opts.insideSelectors] - Selectors whose subtree counts as
 *   "inside" for outside-click dismissal. Omit for surfaces that keep the
 *   textarea focused (autocompletes) or do their own outside handling.
 * @param {boolean} [opts.reposition=true] - Observe content changes and
 *   reposition while anchored (wide only).
 * @param {boolean} [opts.modal=true] - Sheet flavour on narrow screens: modal
 *   (scrim + grabber, scrim-tap dismisses) or non-modal (docked, no scrim,
 *   does not steal focus). Ignored while anchored.
 * @returns {() => void} release - Tears down surface, scrim, observer, media
 *   listener and dismissal wiring. Idempotent.
 */
export function presentPopup({
  surface,
  anchor,
  id,
  onClose,
  align = 'left',
  gap = 8,
  insideSelectors,
  reposition = true,
  modal = true,
}) {
  // Hide until first placed. The surface's base `.dropdown-menu` rule pins it
  // to a default top-left corner; appending it now and positioning a frame
  // later (in the rAF below) would paint one frame at that corner before the
  // jump. `visibility: hidden` keeps it laid out and measurable — so
  // positionDropdown can still read its dimensions — without painting it.
  surface.style.visibility = 'hidden';
  document.body.appendChild(surface);

  // Mutual exclusion + Escape + open-state (+ optional outside-click). In sheet
  // mode the scrim is the visible outside target, but the same selector-based
  // handler still resolves taps on it to "outside", so one path serves both.
  const releaseDismiss = registerOpenPopup({ id, onClose, insideSelectors });

  /** @type {HTMLElement|null} */
  let scrim = null;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** @type {HTMLElement|null} Drag handle injected at the top of a modal sheet. */
  let grabber = null;

  const reposToAnchor = () => positionDropdown(surface, anchor, gap, { align });

  // --- Bottom-sheet drag-to-dismiss ---------------------------------------
  // The grabber affords the idiomatic grab-and-drag-down gesture: the sheet
  // tracks the finger down and dismisses once dragged past the threshold,
  // snapping back otherwise. It lives on the grabber element (which sets
  // `touch-action: none`) so the gesture is never claimed by the sheet's own
  // scroll — no need to fight or sniff scroll position.
  /** Distance (px) past which releasing the drag dismisses the sheet. */
  const SHEET_DISMISS_PX = 90;
  let dragStartY = 0;
  let dragDy = 0;

  const onGrabberDown = (/** @type {PointerEvent} */ e) => {
    dragStartY = e.clientY;
    dragDy = 0;
    grabber?.setPointerCapture(e.pointerId);
    surface.style.transition = 'none'; // track the finger 1:1 while dragging
  };
  const onGrabberMove = (/** @type {PointerEvent} */ e) => {
    if (!grabber?.hasPointerCapture(e.pointerId)) return;
    dragDy = Math.max(0, e.clientY - dragStartY);
    surface.style.transform = `translateY(${dragDy}px)`;
  };
  const onGrabberUp = (/** @type {PointerEvent} */ e) => {
    if (grabber?.hasPointerCapture(e.pointerId)) grabber.releasePointerCapture(e.pointerId);
    // Restore the CSS transform transition so the sheet glides back (or away).
    surface.style.removeProperty('transition');
    surface.style.removeProperty('transform');
    if (dragDy > SHEET_DISMISS_PX) onClose();
    dragDy = 0;
  };

  const addGrabber = () => {
    if (grabber) return;
    grabber = document.createElement('div');
    grabber.className = 'popup-sheet-grabber';
    grabber.addEventListener('pointerdown', onGrabberDown);
    grabber.addEventListener('pointermove', onGrabberMove);
    grabber.addEventListener('pointerup', onGrabberUp);
    grabber.addEventListener('pointercancel', onGrabberUp);
    surface.insertBefore(grabber, surface.firstChild);
  };
  const removeGrabber = () => {
    if (!grabber) return;
    grabber.remove();
    grabber = null;
    surface.style.removeProperty('transition');
    surface.style.removeProperty('transform');
  };

  const applyAnchored = () => {
    surface.classList.remove('popup-sheet', 'popup-sheet-modal');
    removeGrabber();
    if (scrim) {
      scrim.remove();
      scrim = null;
    }
    reposToAnchor();
    if (reposition && !observer) {
      observer = new MutationObserver(reposToAnchor);
      observer.observe(surface, { childList: true, subtree: true, characterData: true });
    }
  };

  const applySheet = () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Drop the anchored inline geometry so the CSS sheet rules govern fully.
    surface.style.removeProperty('--dropdown-x');
    surface.style.removeProperty('--dropdown-y');
    surface.style.removeProperty('max-height');
    surface.classList.add('popup-sheet');
    surface.classList.toggle('popup-sheet-modal', modal);
    // Only modal sheets get the drag handle. Non-modal docked autocompletes
    // (@-mention, slash) are driven by typing and dismissed by the textarea,
    // never by a drag, so a grabber there would be misleading.
    if (modal) {
      addGrabber();
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.className = 'popup-sheet-scrim';
        scrim.addEventListener('click', () => onClose());
        document.body.appendChild(scrim);
      }
    }
  };

  const apply = () => {
    if (mql.matches) applySheet(); else applyAnchored();
    // Placed — reveal it. Harmless to repeat on a breakpoint-crossing re-apply.
    surface.style.removeProperty('visibility');
  };

  const mql = window.matchMedia(SHEET_QUERY);
  mql.addEventListener('change', apply);

  // Position after layout so the surface has measurable dimensions.
  requestAnimationFrame(apply);

  return () => {
    mql.removeEventListener('change', apply);
    if (observer) observer.disconnect();
    if (scrim) scrim.remove();
    surface.remove();
    releaseDismiss();
  };
}
