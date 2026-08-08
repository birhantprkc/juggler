//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { readFile, getTree, stat } from 'juggler/ops';
import { formatDisplayPath, formatFileSize, formatFileContentForLLM, createFileContentBlock, injectFileContentStyles, basename } from 'juggler/item-utils';
import { createElement } from 'juggler/ui';
import { addFilePath } from 'juggler/ui';
import { buildPickerPanel } from 'juggler/ui';
import { smartTruncate } from 'juggler/ui';
import { gitignoreDisabled } from './path-approval.js';

/**
 * Safety ceiling (characters) on the file body a single pinned/@-mentioned file
 * contributes to the request. A pin is deliberate, so this is far more generous
 * than the per-`read`-call budget — it never touches a normal pinned file — but
 * a provider rejects any single content field past a hard byte limit (OpenAI:
 * 10 MiB) regardless of the token budget, and that rejection is not a
 * context-overflow the compaction/recovery ladder can resolve. The snapshot is
 * frozen at add-time, so an oversized or minified file (one enormous line slips
 * the per-line cap) would otherwise trip that limit every turn the pin is sent
 * until it is removed. The ceiling stays under the byte limit even for worst-case
 * 4-byte UTF-8, and the truncation is applied to the rendered text itself so the
 * transaction view shows exactly what the model received.
 */
const MAX_PINNED_FILE_CHARS = 2_000_000;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Persisted Yjs shape for a pinned file/directory.
 *
 * Holds the path, a directory marker, and the rendered LLM snapshot frozen at
 * add-time. Persisting `content` is deliberate (like {@link DroppedFileContextItem}):
 * the pin rides `contextPosition:'prefix'`, so a byte-stable snapshot is what lets
 * the prompt cache pay for it once instead of re-reading it every turn. Bounded by
 * `MAX_PINNED_FILE_CHARS`.
 * @typedef {object} FileContentData
 * @property {string} path - File or directory path (trailing "/" for dirs)
 * @property {boolean} [isDirectory] - True when path refers to a directory
 * @property {string} [content] - Rendered LLM content, snapshotted at add-time
 */

injectFileContentStyles();

// ============================================================================
// FileContentContextItem
// ============================================================================

/**
 * FileContentContextItem - User-pinned file reference, frozen at add-time.
 *
 * SEMANTICS (see docs/extension_guide.md §"Pinned file content"):
 *  - The rendered file content is SNAPSHOTTED once, when the pin is created
 *    (`onToolCall`), and persisted in Yjs (`data.content`). Later turns re-use
 *    that frozen snapshot — `createContextText` never re-reads the live file for
 *    LLM context.
 *  - Why freeze: the pin is injected at `contextPosition:'prefix'` (leading
 *    messages, inside the cached prefix). A byte-stable snapshot rides the prompt
 *    cache and is paid for once; the old "resolve live every turn" behavior put
 *    the file at the uncached tail and re-billed its full bytes every single turn
 *    (auto-added CLAUDE.md/AGENTS.md were the worst offenders).
 *  - ACCEPTED TRADEOFF: a pin no longer tracks the file's CURRENT bytes on later
 *    turns. If the file changed and it matters, the agent re-reads it (that is
 *    what the `read` tool is for — those ARE live immutable snapshots; see
 *    `ReadFileContextItem`), or the user re-pins it (one fresh snapshot →
 *    one cache cold-start).
 *  - The properties panel still fetches LIVE for display only (a pin's panel
 *    shows the file's current disk state); only the LLM context is frozen.
 *  - Legacy pins persisted before this change carry no snapshot; `createContextText`
 *    falls back to a live fetch for them (no worse than the old behavior).
 * @class
 * @augments ContextItem
 */
class FileContentContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'file-content',
    name: 'File Content',
    version: '1.0.0',
    description: 'Add file content to context',
    author: 'Juggler Team',
    idPrefix: 'FILE',
    userAddable: true,
    watchesFileChanges: false,
    contextPosition: /** @type {const} */ ('prefix'),
    exampleData: {
      path: 'src/main.go',
      isDirectory: false
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-document' };
  }

  /**
   * Status UI configuration.
   *
   * Sync only — no disk read here (called on every render). Shows just
   * the filename / folder name; per-fetch details (line count, warnings)
   * live in the properties panel, which is async.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status UI config
   */
  getStatusUI() {
    if (!this.data.path) {
      return { typeName: 'File Content', summary: 'No file selected' };
    }
    if (this.data.isDirectory) {
      const displayPath = basename(this.data.path) || this.data.path;
      return { typeName: 'Folder', summary: `${displayPath}/`, status: 'success' };
    }
    const filename = basename(this.data.path) || this.data.path;
    return { typeName: 'File Content', summary: filename, status: 'success' };
  }

  /** @returns {Promise<Record<string,string>|null>} Params for the new item, or null if cancelled */
  static async showAddDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'pp-overlay';
    document.body.appendChild(overlay);

    const { element, promise, cancel } = buildPickerPanel({
      title: 'Add File Content',
      placeholder: 'File path…',
      dirsOnly: false,
      confirmLabel: 'Add',
      showCancel: true,
    });
    overlay.appendChild(element);

    /** @param {KeyboardEvent} e */
    const onKeydown = (e) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });

    const chosen = await promise;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();

    return chosen ? { path: chosen } : null;
  }

  /**
   * Check if new params can be merged with an existing item
   *
   * Files with the same path are deduplicated - reuse existing item.
   * @static
   * @param {Record<string, any>} newParams - Parameters for the new item request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null if no merge possible
   */
  static mergeOrReplace(newParams, existingItems) {
    if (!newParams.path) {
      return null;
    }

    // Normalize path for comparison
    const newPath = newParams.path.replace(/^\/+/, '');

    const existing = existingItems.find(f => {
      const data = /** @type {FileContentData} */ (f.data);
      const existingPath = (data.path || '').replace(/^\/+/, '');
      return existingPath === newPath;
    });

    if (existing) {
      return { action: 'reuse', item: existing };
    }

    return null;
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    /**
     * TTL cache for live fetches. See {@link _fetchLive}.
     * @type {{path: string, ts: number, pending: Promise<FetchResult>|null, result: FetchResult|null}|null}
     * @private
     */
    this._lastFetch = null;

    // Initialize data with defaults. The pin persists only path + a
    // directory marker; actual bytes are resolved via _fetchLive().
    /** @type {FileContentData} */
    const defaults = { path: '', isDirectory: false };
    this.data = { ...defaults, ...this.data };
    FileContentContextItem._stripLegacyFields(this.data);
  }

  /**
   * Restore item from JSON. Strips legacy per-fetch METADATA fields (size,
   * totalLines, …) that the old live-pin design briefly wrote back into `data`;
   * `content` is NOT stripped — it is now the frozen add-time snapshot we persist
   * on purpose (see {@link FileContentData}).
   * @param {import('juggler/context-item').ItemJSON} json
   */
  fromJSON(json) {
    super.fromJSON(json);
    FileContentContextItem._stripLegacyFields(this.data);
  }

  /**
   * Remove legacy per-fetch metadata fields from a data object in place. These
   * were transient render details the old design shouldn't have persisted; the
   * frozen `content` snapshot is deliberately kept.
   * @param {Record<string, unknown>} data - The data object to clean
   * @private
   */
  static _stripLegacyFields(data) {
    const dead = ['language', 'size', 'totalLines', 'lineOffset',
      'lineCount', 'exists', 'warning', 'readMode'];
    for (const k of dead) {
      if (k in data) delete data[k];
    }
  }

  /**
   * Execute tool call - record the pinned path and FREEZE its rendered content.
   *
   * The file/dir is read once, here, and the rendered LLM snapshot is stored in
   * `this.data.content`. Later turns re-use that frozen snapshot (see
   * {@link createContextText}) so a `contextPosition:'prefix'` pin is cached and
   * paid for once, instead of being re-read live and re-billed every turn. The
   * properties panel still fetches live for display.
   * @param {string} _toolName - Tool name (unused, only one tool)
   * @param {Record<string, any>} params - Tool parameters
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (!params.path || typeof params.path !== 'string') {
      throw new Error('Missing required parameter: path');
    }
    this.data.path = params.path;
    const r = await this._fetchLive();
    this.data.isDirectory = r.isDirectory === true;
    this.data.content = this._renderSnapshot(r);
  }

  /**
   * Transient fetch result for a pinned file or directory.
   * Mirrors the legacy FileContentData shape but is NEVER written back to
   * `this.data` — that would mutate the Yjs document across peers on every
   * disk change.
   * @typedef {object} FetchResult
   * @property {string} path - Resolved (possibly absolute) path
   * @property {boolean} isDirectory - True if the path is a directory listing
   * @property {boolean} exists - False if the file/dir could not be read
   * @property {string} content - File body or rendered tree listing
   * @property {string} [language] - Detected language identifier for syntax highlight
   * @property {number} [size] - File size in bytes (files only)
   * @property {number} [totalLines] - Line count for files, entry count for dirs
   * @property {number} [lineOffset] - First line number of `content` (1-indexed)
   * @property {number} [lineCount] - Number of lines actually included in `content`
   * @property {string|null} [warning] - Backend warning (e.g. binary file)
   * @property {string} [readMode] - Human-readable read-mode description
   */

  /**
   * Fetch live file/directory contents.
   *
   * Returns a transient {@link FetchResult}; does NOT touch `this.data`.
   * A 500ms TTL cache is kept in `this._lastFetch` so a send-time read and
   * a properties-panel render in the same tick share one round-trip.
   * Concurrent callers join the same in-flight promise.
   * @returns {Promise<FetchResult>} Live file or directory contents
   * @private
   */
  async _fetchLive() {
    const path = this.data.path || '';
    if (!path) {
      return { path: '', isDirectory: false, exists: false, content: '' };
    }

    const now = Date.now();
    if (this._lastFetch && this._lastFetch.path === path) {
      if (this._lastFetch.pending) return this._lastFetch.pending;
      if (this._lastFetch.result && (now - this._lastFetch.ts) < 500) {
        return this._lastFetch.result;
      }
    }

    const pending = this._doFetch(path);
    this._lastFetch = { path, ts: now, pending, result: null };
    try {
      const result = await pending;
      this._lastFetch = { path, ts: Date.now(), pending: null, result };
      return result;
    } catch (err) {
      this._lastFetch = null;
      throw err;
    }
  }

  /**
   * Underlying single-shot fetch. Always returns a usable FetchResult
   * (errors collapse to `exists:false`); callers should not catch.
   * @param {string} path - File or directory path to load
   * @returns {Promise<FetchResult>} Fetched result; `exists:false` on error
   * @private
   */
  async _doFetch(path) {
    // Completion paths conventionally carry a trailing slash for directories,
    // but a user may type or paste an absolute directory path without one.
    // Probe first in that ambiguous case so folders never reach `readFile`.
    let isDirectory = path.endsWith('/');
    if (!isDirectory) {
      try {
        const metadata = await stat({ path, userInitiated: true });
        isDirectory = metadata.isDirectory === true;
      } catch (err) {
        // Preserve the read operation's existing error/result behavior when
        // metadata is unavailable (for example, a deleted path).
      }
    }

    // A pin is always user-initiated: the user explicitly chose this path via
    // @-mention or the file picker, so it may legitimately point outside the
    // project root (a sibling repo, an absolute path, …). Pass `userInitiated`
    // so the non-approval-gated read/tree ops resolve it WITHOUT the
    // working-directory containment check — for relative `../…` mentions as
    // well as absolute ones. Without it an out-of-root mention fails as "path
    // is outside working directory".
    if (isDirectory) {
      try {
        const treeParams = /** @type {Record<string, unknown>} */ ({ path, depth: 2, maxTokens: 4000, userInitiated: true });
        if (gitignoreDisabled(this)) treeParams.noIgnore = true;
        const r = await getTree(treeParams);
        return {
          path,
          isDirectory: true,
          exists: true,
          content: r.content || '',
          totalLines: (r.fileCount || 0) + (r.dirCount || 0),
          size: 0,
          language: '',
          lineOffset: 1,
          lineCount: 0,
          warning: null,
        };
      } catch (err) {
        console.error(`[FileContentContextItem] Failed to list directory ${path}:`, err);
        return { path, isDirectory: true, exists: false, content: '' };
      }
    }

    try {
      // userInitiated: see the directory branch above. The pin unlocks the
      // out-of-workdir escape hatch in file_ops.loadFile so a file outside the
      // project root resolves instead of collapsing to `exists:false` (which
      // the properties panel renders as a misleading "File not found").
      const r = await readFile({ path, userInitiated: true });
      return {
        path: r.path || path,
        isDirectory: false,
        exists: r.exists !== false,
        content: r.content || '',
        language: r.language || this._getLanguageFromPath(r.path || path),
        size: r.size || 0,
        totalLines: r.totalLines || 0,
        lineOffset: r.lineOffset || 1,
        lineCount: r.lineCount || 0,
        warning: r.warning || null,
      };
    } catch (err) {
      console.error(`[FileContentContextItem] Failed to load ${path}:`, err);
      return { path, isDirectory: false, exists: false, content: '' };
    }
  }

  /**
   * Get the full absolute path by resolving relative paths against the project root
   * @returns {string} Absolute file path, or the raw path if no project root is available
   */
  getAbsolutePath() {
    const p = this.data.path || '';
    if (!p) return '';
    if (p.startsWith('/')) return p;
    const root = this.session?.projectPath;
    if (root) return `${root.replace(/\/+$/, '')}/${p}`;
    return p;
  }

  /**
   * Get human-readable title
   * @returns {string} Item title
   */
  getTitle() {
    if (!this.data.path) {
      return 'File Content';
    }
    if (this.data.isDirectory) {
      return formatDisplayPath(this.data.path.replace(/\/+$/, '')) + '/';
    }
    return formatDisplayPath(this.data.path);
  }

  /**
   * Get brief summary string for transaction display
   * @returns {string} Brief summary
   */
  getBriefSummary() {
    if (!this.data.path) {
      return 'Empty file content';
    }
    if (this.data.isDirectory) {
      return `Directory listing: ${this.data.path}`;
    }
    return formatDisplayPath(this.data.path);
  }

  /**
   * Create properties panel view.
   *
   * The panel always reflects live disk contents — there is no snapshot
   * to be stale against. We render a `Loading…` placeholder synchronously,
   * kick off a `_fetchLive()` (which reuses the 500ms TTL cache from any
   * just-completed send), and swap the result in when it resolves.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'file-content-expanded');

    // Expose item identity + an unpin hook so the file-path right-click menu
    // (see properties-panel-helpers.js) can offer "Remove from context". The
    // closure is local UI wiring, not persisted state — removeContextItem
    // drives the Yjs mutation through the message thread (single owner).
    if (this.id) {
      container.dataset.contextItemId = this.id;
      /** @type {any} */ (container)._jugglerRemoveFromContext = () => {
        /** @type {any} */ (this.messageThread)?.removeContextItem?.(this.id);
      };
    }

    const headerHost = createElement('div', 'file-content-header-host');
    container.appendChild(headerHost);

    const body = createElement('div', 'file-content-body');
    container.appendChild(body);

    addFilePath(headerHost, this.getAbsolutePath() || 'No file');

    if (!this.data.path) {
      body.appendChild(createElement('div', 'file-content-loading', 'No file selected'));
      return container;
    }

    body.appendChild(createElement('div', 'file-content-loading', 'Loading…'));

    this._fetchLive().then(r => {
      // Swap body. Replace the header info with the just-fetched stats.
      headerHost.replaceChildren();
      let info;
      if (r.exists && r.isDirectory && r.totalLines) {
        info = `${r.totalLines} items`;
      } else if (r.exists && r.size) {
        info = `${formatFileSize(r.size)} | ${r.totalLines || 0} lines`;
      }
      addFilePath(headerHost, this.getAbsolutePath() || r.path || 'No file', info);

      body.replaceChildren();

      if (!r.exists) {
        body.appendChild(createElement('div', 'file-content-not-found',
          `File not found: ${r.path || this.data.path}`));
        return;
      }

      if (r.isDirectory) {
        body.appendChild(createElement('pre', 'file-content-tree', r.content || '(empty)'));
        return;
      }

      if (r.warning) {
        body.appendChild(createElement('div', 'file-content-warning', r.warning));
        return;
      }

      body.appendChild(createFileContentBlock({
        content: r.content || '',
        language: r.language || 'text',
        lineNumberStart: r.lineOffset || 1,
      }));
    }).catch(err => {
      console.error('[FileContentContextItem] properties panel fetch failed:', err);
      body.replaceChildren(createElement('div', 'file-content-not-found',
        `Failed to load: ${this.data.path}`));
    });

    return container;
  }

  /**
   * Create context text for the LLM.
   *
   * Returns the snapshot frozen at add-time ({@link onToolCall}) — the pinned
   * file is NOT re-read live for LLM context, so a `prefix`-positioned pin stays
   * byte-stable across turns and rides the prompt cache. A legacy pin persisted
   * before freezing carries no snapshot, so it falls back to a one-off live
   * render (no worse than the old always-live behavior).
   * @param {import('juggler/context-item').ContextParams} _contextParams - Context parameters
   * @returns {Promise<string>} Formatted file content for LLM context
   */
  async createContextText(_contextParams) {
    if (!this.data.path) {
      return '';
    }
    if (typeof this.data.content === 'string' && this.data.content !== '') {
      return this.data.content;
    }
    // Migration backstop: an older pin has no frozen snapshot. Render live once.
    // This does not persist (createContextText is a pure render), so such a pin
    // stays live-rendered until it is re-added; new pins freeze in onToolCall.
    return this._renderSnapshot(await this._fetchLive());
  }

  /**
   * Render a fetched file/directory result into the final LLM context text —
   * the exact bytes stored as the frozen snapshot and sent to the model. Applies
   * the same directory/warning framing and MAX_PINNED_FILE_CHARS truncation the
   * live path used, so freezing changes only WHEN the render happens, not what it
   * produces.
   * @param {FetchResult} r - A fetched file/directory result
   * @returns {string} Formatted file content for LLM context
   * @private
   */
  _renderSnapshot(r) {
    if (!r.exists) {
      return `File does not exist: ${r.path || this.data.path}`;
    }

    if (r.isDirectory) {
      return `Directory listing of ${r.path}:\n${r.content || '(empty)'}`;
    }

    if (r.warning) {
      return `File ${r.path}: ${r.warning}`;
    }

    const formatted = formatFileContentForLLM({
      content: r.content || '',
      path: r.path,
      lineOffset: r.lineOffset || 1,
      lineCount: r.lineCount,
      totalLines: r.totalLines,
      readMode: r.readMode
    });
    // Backstop against a single oversized field tripping the provider's per-field
    // byte cap (see MAX_PINNED_FILE_CHARS). Truncating the rendered text keeps the
    // transaction view and the wire identical.
    const { content: bounded, truncated } = smartTruncate(formatted, { maxChars: MAX_PINNED_FILE_CHARS });
    return truncated
      ? bounded + `\n\n(File content truncated from ${formatted.length} to ${bounded.length} chars to fit the request)`
      : formatted;
  }

  // ========== PRIVATE HELPERS ==========

  /**
   * Get filename from path
   * @private
   * @param {string} path - File path
   * @returns {string} Filename portion of path
   */
  _getFilename(path) {
    return basename(path) || path;
  }

  /**
   * Get language from file path extension
   * @private
   * @param {string} path - File path
   * @returns {string} Language identifier
   */
  _getLanguageFromPath(path) {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    /** @type {Record<string, string>} */
    const langMap = {
      js: 'javascript',
      ts: 'typescript',
      jsx: 'javascript',
      tsx: 'typescript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      md: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sql: 'sql',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash'
    };
    return langMap[ext] || ext;
  }
}

export default FileContentContextItem;
