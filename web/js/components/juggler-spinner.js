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

// The two paths from juggler-logo.svg, translated so the club's bounding box
// is centred at (0, 0). The viewBox tightly frames a single club.
const CLUB_SYMBOL_HTML = `
    <svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
        <defs>
            <symbol id="juggler-spinner-club" viewBox="-26 -42 52 84">
                <g transform="translate(-67,-122)">
                    <path d="m 66.033179,116.69934 c -4.412016,4.89314 -12.358013,12.52542 -17.596859,23.54326 -1.987636,4.76634 -5.434859,14.13639 -5.857007,17.71365 l 8.582939,4.81728 c 6.977318,-7.0357 13.098603,-13.43877 17.445963,-25.25324 1.421897,-4.1573 3.06366,-10.49489 4.738729,-16.41967 z"/>
                    <path d="m 85.934794,81.917297 c -4.696459,0.08969 -6.548377,5.246501 -4.58162,8.852873 -4.714452,10.23004 -10.939485,20.2839 -13.105143,23.40736 l 5.988781,3.50934 c 1.634814,-3.92835 6.500703,-14.4903 11.935189,-24.419178 3.93831,-0.64312 5.787539,-3.93172 5.368148,-6.871415 -0.303232,-3.07033 -3.343756,-4.571558 -5.605355,-4.47898 z"/>
                </g>
            </symbol>
        </defs>
    </svg>
`;

let symbolInjected = false;

/**
 * Lazily inject a single shared `<symbol>` for the club shape into
 * `document.body`. All spinner instances on the page reference it via
 * `<use href="#juggler-spinner-club">`, so the geometry is defined once
 * regardless of how many spinners are mounted.
 */
function ensureClubSymbol() {
  if (symbolInjected || !document.body) return;
  symbolInjected = true;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = CLUB_SYMBOL_HTML;
  document.body.appendChild(host);
}

class JugglerSpinner extends HTMLElement {
  connectedCallback() {
    ensureClubSymbol();
    if (this.childElementCount === 0) {
      // Three pivot/club pairs: each pivot rotates around the centre to
      // place its club on the orbit; each club rotates on its own axis
      // to give the visible flip.
      this.innerHTML = `
                <span class="js-pivot"><span class="js-club"><svg><use href="#juggler-spinner-club"/></svg></span></span>
                <span class="js-pivot"><span class="js-club"><svg><use href="#juggler-spinner-club"/></svg></span></span>
                <span class="js-pivot"><span class="js-club"><svg><use href="#juggler-spinner-club"/></svg></span></span>
            `;
    }
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
    if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', 'Loading');
  }
}

customElements.define('juggler-spinner', JugglerSpinner);
