//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Asset URL resolution — the single rule for turning a server-relative module
 * URL into a fetchable one. Embedded builtin assets are served under a
 * version-prefixed path for cache busting (`window.__assetPrefix`); disk-served
 * extension paths bypass it. Both the registry module loader and the extension
 * system-prompt-contribution loader resolve URLs through here so they agree.
 * @module utils/asset-url
 */

/** URL prefixes whose files are served straight from disk (no cache-busting). */
const DISK_SERVED_PREFIXES = ['/user-extensions/'];

/**
 * Whether a served URL is delivered from disk (and so must skip cache-busting).
 * @param {string} url - Server-relative URL
 * @returns {boolean} True if the URL is served from disk
 */
export function isDiskServedPath(url) {
  return DISK_SERVED_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Resolve a server-relative module URL to a fetchable one, applying the
 * versioned asset prefix to embedded builtin paths (cache busting) while
 * leaving disk-served and already-absolute paths untouched.
 * @param {string} url - Server-relative module URL (e.g. '/extensions/x/y.js')
 * @returns {string} The resolved URL to import/fetch
 */
export function resolveAssetUrl(url) {
  const assetPrefix = /** @type {any} */ (globalThis).__assetPrefix;
  const needsPrefix = assetPrefix && url.startsWith('/') && !isDiskServedPath(url);
  return needsPrefix ? assetPrefix + url : url;
}

/**
 * Dynamic-import a resolved module URL, routing through the server's
 * /worker-module loader when running without a document (the engine worker).
 * A module worker has no import map, so the bare `juggler/*` SDK specifiers
 * inside capability modules only resolve when the server rewrites them; the
 * loader does that rewrite. In the viewer/WebView (document present) the URL is
 * imported directly. Both registry and system-prompt capability loaders go
 * through here so plugins load identically on either thread.
 * @param {string} resolvedUrl - The asset-resolved module URL
 * @returns {Promise<any>} The imported module namespace
 */
export function importModuleUrl(resolvedUrl) {
  if (typeof document === 'undefined') {
    return import(/* @vite-ignore */ `/worker-module?url=${encodeURIComponent(resolvedUrl)}`);
  }
  return import(/* @vite-ignore */ resolvedUrl);
}
