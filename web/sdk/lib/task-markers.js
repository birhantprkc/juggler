//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The task-list marker vocabulary: the one place that decides which character
 * denotes which state.
 *
 * Two sides depend on it and must not drift — the markdown renderer, which
 * reads a marker and draws a box for it, and the context items (plan, todo),
 * which write the marker in the first place.
 *
 * It lives apart from `markdown.js` and holds nothing DOM-shaped so the
 * worker-side `juggler/ui` facade can re-export it for real rather than as a
 * throwing stub: a context item composes its LLM text inside the engine worker,
 * where importing `markdown.js` would drag DOM modules in at import time.
 */

/**
 * Marker character → the state it denotes.
 *
 * GFM specifies only `[ ]` and `[x]`. The rest follow the Obsidian Tasks
 * vocabulary, the only convention for the missing states with an installed base
 * behind it: `/` is its built-in IN_PROGRESS and `-` its built-in CANCELLED,
 * which is what a skipped step is. `!` is ours — no markdown ecosystem
 * distinguishes a step that failed from one that was cancelled, so there was
 * nothing to follow. `X` is accepted because GFM treats it as checked; we only
 * ever write `x`.
 * @type {Map<string, string>}
 */
export const TASK_STATES = new Map([
  [' ', 'pending'],
  ['/', 'in-progress'],
  ['x', 'completed'],
  ['X', 'completed'],
  ['!', 'failed'],
  ['-', 'skipped'],
]);

/**
 * Accessible name per state. Once a rendered list drops its status words the
 * box is the only thing carrying the state, so it has to say so out loud.
 * @type {Record<string, string>}
 */
export const TASK_LABELS = {
  'pending': 'To do',
  'in-progress': 'In progress',
  'completed': 'Completed',
  'failed': 'Failed',
  'skipped': 'Skipped',
};

/**
 * A leading marker on a list item. Kept beside {@link TASK_STATES} so the two
 * cannot drift; `-` sits last in the character class so it stays literal.
 * @type {RegExp}
 */
export const TASK_MARKER_RE = /^\[([ xX/!-])\]\s+/;

/**
 * Item status → marker. Both spellings of the running state are accepted: item
 * data says `in_progress`, the rendered class vocabulary says `in-progress`.
 * @type {Record<string, string>}
 */
const STATUS_MARKERS = {
  'pending': '[ ]',
  'in_progress': '[/]',
  'in-progress': '[/]',
  'completed': '[x]',
  'failed': '[!]',
  'skipped': '[-]',
};

/**
 * The marker to write for an item status, defaulting to unstarted for anything
 * unrecognised — a plan step with a bad status still renders as a step.
 * @param {string} status - Item status, e.g. 'in_progress'
 * @returns {string} The marker, e.g. '[/]'
 */
export function taskMarker(status) {
  return STATUS_MARKERS[String(status)] || '[ ]';
}

/**
 * The same states in words, for the renderings the model reads.
 *
 * The viewer draws a distinct box per marker, so repeating the state in text
 * there would say twice what the box says once. The model has no box and no
 * learned meaning for `[/]` — every agent harness models task status as a JSON
 * enum, so nothing in its training attaches a state to that character.
 * @type {Record<string, string>}
 */
const STATUS_WORDS = {
  'in_progress': 'in progress',
  'in-progress': 'in progress',
  'failed': 'failed',
  'skipped': 'skipped',
};

/**
 * The status in words, or '' for a state the box alone conveys well enough
 * (an unstarted or completed item needs no gloss).
 * @param {string} status - Item status, e.g. 'in_progress'
 * @returns {string} The words, e.g. 'in progress', or '' when there are none
 */
export function taskStatusWord(status) {
  return STATUS_WORDS[String(status)] || '';
}
