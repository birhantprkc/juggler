//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme Manager - Handles light/dark theme switching
 * Persists theme preference in localStorage
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';

const THEME_KEY = 'juggler-theme';
const THEMES = {
  DARK: 'dark',
  LIGHT: 'light'
};

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
 * Get current theme: the user's explicit choice if they've made one, otherwise
 * follow the OS light/dark setting.
 * @returns {string} Current theme ('dark' or 'light')
 */
export function getTheme() {
  return localStorage.getItem(THEME_KEY) || systemTheme();
}

/**
 * Set theme and apply to document
 * @param {string} theme - Theme to set ('dark' or 'light')
 */
function setTheme(theme) {
  if (theme !== THEMES.DARK && theme !== THEMES.LIGHT) {
    return;
  }

  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

/**
 * Toggle between light and dark themes
 * @returns {string} New theme after toggle
 */
export function toggleTheme() {
  const currentTheme = getTheme();
  const newTheme = currentTheme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
  setTheme(newTheme);
  return newTheme;
}

/**
 * Apply theme to document
 * @param {string} theme - Theme to apply
 * @private
 */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Paint the <html> element background as an inline style. WebKit caches
  // the canvas colour propagated from html's *CSS* background at first
  // paint and doesn't refresh it from CSS variable changes, so the strip
  // under the transparent macOS titlebar (rendered by the html canvas)
  // stays at the load-time colour. An inline style write bypasses that
  // cache. Keep these in sync with --bg-primary in styles.css.
  const bgPrimary = theme === 'light' ? '#fff' : '#0d1117';
  document.documentElement.style.background = bgPrimary;
  // Tell the Go side so it can repaint the NSWindow chrome (background,
  // opacity, titlebar appearance). Without this the NSWindow stays at its
  // load-time colour and a light page on a dark window flashes dark during
  // every live resize. Handled in cmd/juggler/window_chrome_darwin.go.
  //
  // Only the desktop app that owns this native window can repaint it, via its
  // loopback nativeCtl endpoint. windowControlURL is null for a browser tab or
  // any page without a native host, so we skip the fetch.
  const url = windowControlURL('theme', '?theme=' + encodeURIComponent(theme));
  if (url) {
    fetch(url, { method: 'POST' }).catch(() => { /* one-way; nothing to recover from */ });
  }
}

/**
 * Initialize theme on page load
 */
function initTheme() {
  const urlTheme = new URL(window.location.href).searchParams.get('theme');
  const theme = (urlTheme === THEMES.DARK || urlTheme === THEMES.LIGHT) ? urlTheme : getTheme();
  if (urlTheme === THEMES.DARK || urlTheme === THEMES.LIGHT) {
    localStorage.setItem(THEME_KEY, urlTheme);
  }
  applyTheme(theme);

  // Follow the OS light/dark setting live until the user makes an explicit
  // choice. Once they've picked a theme (stored under THEME_KEY) we stop
  // tracking the OS and honour their choice.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!localStorage.getItem(THEME_KEY)) {
      applyTheme(systemTheme());
    }
  });
}

// Auto-initialize when module loads. Theming is a viewer affordance; the engine
// worker has no document to theme, so skip the auto-init off the main thread.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme);
  } else {
    initTheme();
  }
}
