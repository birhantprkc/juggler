//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { computeDiff } from '../lib/diff-utils.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { highlightCodeLines } from '../../sdk/lib/syntax-highlight.js';
import { languageForPath } from '../../sdk/lib/languages.js';
import { registerContextMenuProvider } from '../services/context-menu-service.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';

/** @typedef {import('../lib/diff-types.js').DiffHunk} DiffHunk */
/** @typedef {import('../lib/diff-types.js').DiffLine} DiffLine */
/** @typedef {{source: string[], markup: string[]}} DiffSide */

/**
 * Largest side of a diff that is syntax-highlighted. Both sides are tokenised
 * whole so a hunk sees the file around it, which is linear but not free; past
 * this the diff stays plain rather than stalling the panel it renders into.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

/**
 * DiffViewer - Display file diffs in inline view
 * @class
 * @augments HTMLElement
 */
class DiffViewer extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.oldContent = '';
    /** @type {string} @private */
    this.newContent = '';
    /** @type {string} @private */
    this.filePath = '';
    /** @type {number} @private */
    this.startLineNumber = 1;
    /** @type {{old: DiffSide, new: DiffSide}|null} @private */
    this.highlighted = null;
  }

  connectedCallback() {
    // wait for setDiff to be called
  }

  /**
   * Set diff data and render
   * @param {string} oldContent
   * @param {string} newContent
   * @param {string} filePath
   * @param {number} [startLineNumber=1]
   */
  setDiff(oldContent, newContent, filePath, startLineNumber = 1) {
    this.oldContent = oldContent || '';
    this.newContent = newContent || '';
    this.filePath = filePath || '';
    this.startLineNumber = startLineNumber;
    this.render();
  }

  /**
   * Tokenise both sides of the diff, once, into per-line markup.
   *
   * Highlighting the whole of each side rather than the visible hunks is
   * deliberate: a hunk is a window into the middle of a file, and a line taken
   * on its own tokenises wrong — the inside of a block comment reads as code.
   * The arrays are indexed by `lineNum - startLineNumber`, the numbering
   * `computeDiff` derives from splitting these same two strings; the source
   * lines are kept beside the markup so a line is only ever coloured when the
   * text at that index is provably the line being rendered.
   * @returns {{old: DiffSide, new: DiffSide}|null} Per-line markup, or null when
   *   the diff is left plain (unknown file type, or too large to be worth it).
   * @private
   */
  highlightSides() {
    const language = languageForPath(this.filePath);
    if (language === 'text') return null;
    if (this.oldContent.length > MAX_HIGHLIGHT_CHARS) return null;
    if (this.newContent.length > MAX_HIGHLIGHT_CHARS) return null;
    return {
      old: { source: this.oldContent.split('\n'), markup: highlightCodeLines(this.oldContent, language) },
      new: { source: this.newContent.split('\n'), markup: highlightCodeLines(this.newContent, language) },
    };
  }

  /** @private */
  render() {
    // compute hunks via shared util; cast to any to satisfy checkJs where needed
    const hunks = /** @type {any} */ (computeDiff(this.oldContent, this.newContent, this.startLineNumber));
    this.highlighted = this.highlightSides();

    this.innerHTML = `
      <diff-content>
        <diff-header>
          ${escapeHtml(this.filePath || 'File diff')}
        </diff-header>
        <diff-inline-view>
          ${this.renderInlineView(hunks)}
        </diff-inline-view>
        <diff-stats>
          <span class="add-count">+${this.countAdded(hunks)}</span>
          <span class="remove-count">-${this.countRemoved(hunks)}</span>
        </diff-stats>
      </diff-content>
    `;
  }

  /**
   * Render inline view (unified diff)
   * @param {DiffHunk[]} hunks
   * @returns {string} HTML string representing the inline diff view.
   * @private
   */
  renderInlineView(hunks) {
    if (!hunks || hunks.length === 0) return '<diff-no-changes>No changes</diff-no-changes>';

    let html = '';
    for (const hunk of hunks) {
      html += '<diff-hunk>';
      html += `<diff-hunk-header>@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@</diff-hunk-header>`;

      for (const line of hunk.lines) {
        const lineClass = line.type === 'equal' ? 'equal' : (line.type === 'remove' ? 'remove' : 'add');
        const lineNum = line.type === 'remove' ? line.oldLineNum : (line.type === 'add' ? line.newLineNum : line.oldLineNum);
        const prefix = line.type === 'remove' ? '-' : (line.type === 'add' ? '+' : ' ');

        html += `<div class="diff-line ${lineClass}">`;
        html += `<span class="line-num">${lineNum || ''}</span>`;
        html += `<span class="line-prefix">${prefix}</span>`;
        html += `<span class="line-content">${this.renderLineWithCharChanges(line)}</span>`;
        html += `</div>`;
      }

      html += '</diff-hunk>';
    }
    return html;
  }

  /**
   * The syntax-highlighted markup for a line, or its escaped text when the diff
   * is not being highlighted.
   * @param {DiffLine} line
   * @returns {string} Safe HTML for the line's content.
   * @private
   */
  lineMarkup(line) {
    const sides = this.highlighted;
    if (sides) {
      const side = line.type === 'add' ? sides.new : sides.old;
      const number = line.type === 'add' ? line.newLineNum : line.oldLineNum;
      const index = (number ?? 0) - this.startLineNumber;
      // Only take the tokenised line when the text at that index is the line in
      // hand: an index that has drifted would show the wrong line's content and
      // look like a diff bug rather than a highlighting one.
      if (side.source[index] === line.content) return side.markup[index] ?? escapeHtml(line.content);
    }
    return escapeHtml(line.content);
  }

  /**
   * Render a line, applying character highlights if present.
   *
   * The character ranges and the syntax tokens are two layers over the same
   * text, so the marks go onto the *rendered* line rather than being spliced
   * into the source: the line is parsed, its text nodes are walked to find the
   * range, and only that run is wrapped. A range straddling a token boundary
   * therefore yields one `<mark>` per token instead of breaking either layer.
   * @param {DiffLine} line
   * @returns {string} HTML string of the line with character changes highlighted.
   * @private
   */
  renderLineWithCharChanges(line) {
    const html = this.lineMarkup(line);
    const changes = line.charChanges;
    if (!changes || changes.length === 0) return html;

    const template = document.createElement('template');
    template.innerHTML = html;

    /** @type {{node: Text, start: number}[]} */
    const nodes = [];
    let offset = 0;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = /** @type {Text} */ (walker.currentNode);
      nodes.push({ node, start: offset });
      offset += node.data.length;
    }

    for (const { node, start } of nodes) {
      const end = start + node.data.length;
      // Clipped to this text node, then applied right to left: splitting keeps
      // the head in `node`, so every range still to come stays addressable.
      const ranges = changes
        .map((change) => ({
          from: Math.max(change.start, start) - start,
          to: Math.min(change.start + change.length, end) - start,
          type: change.type,
        }))
        .filter((range) => range.to > range.from)
        .sort((a, b) => b.from - a.from);

      for (const range of ranges) {
        node.splitText(range.to);
        const changed = node.splitText(range.from);
        const mark = document.createElement('mark');
        mark.className = `char-${range.type}`;
        changed.parentNode?.insertBefore(mark, changed);
        mark.appendChild(changed);
      }
    }

    return template.innerHTML;
  }

  /**
   * Count added lines
   * @param {DiffHunk[]} hunks
   * @returns {number} The total count of added lines.
   * @private
   */
  countAdded(hunks) {
    let count = 0;
    for (const hunk of hunks || []) for (const line of hunk.lines) if (line.type === 'add') count++;
    return count;
  }

  /**
   * Count removed lines
   * @param {DiffHunk[]} hunks
   * @returns {number} The total count of removed lines.
   * @private
   */
  countRemoved(hunks) {
    let count = 0;
    for (const hunk of hunks || []) for (const line of hunk.lines) if (line.type === 'remove') count++;
    return count;
  }

}

customElements.define('diff-viewer', DiffViewer);

// Right-click menu for diffs: copy the changed file's path and its new content.
// Reads the DiffViewer instance's own fields (set via setDiff).
registerContextMenuProvider({
  match: (start) => start?.closest('diff-viewer') || null,
  build: (subject) => {
    const diffViewer = /** @type {any} */ (subject);
    const filePath = diffViewer.filePath || '';
    const newContent = diffViewer.newContent || '';
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [{
      label: 'Copy file path',
      disabled: !filePath,
      onClick: () => { void copyToClipboard(filePath).catch(() => {}); },
    }, {
      label: 'Copy new content',
      disabled: !newContent,
      onClick: () => { void copyToClipboard(newContent).catch(() => {}); },
    }];
    return items;
  },
});

export default DiffViewer;
