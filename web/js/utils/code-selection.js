//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Turning a selection over rendered code into a reference to lines in a file.
 *
 * Line-numbered code is rendered as one `.ci-line` per line, each carrying its
 * own `data-line` (see {@link module:sdk/lib/code-lines}). Those numbers are the
 * only trustworthy source: counting characters or offsets into the rendered text
 * breaks on wrapping, on windowed rendering, and on every element boundary
 * syntax highlighting introduces mid-line.
 *
 * Not every file is shown that way. Markdown is rendered as formatted prose
 * (see {@link module:sdk/lib/context-item-utils.createFileContentBlock}), which
 * has no rows to count — so a selection there resolves to the file and the text,
 * with no line numbers. Naming the file is most of the value, and a line number
 * inferred from prose would be a guess dressed as a citation.
 *
 * A surface opts in by marking the element around its content with
 * `data-code-ref-path`, holding the path a reference should print, plus
 * `data-code-ref-absolute` when that path is outside the project. Content with no
 * such host yields nothing — better than guessing at which file the reader meant.
 * @module utils/code-selection
 */

/** Attribute naming the path a reference over this code should print. */
export const CODE_REF_PATH_ATTR = 'data-code-ref-path';

/** Attribute marking that path as out of the project root, to print as-is. */
export const CODE_REF_ABSOLUTE_ATTR = 'data-code-ref-absolute';

/**
 * Whether a path is absolute, in either platform's spelling — a POSIX root, a
 * Windows drive, or a UNC share. A surface that has only the path the producer
 * gave it uses this to decide whether it is naming a file outside the project:
 * anything under the root would have been spelled relative to it.
 * @param {string} path - The path to test.
 * @returns {boolean} True when the path is absolute.
 */
export function isAbsolutePath(path) {
  if (!path) return false;
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
}

/**
 * What a selection over rendered code refers to.
 * @typedef {object} CodeSelection
 * @property {string} path - The path to print, in the host's spelling.
 * @property {boolean} outOfRoot - True when that path is outside the project.
 * @property {number} [startLine] - First selected line, 1-indexed and inclusive. Absent over prose.
 * @property {number} [endLine] - Last selected line, inclusive. Absent over prose.
 * @property {string[]} lines - Over code, the whole of each selected line; over prose, the selected text.
 */

/**
 * Resolve a live selection to the lines it covers, or null when it is not a
 * selection of code a reference can be written for.
 * @param {Selection|null} [selection] - The document's selection.
 * @returns {CodeSelection|null} The reference, or null.
 */
export function resolveCodeSelection(selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);

  const host = hostOf(range.startContainer);
  const path = host?.getAttribute(CODE_REF_PATH_ATTR) || '';
  // A selection running out of the code and into whatever surrounds it is not a
  // selection of this file, and half of it would be a reference to the wrong
  // lines rather than to fewer of them.
  if (!host || !path || !host.contains(range.endContainer)) return null;

  const rows = /** @type {HTMLElement[]} */ (
    Array.from(host.querySelectorAll(`.ci-line[data-line]`)));
  if (rows.length === 0) return proseSelection(host, path, range);

  let first = indexOfRow(rows, range.startContainer);
  let last = indexOfRow(rows, range.endContainer);
  // An endpoint outside any row — in the padding above or below the code, say —
  // still has rows between it and the other end.
  if (first < 0) first = rows.findIndex((row) => range.intersectsNode(row));
  if (last < 0) last = lastIndexWhere(rows, (row) => range.intersectsNode(row));
  if (first < 0 || last < 0 || last < first) return null;

  // Dragging as far as the start of a row is not a selection of that row, and a
  // reference naming a line the user never highlighted is a reference to the
  // wrong code. Only the endpoints are trimmed: an empty line in the middle of a
  // span contributes no text either, and is genuinely selected.
  if (last > first && contributesNothing(range, rows[last])) last--;
  if (first < last && contributesNothing(range, rows[first])) first++;

  const chosen = rows.slice(first, last + 1);
  const head = chosen[0];
  const tail = chosen[chosen.length - 1];
  if (!head || !tail) return null;

  return {
    path,
    outOfRoot: host.hasAttribute(CODE_REF_ABSOLUTE_ATTR),
    startLine: Number(head.dataset.line),
    endLine: Number(tail.dataset.line),
    lines: chosen.map((row) => row.textContent || ''),
  };
}

/**
 * A reference to content rendered without line rows — markdown shown as prose.
 * The selected text stands in for the quoted rows, since there are no rows to
 * widen it to, and the reference carries no line numbers at all.
 * @param {Element} host - The element advertising the path.
 * @param {string} path - The path to print.
 * @param {Range} range - The selection's range.
 * @returns {CodeSelection|null} The reference, or null when nothing was selected.
 * @private
 */
function proseSelection(host, path, range) {
  return proseReference(path, host.hasAttribute(CODE_REF_ABSOLUTE_ATTR), range.toString());
}

/**
 * A line-less reference to a path, quoting text the caller already has. For
 * surfaces that know which file they show but do not render it as numbered rows
 * — a `<code-block>` in a message, a diff, markdown shown as prose.
 * @param {string} path - The path to print.
 * @param {boolean} outOfRoot - Whether that path is outside the project.
 * @param {string} text - The selected text.
 * @returns {CodeSelection|null} The reference, or null when the text is empty.
 */
export function proseReference(path, outOfRoot, text) {
  // Trailing blank lines come from a selection dragged past the end of a
  // paragraph, and would quote emptiness the reader never highlighted.
  const lines = (text || '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (!path || lines.length === 0) return null;

  return { path, outOfRoot, lines };
}

/**
 * Whether the selection stops at one of this row's edges without covering any
 * of it — true only for a row holding an endpoint, so an empty line in the
 * middle of a span is never mistaken for one.
 * @param {Range} range - The selection's range.
 * @param {HTMLElement} [row] - The row at one end of the span.
 * @returns {boolean} True when the row is outside what was really selected.
 * @private
 */
function contributesNothing(range, row) {
  if (!row) return false;
  const holdsEndpoint = row === rowOf(range.startContainer) || row === rowOf(range.endContainer);
  return holdsEndpoint && selectedTextWithin(range, row) === '';
}

/**
 * The nearest element at or above a node.
 * @param {globalThis.Node|null} node - Any node.
 * @returns {Element|null} The element, or null.
 * @private
 */
function elementOf(node) {
  if (!node) return null;
  return node.nodeType === 1
    ? /** @type {Element} */ (node)
    : node.parentElement;
}

/**
 * The code host a node sits inside, if any.
 * @param {globalThis.Node|null} node - Any node.
 * @returns {Element|null} The host, or null.
 * @private
 */
function hostOf(node) {
  return elementOf(node)?.closest(`[${CODE_REF_PATH_ATTR}]`) || null;
}

/**
 * The rendered line a node sits inside, if any.
 * @param {globalThis.Node|null} node - Any node.
 * @returns {Element|null} The `.ci-line`, or null.
 * @private
 */
function rowOf(node) {
  return elementOf(node)?.closest('.ci-line[data-line]') || null;
}

/**
 * Where a node's line sits in the rendered rows.
 * @param {HTMLElement[]} rows - The rendered lines.
 * @param {globalThis.Node} node - A node inside one of them.
 * @returns {number} The index, or -1.
 * @private
 */
function indexOfRow(rows, node) {
  const row = rowOf(node);
  return row ? rows.indexOf(/** @type {HTMLElement} */ (row)) : -1;
}

/**
 * The last index satisfying a predicate, or -1.
 * @param {HTMLElement[]} rows - The rendered lines.
 * @param {(row: HTMLElement) => boolean} predicate - The test.
 * @returns {number} The index, or -1.
 * @private
 */
function lastIndexWhere(rows, predicate) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && predicate(row)) return i;
  }
  return -1;
}

/**
 * How much of one row the selection actually covers.
 * @param {Range} range - The selection's range.
 * @param {HTMLElement} row - One rendered line.
 * @returns {string} The selected text within that row.
 * @private
 */
function selectedTextWithin(range, row) {
  const clip = document.createRange();
  clip.selectNodeContents(row);
  // Each endpoint only moves when it lies inside this row; otherwise the row is
  // wholly on that side of it, and the row's own boundary is the right clip.
  if (row.contains(range.startContainer)) clip.setStart(range.startContainer, range.startOffset);
  if (row.contains(range.endContainer)) clip.setEnd(range.endContainer, range.endOffset);
  return clip.toString();
}
