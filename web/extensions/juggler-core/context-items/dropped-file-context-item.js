//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatFileContentForLLM, createFileContentBlock, injectFileContentStyles } from 'juggler/item-utils';
import { createElement, addFilePath } from 'juggler/ui';

injectFileContentStyles();

/**
 * Persisted Yjs shape for a dropped text file.
 * @typedef {object} DroppedFileData
 * @property {string} filename - Display name captured from the drop (File.name)
 * @property {string} content - Full text captured at drop time (the snapshot)
 */

// ============================================================================
// DroppedFileContextItem
// ============================================================================

/**
 * DroppedFileContextItem - inline snapshot of a text file dropped into the
 * composer.
 *
 * SEMANTICS (contrast with {@link FileContentContextItem}):
 *  - A browser file drop delivers the file's BYTES, never a filesystem path
 *    (WebKit does not populate a usable `File.path`, and a path would be
 *    meaningless for a remote viewer whose file lives on a different machine).
 *    So unlike a path-pin, there is nothing on disk to re-read: the captured
 *    `content` IS the source of truth and is persisted in Yjs verbatim.
 *  - The snapshot is FROZEN — it never re-reads and has no refresh affordance,
 *    matching what the user dropped at that moment.
 *  - Created only via the composer's drop handler
 *    (`executeContextItem('dropped-file', {filename, content})`); it is not
 *    user-addable through the picker and exposes no tool for the LLM.
 * @class
 * @augments ContextItem
 */
class DroppedFileContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'dropped-file',
    name: 'Dropped File',
    version: '1.0.0',
    description: 'Text file dropped into the composer (inline content snapshot)',
    author: 'Juggler Team',
    idPrefix: 'DROP',
    userAddable: false,
    watchesFileChanges: false,
    // 'prefix': the drop is a frozen byte snapshot (never re-read), so place it
    // in the leading, cached prefix instead of re-billing it at the tail every
    // turn — same rationale as the pinned FileContentContextItem.
    contextPosition: /** @type {const} */ ('prefix'),
    exampleData: {
      filename: 'notes.txt',
      content: 'hello world\n'
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-document' };
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // The snapshot lives entirely in `data`: filename + captured bytes.
    /** @type {DroppedFileData} */
    const defaults = { filename: '', content: '' };
    this.data = { ...defaults, ...this.data };
  }

  /**
   * Record the dropped file's snapshot. No disk access — the content arrives
   * inline from the drop handler and is stored as-is.
   * @param {string} _toolName - Unused (no LLM-facing tool)
   * @param {Record<string, any>} params - `{filename, content}`
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (typeof params.content !== 'string') {
      throw new Error('Missing required parameter: content');
    }
    this.data.content = params.content;
    this.data.filename = typeof params.filename === 'string' && params.filename
      ? params.filename
      : 'dropped file';
  }

  /**
   * Status UI configuration. Sync — just the filename.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status UI config
   */
  getStatusUI() {
    const name = this.data.filename || 'Dropped File';
    return { typeName: 'Dropped File', summary: name, status: 'success' };
  }

  /** @returns {string} Item title */
  getTitle() {
    return this.data.filename || 'Dropped File';
  }

  /** @returns {string} Brief summary for transaction display */
  getBriefSummary() {
    return this.data.filename ? `Dropped file: ${this.data.filename}` : 'Dropped file';
  }

  /**
   * Create context text for the LLM.
   *
   * Emits the same `<file>`-wrapped, line-numbered form as an `@`-mention or a
   * `read` tool call, so the model sees a dropped file identically to any other
   * file reference. The filename is used only as the tag label.
   * @returns {Promise<string>} Formatted file content for LLM context
   */
  async createContextText() {
    const content = this.data.content || '';
    if (!content) return '';
    const lineCount = content.split('\n').length;
    return formatFileContentForLLM({
      content,
      path: this.data.filename || 'dropped file',
      lineOffset: 1,
      lineCount,
      totalLines: lineCount
    });
  }

  /**
   * Properties panel: filename header plus the frozen snapshot content.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'file-content-expanded');

    if (this.id) {
      container.dataset.contextItemId = this.id;
    }

    const content = this.data.content || '';
    const lineCount = content ? content.split('\n').length : 0;
    const info = lineCount ? `${lineCount} lines` : undefined;
    addFilePath(container, this.data.filename || 'Dropped file', info);

    if (!content) {
      container.appendChild(createElement('div', 'file-content-loading', '(empty)'));
      return container;
    }

    container.appendChild(createFileContentBlock({
      content,
      language: this._languageFromFilename(this.data.filename || ''),
      lineNumberStart: 1
    }));
    return container;
  }

  /**
   * Best-effort language identifier from a filename extension (used only for
   * properties-panel syntax highlighting; the LLM form is plain).
   * @param {string} filename
   * @returns {string} Language identifier, or 'text'
   * @private
   */
  _languageFromFilename(filename) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    /** @type {Record<string, string>} */
    const langMap = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
      cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin',
      sh: 'bash', bash: 'bash', zsh: 'bash',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
      xml: 'xml', html: 'html', css: 'css', scss: 'scss',
      md: 'markdown', sql: 'sql'
    };
    return langMap[ext] || 'text';
  }
}

export default DroppedFileContextItem;
