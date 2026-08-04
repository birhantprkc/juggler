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
 * POST to a native window-control endpoint — best-effort, one-way, fire-and-
 * forget. A no-op when this page has no native host to control (a browser tab,
 * where windowControlURL returns null). Failures are swallowed: these signals
 * drive the native window and have nothing to recover from.
 * @param {string} endpoint - 'theme' | 'title' | 'attention' | 'open' | ...
 * @param {string} [query] - optional query string including the leading '?'
 * @returns {void}
 */
export function postWindowControl(endpoint, query = '') {
  const url = windowControlURL(endpoint, query);
  if (url) void fetch(url, { method: 'POST' }).catch(() => {});
}

/**
 * Whether this page is hosted in a native desktop-app window (window-mode) as
 * opposed to a plain browser tab. Reads the `windowMode` document flag the host
 * bakes onto <html>, which drives the browser-tab vs desktop-window UX split
 * (title reporting, dock-bounce vs tab-title badge). Distinct from
 * {@link hasNativeHost}, which reports whether a control endpoint exists.
 * @returns {boolean} True when running as a native desktop-app window.
 */
export function isDesktopWindow() {
  return typeof document !== 'undefined'
    && document.documentElement.dataset.windowMode === '1';
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
 * Decide whether a clicked anchor points at a *local project file* that should
 * be opened with the host OS's default handler, and return the project-relative
 * path to open — the companion to {@link externalURLFromHref} for the other half
 * of the "an LLM-authored link hijacked my window" problem.
 *
 * Markdown-rendered output (LLM/tool/user) routinely emits relative links to
 * on-disk files, e.g. `[report](.juggler/…/txn_…-context-report.md)`. That
 * anchor is same-origin and scheme-less, so a plain click navigates the webview
 * to `http://<app>/.juggler/…` — a path the server does not serve, so it
 * replaces the whole app with a bare "404 page not found" the user cannot back
 * out of (no browser chrome in a native window). The click handler instead
 * hands the path to the OS-open op, which resolves it against the project
 * working dir (server-side, confined) and opens it like a double-click.
 *
 * Returns the decoded, project-relative path (leading slashes stripped) for a
 * same-origin http(s) navigation that would leave the app's page; null for
 * external links (handled by {@link externalURLFromHref}), in-page `#hash`
 * anchors, non-web schemes, and links back to the app root itself.
 * @param {string} rawHref - The anchor's unresolved `getAttribute('href')`.
 * @param {string} resolvedHref - The anchor's resolved `.href` (absolute).
 * @param {string} [currentOrigin] - Origin to treat as "this app" (defaults to
 *   the current document's origin).
 * @returns {string|null} The project-relative path to open, or null to leave the click alone.
 */
export function localFilePathFromHref(rawHref, resolvedHref, currentOrigin) {
  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const trimmed = (rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // External links (explicit cross-origin, or a scheme-less bare domain like
  // `github.com/u/r`) open in the system browser via externalURLFromHref — they
  // are never local files. Deferring to it keeps the two halves in one source.
  if (externalURLFromHref(rawHref, resolvedHref, origin)) return null;

  let url;
  try {
    url = new URL(resolvedHref);
  } catch {
    return null;
  }
  // Only a same-origin web navigation reaches the app's own server; anything
  // else (mailto:, file:, a cross-origin host) is left to default handling.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== origin) return null;

  // A link back to the app root itself (or a pure `?query` on the current page)
  // is not a file to open — only a path below the root is.
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  return rel === '' ? null : rel;
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
