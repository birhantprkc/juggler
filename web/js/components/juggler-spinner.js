//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Juggler busy spinner — three clubs orbiting a central point and flipping
 * on their own axis, evoking a juggling cascade. The clubs are the same shapes
 * used in the Juggler logo.
 *
 * Usage:
 *   <juggler-spinner></juggler-spinner>
 *   <juggler-spinner style="--size: 2rem"></juggler-spinner>
 *   <juggler-spinner style="--size: 1rem; --duration: 1.2s; color: white"></juggler-spinner>
 *
 * CSS knobs (set on the host):
 *   --size      — overall diameter         (default 1.5rem)
 *   --duration  — one orbital cycle        (default 1.5s)
 *   color       — club fill                (inherited from the parent's
 *                                           `color`, so the spinner adapts
 *                                           to the surrounding theme by
 *                                           default)
 *
 * The clubs are drawn with `fill: currentColor`, so changing `color` on the
 * host (or any ancestor) recolours the spinner — no extra knob needed.
 */

// The two paths from juggler-logo.svg, inlined into a single self-contained
// <svg> whose viewBox tightly frames one club (centred at 0,0). We deliberately
// do NOT use a shared <symbol> + <use>: an <svg> that references a <symbol>
// stacks two coordinate systems, and Firefox 149 mis-resolves the viewport for
// the referenced symbol when the outer <svg> has no viewBox and is CSS-sized —
// the clubs render at the wrong scale/offset and scatter off their orbit (the
// bug is gone by FF 153, but users on 149 hit it). A plain <svg> with a single
// viewBox and no symbol indirection is the most portable SVG construct there
// is and every engine maps it identically. Duplicated three times below —
// cheap, and correctness beats sharing one <symbol>.
const CLUB_SVG_HTML = `<svg viewBox="-26 -42 52 84" aria-hidden="true"><g transform="translate(-67,-122)"><path d="m 66.033179,116.69934 c -4.412016,4.89314 -12.358013,12.52542 -17.596859,23.54326 -1.987636,4.76634 -5.434859,14.13639 -5.857007,17.71365 l 8.582939,4.81728 c 6.977318,-7.0357 13.098603,-13.43877 17.445963,-25.25324 1.421897,-4.1573 3.06366,-10.49489 4.738729,-16.41967 z"/><path d="m 85.934794,81.917297 c -4.696459,0.08969 -6.548377,5.246501 -4.58162,8.852873 -4.714452,10.23004 -10.939485,20.2839 -13.105143,23.40736 l 5.988781,3.50934 c 1.634814,-3.92835 6.500703,-14.4903 11.935189,-24.419178 3.93831,-0.64312 5.787539,-3.93172 5.368148,-6.871415 -0.303232,-3.07033 -3.343756,-4.571558 -5.605355,-4.47898 z"/></g></svg>`;

/**
 * Restart the CSS animations under `el` by toggling it through display:none and
 * back with a synchronous reflow in between. WebKit (WKWebView) leaves a
 * spinner's orbit/spin animation frozen when its start time was fixed while the
 * app was backgrounded or occluded — the animation exists but never advances.
 * The none→reflow→restore tears the animations down and rebuilds them with a
 * fresh start time; because all three steps run synchronously in one task the
 * browser never paints the hidden state, so there's no flicker. Skips spinners
 * with no layout box (a display:none/inactive tab) — those restart when their
 * tab is revealed.
 * @param {HTMLElement} el
 */
function restartSpinner(el) {
  if (el.getClientRects().length === 0) return;
  const prev = el.style.display;
  el.style.display = 'none';
  void el.offsetHeight; // force reflow: commits the display:none, discarding the frozen animations
  el.style.display = prev;
}

/**
 * Restart every on-screen spinner under `root` (default: whole document). Call
 * when the app returns to the foreground or a tab is revealed, to undo the
 * WebKit freeze described on {@link restartSpinner}.
 * @param {ParentNode} [root=document]
 */
export function nudgeSpinners(root = document) {
  root.querySelectorAll('juggler-spinner').forEach((el) => restartSpinner(/** @type {HTMLElement} */ (el)));
}

class JugglerSpinner extends HTMLElement {
  connectedCallback() {
    if (this.childElementCount === 0) {
      // Three pivot/club pairs: each pivot rotates around the centre to
      // place its club on the orbit; each club rotates on its own axis
      // to give the visible flip.
      this.innerHTML = `
                <span class="js-pivot"><span class="js-club">${CLUB_SVG_HTML}</span></span>
                <span class="js-pivot"><span class="js-club">${CLUB_SVG_HTML}</span></span>
                <span class="js-pivot"><span class="js-club">${CLUB_SVG_HTML}</span></span>
            `;
    }
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Loading');
    // Self-heal a spinner created just after the app returns to the foreground:
    // if WebKit stalled the animation timeline, a brand-new spinner starts frozen
    // too. Restart on the next frame (once laid out) to give it a live start time.
    requestAnimationFrame(() => restartSpinner(this));
  }
}

customElements.define('juggler-spinner', JugglerSpinner);
