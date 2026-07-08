//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { openExternalURL } from '../../sdk/lib/window-control.js';

/**
 * Route anchor clicks to the system browser. A native window swallows a bare
 * target=_blank, so every external link in the app hands its href to the
 * loopback opener instead (browser tabs fall back to a normal new tab).
 * Pass a single anchor to wire just that element, or a container root to wire
 * every matching descendant anchor (default: absolute http(s) links).
 * @param {Element} target - An anchor to wire, or a root to search under.
 * @param {string} [selector] - Descendant selector used when target is a root.
 */
export function wireExternalLinks(target, selector = 'a[href^="http"]') {
  const anchors = target.nodeName === 'A'
    ? [/** @type {HTMLAnchorElement} */ (target)]
    : /** @type {NodeListOf<HTMLAnchorElement>} */ (target.querySelectorAll(selector));
  anchors.forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openExternalURL(a.href);
    });
  });
}
