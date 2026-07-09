//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Caption controls — minimise / maximise-restore / close buttons for the
 * frameless Windows and Linux windows.
 *
 * The desktop window strips the native title bar on Windows (Win32 caption) and
 * Linux (GTK decorations) — see cmd/juggler-app/window_frame_{windows,linux}.go
 * — so the app's own header fills the top of the window, matching the frameless
 * macOS look. macOS keeps its native traffic lights via the transparent
 * MacTitleBar, so it needs no HTML controls; Windows and Linux are the platforms
 * left without window buttons, which this element supplies. The buttons and
 * their glyphs are shared across both; only the CSS chrome differs (flat
 * full-height caption on Windows, rounded Adwaita-style buttons on Linux).
 *
 * Inert everywhere else:
 *   - Remote browsers and the macOS window: CSS keeps the element
 *     `display: none` (it only shows under [data-window-platform="windows"] and
 *     ["linux"] in window-mode), and connectedCallback bails before wiring
 *     anything.
 *
 * Buttons drive the native window through the window-control endpoint (see
 * _control / window-control.js). The maximise glyph flips to a "restore" glyph
 * while the window is maximised, kept in sync with the native state via the
 * runtime's maximise events (which also fire when the user double-clicks the
 * drag region or uses Win+Up).
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';

// Caption glyphs, drawn as 1px strokes on a 10×10 grid so they stay crisp and
// match the thin-line Windows convention. currentColor lets them inherit the
// button's theme colour (and the white-on-red close hover).
const GLYPH = {
  minimise: '<path d="M1 5 h8"/>',
  maximise: '<rect x="1" y="1" width="8" height="8"/>',
  // Two offset squares: a back square peeking out top-right behind the front.
  restore: '<path d="M3 3 V1.5 A0.5 0.5 0 0 1 3.5 1 H8.5 A0.5 0.5 0 0 1 9 1.5 V6.5 A0.5 0.5 0 0 1 8.5 7 H7"/>'
        + '<rect x="1" y="3" width="6" height="6"/>',
  close: '<path d="M1 1 L9 9 M9 1 L1 9"/>',
};

/**
 * Wrap glyph path markup in a themed 10×10 SVG.
 * @param {string} inner - SVG path/rect markup for the glyph.
 * @returns {string} the full `<svg>` element markup.
 */
function svg(inner) {
  return `<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"`
        + ` fill="none" stroke="currentColor" stroke-width="1">${inner}</svg>`;
}

class WindowCaptionControls extends HTMLElement {
  connectedCallback() {
    const root = document.documentElement;
    // Only the frameless in-process windows (Windows, Linux) get caption
    // buttons. Bail in remote browsers, the macOS window (native traffic
    // lights), and any non-window tab.
    const platform = root.dataset.windowPlatform;
    if (root.dataset.windowMode !== '1' || (platform !== 'windows' && platform !== 'linux')) {
      return;
    }
    // Buttons drive the native window through the loopback /api/window/
    // control endpoint (see _control). The Wails runtime is only consulted
    // for best-effort inbound maximise events, so we don't require it.
    const wails = /** @type {any} */ (window).wails || {};

    if (this.childElementCount === 0) {
      this.innerHTML = `
                <button type="button" class="window-caption-btn" data-action="minimise"
                        aria-label="Minimise" title="Minimise">${svg(GLYPH.minimise)}</button>
                <button type="button" class="window-caption-btn" data-action="maximise"
                        aria-label="Maximise" title="Maximise">${svg(GLYPH.maximise)}</button>
                <button type="button" class="window-caption-btn window-caption-btn--close" data-action="close"
                        aria-label="Close" title="Close">${svg(GLYPH.close)}</button>
            `;
    }

    this._maxBtn = this.querySelector('[data-action="maximise"]');
    this.addEventListener('click', (e) => {
      // The click can land on a button or the SVG glyph inside it; both
      // expose closest(). Walk up to the button carrying the action.
      const node = e.target;
      const btn = (node instanceof HTMLElement || node instanceof SVGElement)
        ? node.closest('[data-action]') : null;
      const action = btn?.getAttribute('data-action');
      if (action) this._control(action);
    });

    // Best-effort: reflect OS-driven maximise changes (snap, Win+Up,
    // double-click drag region) onto the glyph. These inbound events are
    // injected by the native side and work even though the outbound
    // Window.* RPC does not, so we keep the subscription when present.
    if (wails.Events?.On) {
      this._offMax = wails.Events.On('common:WindowMaximise', () => this._renderMaxGlyph(true));
      this._offUnmax = wails.Events.On('common:WindowUnMaximise', () => this._renderMaxGlyph(false));
    }
    // Seed the glyph from the current native state.
    this._control('state');
  }

  disconnectedCallback() {
    this._offMax?.();
    this._offUnmax?.();
  }

  /**
   * Drive the native window via the window-control endpoint (the in-process
   * server today, or the desktop app's loopback endpoint via nativeCtl), then
   * sync the maximise/restore glyph from the reported state. The Wails
   * runtime's Window.* RPC can't be used here — it routes through
   * /wails/runtime, which our plain-http page load bypasses.
   * @param {string} action - minimise | maximise | close | state
   */
  _control(action) {
    const url = windowControlURL('control', '?action=' + encodeURIComponent(action));
    if (!url) return; // no native host to drive
    fetch(url, { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) this._renderMaxGlyph(!!data.maximised); })
      .catch(() => { /* window closing or transient — nothing to sync */ });
  }

  /** @param {boolean} maximised */
  _renderMaxGlyph(maximised) {
    if (!this._maxBtn) return;
    this._maxBtn.innerHTML = svg(maximised ? GLYPH.restore : GLYPH.maximise);
    const label = maximised ? 'Restore' : 'Maximise';
    this._maxBtn.setAttribute('aria-label', label);
    this._maxBtn.setAttribute('title', label);
  }
}

customElements.define('window-caption-controls', WindowCaptionControls);
