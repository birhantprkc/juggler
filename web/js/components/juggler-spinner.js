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
    this._observeVisibility();
  }

  disconnectedCallback() {
    this._io?.disconnect();
    this._io = null;
  }

  /**
   * Self-heal the WKWebView "stuck spinner" bug at the one deterministic moment
   * it matters: when this element actually becomes visible to the user.
   *
   * WebKit freezes a CSS animation whose element was off-layout (its tab or the
   * processing footer was display:none) or occluded (the app was backgrounded)
   * while the animation was declared: when the element is later shown, the
   * orbit/spin animations resume from the start-time that was fixed while hidden
   * and never advance — the spinner appears stuck. Reflowing the element once
   * it is back on-layout (see {@link restart}) rebuilds the animations with a
   * fresh start-time.
   *
   * We do this from the spinner itself rather than asking every caller that
   * shows one (the processing footer, the Pause button, thread-status rows, the
   * model selector, …) to remember to nudge it: an IntersectionObserver reports
   * the exact hidden→shown edge for every show path there is — the `hidden`
   * class coming off, a background tab being revealed, the node scrolled back
   * into view — with no caller coordination. Edge-triggered on `isIntersecting`,
   * so routine status-text updates never restart a spinner that is already
   * running (which would reset it to frame 0 and make it visibly stutter).
   * @private
   */
  _observeVisibility() {
    if (typeof IntersectionObserver === 'undefined') return; // headless / ancient engine: no-op
    let wasVisible = false;
    this._io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (!last) return;
      const visible = last.isIntersecting;
      if (visible && !wasVisible) this.restart();
      wasVisible = visible;
    });
    this._io.observe(this);
  }

  /**
   * Force this spinner's CSS animations to restart with a fresh start-time via a
   * synchronous display none→reflow→restore. All three steps run in one task, so
   * the hidden frame is never painted and there is no flicker. No-op when the
   * element has no layout box (still hidden) — it heals when next shown.
   */
  restart() {
    if (this.getClientRects().length === 0) return;
    const prev = this.style.display;
    this.style.display = 'none';
    void this.offsetHeight; // commit the display:none, discarding the frozen animations
    this.style.display = prev;
  }
}

customElements.define('juggler-spinner', JugglerSpinner);
