//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Native window-control transport — theme repaint, title, minimise/maximise/
 * close, and "new window". These drive the *native window* that hosts this
 * page, which is not necessarily the server that served it.
 *
 * The only thing that can drive a native window is the desktop app that owns it:
 * it bakes its own loopback control endpoint into the window's URL as the
 * `nativeCtl` query param. A plain browser tab — or any page opened without that
 * param — has no native host, so these calls are no-ops (windowControlURL
 * returns null and callers skip).
 *
 * Resolved once at module load — the owner bakes the value into the URL and it
 * never changes for the life of the document.
 */
const CONTROL_BASE = (() => {
  // The engine worker has no window and is never a native-hosted window, so it
  // has no control endpoint — bail before touching window.location.
  if (typeof window === 'undefined') return null;
  const param = new URL(window.location.href).searchParams.get('nativeCtl');
  // Trailing slash stripped so callers append '/theme' etc. unconditionally.
  return param ? param.replace(/\/+$/, '') : null;
})();

/**
 * Build the URL for a native window-control endpoint, or null when this page has
 * no native host to control (a browser tab, or any non-app window). Callers must
 * skip the request when this returns null.
 * @param {string} endpoint - 'theme' | 'title' | 'control' | 'new'
 * @param {string} [query] - optional query string including the leading '?'
 * @returns {string|null} the URL to POST to, or null if there is no native host
 */
export function windowControlURL(endpoint, query = '') {
  return CONTROL_BASE ? `${CONTROL_BASE}/${endpoint}${query}` : null;
}

/**
 * Whether this page is hosted in a native desktop-app window (as opposed to a
 * plain browser tab). Used to gate native-only affordances like the folder
 * picker's "Browse…" button.
 * @returns {boolean} True when a native control host is present.
 */
export function hasNativeHost() {
  return CONTROL_BASE !== null;
}

/**
 * Open the native folder chooser (desktop app only) and resolve with the chosen
 * absolute path, or null if there is no native host or the user cancelled.
 * @returns {Promise<string|null>} The chosen directory path, or null.
 */
export async function pickDirectory() {
  const url = windowControlURL('pick-directory');
  if (!url) return null;
  try {
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && typeof data.path === 'string' && data.path ? data.path : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a clicked anchor should be opened externally, and with what
 * URL — the safety net for links in rendered markdown (LLM/user/tool output).
 *
 * Two cases must open in the system browser rather than navigate the app's
 * webview off its page:
 *  - An explicit cross-origin `http(s)` link (`[repo](https://github.com/u/r)`).
 *  - A *scheme-less* bare-domain link (`[repo](github.com/u/r)`). marked parses
 *    that as a relative href, so the browser resolves it same-origin
 *    (`http://<app>/github.com/u/r`) — a plain click would tear the app off its
 *    page. We recover the author's intent from the raw href and re-qualify it to
 *    `https://`.
 *
 * Everything else (in-page `#hash`, genuine relative paths, same-origin explicit
 * links, non-web schemes) returns null so the default behaviour is left intact.
 * @param {string} rawHref - The anchor's unresolved `getAttribute('href')`.
 * @param {string} resolvedHref - The anchor's resolved `.href` (absolute).
 * @param {string} [currentOrigin] - Origin to treat as "this app" (defaults to
 *   the current document's origin).
 * @returns {string|null} The URL to open externally, or null to leave the click alone.
 */
export function externalURLFromHref(rawHref, resolvedHref, currentOrigin) {
  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const trimmed = (rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Scheme-less, non-absolute href: a candidate bare external domain. Only
  // re-qualify when the first segment is a real-looking host AND there's a path
  // after it (or a `www.` prefix), so single relative files like `readme.md`
  // stay relative while `github.com/u/r` and `www.example.com` open externally.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (!hasScheme && !trimmed.startsWith('/') && !trimmed.startsWith('?')) {
    const firstSeg = trimmed.split(/[/?#]/, 1)[0] || '';
    const looksDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(firstSeg);
    const hasPath = trimmed.length > firstSeg.length;
    const isWww = /^www\./i.test(firstSeg);
    return looksDomain && (hasPath || isWww) ? `https://${trimmed}` : null;
  }

  // Explicit scheme (or absolute path): only intercept cross-origin web links.
  let url;
  try {
    url = new URL(resolvedHref);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === origin) return null;
  return resolvedHref;
}

/**
 * Open a URL outside the current document. A native app window POSTs to its
 * loopback `open` endpoint so WebKit hands the URL to the system browser
 * (target=_blank on a plain `http://<ip>` link is otherwise swallowed by a
 * native WebView); a browser tab — with no native host — opens a new tab.
 * @param {string} url - The URL to open externally.
 */
export function openExternalURL(url) {
  const ctl = windowControlURL('open', `?url=${encodeURIComponent(url)}`);
  if (ctl) {
    void fetch(ctl, { method: 'POST' }).catch(() => {});
    return;
  }
  window.open(url, '_blank', 'noopener');
}
