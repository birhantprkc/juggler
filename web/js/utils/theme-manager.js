//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme Manager - Handles the light/dark/system theme setting.
 *
 * The user picks one of three *modes*, persisted in localStorage:
 *   - 'system' (default): follow the OS light/dark setting, live.
 *   - 'light' / 'dark':   an explicit override that ignores the OS.
 * A mode resolves to a concrete *theme* ('light' or 'dark') for painting.
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { onDocumentReady } from './document-ready.js';

const THEME_KEY = 'juggler-theme';

/** Concrete themes the document can be painted as. */
const THEMES = {
  DARK: 'dark',
  LIGHT: 'light'
};

/** Selectable modes: 'system' follows the OS; the others pin a theme. */
export const MODES = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark'
};

/** Click-cycle order for the header button: System → Light → Dark → System. */
const MODE_CYCLE = [MODES.SYSTEM, MODES.LIGHT, MODES.DARK];

/** Fired on document whenever the mode changes. detail: {mode, theme}. */
export const THEME_MODE_EVENT = 'theme-mode-changed';

/**
 * Resolve the OS-level colour-scheme preference.
 * @returns {string} 'light' if the OS prefers light, otherwise 'dark'
 * @private
 */
function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? THEMES.LIGHT
    : THEMES.DARK;
}

/**
 * Get the user's selected mode. Anything unrecognised (including a missing
 * value, and legacy stores that only ever held 'light'/'dark') falls back to
 * 'system', so the default is to follow the OS.
 * @returns {string} One of MODES.
 */
export function getMode() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === MODES.LIGHT || stored === MODES.DARK || stored === MODES.SYSTEM
    ? stored
    : MODES.SYSTEM;
}

/**
 * Resolve the current mode to the concrete theme to paint. In 'system' mode
 * this tracks the OS; otherwise it's the pinned theme. Consumers that need a
 * definite 'dark'/'light' (e.g. the iframe ?theme= handoff) use this.
 * @returns {string} 'dark' or 'light'
 */
export function getTheme() {
  const mode = getMode();
  return mode === MODES.SYSTEM ? systemTheme() : mode;
}

/**
 * Persist a mode and apply the theme it resolves to.
 * @param {string} mode - One of MODES.
 */
export function setMode(mode) {
  if (mode !== MODES.SYSTEM && mode !== MODES.LIGHT && mode !== MODES.DARK) {
    return;
  }
  localStorage.setItem(THEME_KEY, mode);
  const theme = mode === MODES.SYSTEM ? systemTheme() : mode;
  applyTheme(theme, mode);
  document.dispatchEvent(new CustomEvent(THEME_MODE_EVENT, { detail: { mode, theme } }));
}

/**
 * Advance to the next mode in the System → Light → Dark → System cycle.
 * @returns {string} The newly-selected mode.
 */
export function cycleTheme() {
  const idx = (MODE_CYCLE.indexOf(getMode()) + 1) % MODE_CYCLE.length;
  const next = MODE_CYCLE[idx] ?? MODES.SYSTEM;
  setMode(next);
  return next;
}

/**
 * Paint the document to a resolved theme: set data-theme and the inline <html>
 * background.
 *
 * WebKit caches the canvas colour propagated from html's *CSS* background at
 * first paint and doesn't refresh it from CSS variable changes, so the strip
 * under the transparent macOS titlebar (rendered by the html canvas) stays at
 * the load-time colour. An inline style write bypasses that cache. The value is
 * read back from the just-applied theme's --bg-primary rather than hard-coded,
 * so it can't drift from styles.css.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @private
 */
function paintDocument(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const bgPrimary = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary').trim();
  if (bgPrimary) document.documentElement.style.background = bgPrimary;
}

/**
 * Apply a resolved theme to the document and sync the native window chrome.
 *
 * The native host repaints the NSWindow chrome (background, opacity, titlebar
 * appearance); without this a light page on a dark window flashes dark during
 * every live resize. Handled in cmd/juggler-app/control.go. Only the desktop
 * app that owns this native window can repaint it, via its loopback nativeCtl
 * endpoint — windowControlURL is null for a browser tab or any page without a
 * native host, so we skip the fetch there.
 *
 * In 'system' mode the native host is authoritative for the OS light/dark
 * setting: the WKWebView's prefers-color-scheme can be pinned by the window's
 * forced appearance, so systemTheme() (matchMedia) may be stale. The host
 * clears that forced appearance and reports the true OS theme back; we repaint
 * to whatever it returns.
 * @param {string} theme - Resolved theme to paint ('dark' or 'light').
 * @param {string} mode - The active mode (one of MODES).
 * @private
 */
function applyTheme(theme, mode) {
  paintDocument(theme);

  const url = windowControlURL('theme',
    '?theme=' + encodeURIComponent(theme) + '&mode=' + encodeURIComponent(mode));
  if (!url) return;
  fetch(url, { method: 'POST' })
    .then((resp) => (mode === MODES.SYSTEM ? resp.json() : null))
    .then((data) => {
      // System mode: repaint to the host's authoritative OS theme if it differs
      // from our (possibly appearance-pinned) guess. Don't re-post — the host
      // has already painted its chrome to match.
      const osTheme = data && data.theme;
      if ((osTheme === THEMES.DARK || osTheme === THEMES.LIGHT)
          && osTheme !== document.documentElement.getAttribute('data-theme')) {
        paintDocument(osTheme);
      }
    })
    .catch(() => {});
}

/**
 * Initialize theme on page load
 */
function initTheme() {
  // A ?theme= param (from a native host or parent window) carries a *resolved*
  // theme ('dark'/'light') as a pre-localStorage paint hint. It must not override
  // a mode the user has already chosen: on every relaunch the host replays the
  // last resolved theme, so treating it as the mode would silently demote
  // 'system' to whichever concrete theme happened to be showing. Only let the
  // param pin a mode when this window has no stored preference yet (a first-ever
  // hand-off to a brand-new window); otherwise the persisted mode wins.
  const urlTheme = new URL(window.location.href).searchParams.get('theme');
  const stored = localStorage.getItem(THEME_KEY);
  const hasStoredMode = stored === MODES.SYSTEM || stored === MODES.LIGHT || stored === MODES.DARK;
  if ((urlTheme === THEMES.DARK || urlTheme === THEMES.LIGHT) && !hasStoredMode) {
    localStorage.setItem(THEME_KEY, urlTheme);
    applyTheme(urlTheme, urlTheme);
  } else {
    applyTheme(getTheme(), getMode());
  }

  // In 'system' mode, follow OS light/dark changes live. An explicit
  // light/dark mode pins the theme and ignores the OS.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (getMode() === MODES.SYSTEM) {
      applyTheme(systemTheme(), MODES.SYSTEM);
    }
  });
}

// Auto-initialize when module loads. Theming is a viewer affordance; the engine
// worker has no document to theme, so onDocumentReady skips off the main thread.
onDocumentReady(initTheme);
