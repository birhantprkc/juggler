//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot stylesheet injection, shared by every module that ships its own CSS.
 *
 * The DOM check is part of the contract, not a caller's precaution: the same
 * modules are imported by engine workers for tool execution, where there is no
 * `document` and "make sure this CSS is present" is vacuous. That is why this
 * module is DOM-free at import time and is re-exported unchanged by both the
 * browser and worker `juggler/ui` facades.
 */

/**
 * Add a `<style>` element carrying `css` to `<head>`, once per `id`.
 *
 * A no-op off the main thread, and a no-op on every call after the first for a
 * given `id` — so a module can call it at import time and a component can call
 * it from `connectedCallback` without either having to know about the other.
 * @param {string} id - Element id identifying this stylesheet; must be unique.
 * @param {string} css - The stylesheet text.
 * @returns {void}
 */
export function injectStylesOnce(id, css) {
  if (typeof document === 'undefined') return;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
