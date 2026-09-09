//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { createElement, injectStylesOnce } from 'juggler/ui';
import { setText } from './reconcile.js';

injectStylesOnce('line-diffstat-styles', `
.line-diffstat {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}
.line-diffstat__added {
  color: var(--diff-added-text);
}
.line-diffstat__removed {
  color: var(--error-color, var(--text-secondary));
}
`);

/**
 * The standard compact line tally used beside a file or collection of files.
 * Callers decide whether an absent or +0/-0 stat says anything worth drawing.
 * @param {number} added - Lines added.
 * @param {number} removed - Lines removed.
 * @returns {HTMLElement} The diffstat.
 */
export function createLineDiffstat(added, removed) {
  const stat = createElement('span', 'line-diffstat');
  stat.appendChild(createElement('span', 'line-diffstat__added'));
  stat.appendChild(document.createTextNode(' '));
  stat.appendChild(createElement('span', 'line-diffstat__removed'));
  fillLineDiffstat(stat, added, removed);
  return stat;
}

/**
 * Update an existing line tally without replacing it.
 * @param {HTMLElement} stat - A line diffstat made by createLineDiffstat.
 * @param {number} added - Lines added.
 * @param {number} removed - Lines removed.
 * @returns {void}
 */
export function fillLineDiffstat(stat, added, removed) {
  setText(/** @type {HTMLElement} */ (stat.querySelector('.line-diffstat__added')), `+${added}`);
  setText(/** @type {HTMLElement} */ (stat.querySelector('.line-diffstat__removed')), `-${removed}`);
}
