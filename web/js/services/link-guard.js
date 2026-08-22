//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Link guard — the app's safety net for anchors in rendered markdown.
 *
 * Markdown-rendered content (LLM and message output) emits bare <a href>
 * anchors at many render sites. A native WebView swallows target=_blank and
 * has no new tab or window to put a modified click in, so every click it does
 * not handle becomes a same-window navigation: the app is replaced by whatever
 * the link pointed at, with no chrome to come back from. One delegated handler
 * claims them all — external links go to the system browser via the loopback
 * opener (falling through to a new tab in a plain browser), and same-origin
 * links to on-disk project files go to the OS default handler.
 * @module services/link-guard
 */

import { openExternalURL, externalURLFromHref, localFilePathFromHref } from '../../sdk/lib/window-control.js';
import { osOpenPath } from './ops-api.js';

/**
 * Resolve an activated anchor and act on it, or leave the event alone.
 * @param {MouseEvent} e - The click or auxclick event.
 */
function handleLinkActivation(e) {
  if (e.defaultPrevented) return;
  const target = /** @type {HTMLElement} */ (e.target);
  const anchor = /** @type {HTMLAnchorElement|null} */ (target.closest?.('a[href]'));
  if (!anchor || anchor.hasAttribute('download')) return;
  const rawHref = anchor.getAttribute('href') || '';
  const external = externalURLFromHref(rawHref, anchor.href);
  if (external) {
    e.preventDefault();
    openExternalURL(external);
    return;
  }
  // A same-origin link to an on-disk project file (markdown output routinely
  // emits these, e.g. a report link). Navigating there 404s and tears the app
  // off its page with no way back — open it with the OS default handler
  // instead (the 'os' op resolves it against the project dir, server-side).
  const filePath = localFilePathFromHref(rawHref, anchor.href);
  if (filePath) {
    e.preventDefault();
    void osOpenPath({ path: filePath }).catch(() => {});
  }
}

/**
 * Install the guard on a document.
 *
 * Runs in the bubble phase: explicit per-element handlers (settings, modals)
 * call preventDefault first, so defaultPrevented skips them here — no
 * double-open. Anything between the anchor and the document that stops
 * propagation defeats the guard, so handlers on the way up must let clicks on
 * anchors through.
 * @param {Document} [doc] - Document to guard (defaults to the current one).
 * @returns {() => void} Removes the guard again.
 */
export function installLinkGuard(doc = document) {
  /** @param {Event} e */
  const onClick = (e) => {
    const me = /** @type {MouseEvent} */ (e);
    if (me.button !== 0) return;
    handleLinkActivation(me);
  };
  // Middle click never fires `click`; without this it navigates the window.
  /** @param {Event} e */
  const onAuxClick = (e) => {
    const me = /** @type {MouseEvent} */ (e);
    if (me.button !== 1) return;
    handleLinkActivation(me);
  };
  doc.addEventListener('click', onClick);
  doc.addEventListener('auxclick', onAuxClick);
  return () => {
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('auxclick', onAuxClick);
  };
}
