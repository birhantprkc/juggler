//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Clipboard helpers that work in BOTH secure and insecure contexts.
 *
 * The async Clipboard API (`navigator.clipboard`) is only exposed in a *secure
 * context* — `https://`, `localhost`, or a Wails webview. A plain browser
 * pointed at the server over `http://<lan-ip>/` has no `navigator.clipboard` at
 * all, so a direct `navigator.clipboard.writeText(...)` throws immediately.
 * That is exactly why copy buttons work in the Wails window but fail in a
 * browser tab on the LAN.
 *
 * `copyToClipboard` papers over this: it prefers the async API when available
 * and falls back to the legacy `document.execCommand('copy')` path, which works
 * over plain http. Only when BOTH paths are unavailable does it throw — and the
 * thrown Error explains the *actual* cause (insecure origin vs. a genuine
 * browser block) instead of a generic "failed to copy".
 * @module utils/clipboard
 */

/**
 * Build a human-readable explanation for why copying is impossible, naming the
 * real cause so the user can act on it.
 * @returns {string} The failure message.
 */
export function clipboardUnavailableMessage() {
  const loc = typeof window !== 'undefined' ? window.location : undefined;
  const host = (loc && loc.host) || 'this page';
  const insecure = typeof window !== 'undefined'
        && window.isSecureContext === false
        && !!loc
        && loc.protocol === 'http:';
  if (insecure) {
    return `Couldn't copy: browsers only allow clipboard access on secure (https://) pages, `
            + `localhost, or the Juggler desktop app — and this page is served over plain http `
            + `(${host}). Open Juggler in the desktop app, or browse over https/localhost, to copy.`;
  }
  return `Couldn't copy: this browser blocked clipboard access. Make sure the page has focus and `
        + `that clipboard permissions aren't denied for ${host}.`;
}

/**
 * Legacy copy path for insecure contexts: stage the text in an off-screen,
 * read-only <textarea>, select it, and ask the document to copy the selection.
 * Restores the previous focus afterwards. Returns true only when the browser
 * reports the copy succeeded.
 * @param {string} text - Text to copy.
 * @returns {boolean} True on a confirmed copy.
 */
function legacyCopy(text) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Keep it out of view and inert so it never disturbs scroll/layout.
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;

  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { ta.setSelectionRange(0, text.length); } catch { /* some browsers reject on long values */ }

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  ta.remove();
  if (prevFocus && typeof prevFocus.focus === 'function') {
    try { prevFocus.focus(); } catch { /* element may have detached */ }
  }
  return ok;
}

/**
 * Copy `text` to the clipboard, working in secure and insecure contexts alike.
 * Resolves on success; rejects with a descriptive Error (see
 * {@link clipboardUnavailableMessage}) when no path succeeds.
 * @param {string} text - Text to copy.
 * @returns {Promise<void>} Resolves once the text is on the clipboard.
 */
export async function copyToClipboard(text) {
  const str = (text === null || text === undefined) ? '' : String(text);

  // Preferred path: async Clipboard API (secure contexts only). It can still
  // reject in a secure context (lost focus, denied permission) — fall through
  // to the legacy path rather than surfacing that as a hard failure.
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(str);
      return;
    } catch {
      /* fall through to legacy path */
    }
  }

  if (legacyCopy(str)) return;

  throw new Error(clipboardUnavailableMessage());
}

/**
 * Read text from the clipboard, returning '' when unavailable or blocked.
 * Reading has no legacy fallback (`execCommand('paste')` is unsupported in
 * essentially every modern browser), so in an insecure context this resolves to
 * '' rather than throwing — callers treat that as "nothing to paste".
 * @returns {Promise<string>} Clipboard text, or '' when unavailable.
 */
export async function readFromClipboard() {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip && typeof clip.readText === 'function') {
    try {
      return await clip.readText();
    } catch {
      return '';
    }
  }
  return '';
}
