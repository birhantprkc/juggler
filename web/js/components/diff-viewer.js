//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { computeDiff } from '../lib/diff-utils.js';
import { escapeHtml } from '../../sdk/lib/html.js';
import { registerContextMenuProvider } from '../services/context-menu-service.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';

/** @typedef {import('../lib/diff-types.js').DiffHunk} DiffHunk */
/** @typedef {import('../lib/diff-types.js').DiffLine} DiffLine */

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

  /** @private */
  render() {
    // compute hunks via shared util; cast to any to satisfy checkJs where needed
    const hunks = /** @type {any} */ (computeDiff(this.oldContent, this.newContent, this.startLineNumber));

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
   * Render a line, applying character highlights if present
   * @param {DiffLine} line
   * @returns {string} HTML string of the line with character changes highlighted.
   * @private
   */
  renderLineWithCharChanges(line) {
    if (!line.charChanges || line.charChanges.length === 0) return escapeHtml(line.content);

    let html = '';
    let pos = 0;
    const changes = [...line.charChanges].sort((a, b) => a.start - b.start);
    for (const change of changes) {
      if (change.start > pos) html += escapeHtml(line.content.substring(pos, change.start));
      const changedText = line.content.substring(change.start, change.start + change.length);
      html += `<mark class="char-${change.type}">${escapeHtml(changedText)}</mark>`;
      pos = change.start + change.length;
    }
    if (pos < line.content.length) html += escapeHtml(line.content.substring(pos));
    return html;
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
