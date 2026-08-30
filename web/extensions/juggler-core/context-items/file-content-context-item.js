//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath, formatFileContentForLLM, basename } from 'juggler/item-utils';
import { extractFileSource } from 'juggler/registry';
import { createElement } from 'juggler/ui';
import { addFilePath } from 'juggler/ui';
import { buildPickerPanel } from 'juggler/ui';
import { smartTruncate } from 'juggler/ui';
import { gitignoreDisabled } from './path-approval.js';
import { fetchLiveFile, liveFileSource, liveFileInfo, renderLiveFileBody } from '../lib/live-file.js';

/**
 * Safety ceiling (characters) on the file body a single pinned/@-mentioned file
 * contributes to the request. A pin is deliberate, so this is far more generous
 * than the per-`read`-call budget — it never touches a normal pinned file — but
 * a provider rejects any single content field past a hard byte limit (OpenAI:
 * 10 MiB) regardless of the token budget, and that rejection is not a
 * context-overflow the compaction/recovery ladder can resolve. The pin renders
 * live every turn, so an oversized or minified file (one enormous line slips the
 * per-line cap) would otherwise trip that limit on every turn until the pin is
 * removed. The ceiling stays under the byte limit even for worst-case
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
 * Deliberately minimal: only the path and a directory marker. The actual bytes
 * are resolved live at send time (see {@link FetchResult}) and never
 * round-tripped through Yjs — a pin means "this file, kept current", so there is
 * nothing to freeze.
 * @typedef {object} FileContentData
 * @property {string} path - File or directory path (trailing "/" for dirs)
 * @property {boolean} [isDirectory] - True when path refers to a directory
 */

/** @typedef {import('../lib/live-file.js').LiveFileResult} LiveFileResult */

// ============================================================================
// FileContentContextItem
// ============================================================================

/**
 * FileContentContextItem - a deliberate "keep this file current" pin.
 *
 * SEMANTICS (see docs/extension_guide.md §"Pinned file content"):
 *  - Every USER-driven file reference is this item: the file picker / paperclip,
 *    an `@file` mention (composer.js and scheduled-send-service.js both create
 *    one per mention), and the CLAUDE.md / AGENTS.md a session seeds itself with.
 *    What is NOT this is a `read` TOOL CALL — that is ReadFileContextItem, an
 *    immutable record of bytes the model saw at one turn, living in the
 *    append-only history. The split is who asked, not how casually.
 *  - The pin persists only a `path` in Yjs; file bytes are NEVER persisted.
 *  - Content is resolved LIVE (`getContextText`) from the current file each turn.
 *    Because a pin rides `contextPosition:'prefix'` (leading messages, before the
 *    growing history), the live render is byte-identical when the file is unchanged
 *    → the prompt cache hits and the pin is paid for once; when the file actually
 *    changes, the new bytes bust the cache from that point (one cold-start) — which
 *    is exactly the point of a pin. No watcher: nothing is in flight between sends.
 *  - The properties panel also reads live (nothing to be stale against).
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
     * @type {{path: string, ts: number, pending: Promise<LiveFileResult>|null, result: LiveFileResult|null}|null}
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
   * Restore item from JSON. Strips any legacy snapshot fields that older
   * conversations may have persisted (content, size, totalLines, …) so a
   * pin's Yjs footprint stays bounded regardless of file size — a pin persists
   * only its path; bytes are resolved live.
   * @param {import('juggler/context-item').ItemJSON} json
   */
  fromJSON(json) {
    super.fromJSON(json);
    FileContentContextItem._stripLegacyFields(this.data);
  }

  /**
   * Remove legacy/transient snapshot fields from a data object in place.
   * @param {Record<string, unknown>} data - The data object to clean
   * @private
   */
  static _stripLegacyFields(data) {
    const dead = ['content', 'language', 'size', 'totalLines', 'lineOffset',
      'lineCount', 'exists', 'warning', 'readMode'];
    for (const k of dead) {
      if (k in data) delete data[k];
    }
  }

  /**
   * Execute tool call - record the pinned path.
   *
   * No content fetch here: pinned content is resolved live at send time via
   * {@link createContextText}. The properties panel and any UI badge that needs a
   * line count will fetch on demand.
   * @param {string} _toolName - Tool name (unused, only one tool)
   * @param {Record<string, any>} params - Tool parameters
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, params) {
    if (!params.path || typeof params.path !== 'string') {
      throw new Error('Missing required parameter: path');
    }
    this.data.path = params.path;
  }

  /**
   * Fetch live file/directory contents.
   *
   * Returns a transient {@link LiveFileResult}; does NOT touch `this.data` —
   * writing what disk said back into the item would mutate the Yjs document
   * across peers on every change to the file.
   *
   * A 500ms TTL cache is kept in `this._lastFetch` so a send-time read and
   * a properties-panel render in the same tick share one round-trip.
   * Concurrent callers join the same in-flight promise.
   * @returns {Promise<LiveFileResult>} Live file or directory contents
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
   * Underlying single-shot fetch. Always returns a usable {@link LiveFileResult}
   * (errors collapse to `exists:false`); callers should not catch.
   *
   * A pin is always user-initiated — the user explicitly chose this path via
   * `@`-mention or the file picker, so it may legitimately point outside the
   * project root — and the shared reader says so on its behalf.
   * @param {string} path - File or directory path to load
   * @returns {Promise<LiveFileResult>} Fetched result; `exists:false` on error
   * @private
   */
  async _doFetch(path) {
    return fetchLiveFile(path, { noIgnore: gitignoreDisabled(this) });
  }

  /**
   * Build the FileSource for a live fetch result, for either realm's use of it
   * (the panel renders it, createContextText extracts from it).
   * @param {LiveFileResult} r - A live fetch result
   * @returns {import('juggler/file-source').FileSource} The file, ready to render or extract
   * @private
   */
  _liveFileSource(r) {
    return liveFileSource(r, this.getAbsolutePath() || r.path || '', {
      conversationId: this.conversation?.id,
    });
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

    addFilePath(headerHost, this.getAbsolutePath() || 'No file', undefined,
      { pin: this.getAbsolutePath() });

    if (!this.data.path) {
      body.appendChild(createElement('div', 'file-content-loading', 'No file selected'));
      return container;
    }

    body.appendChild(createElement('div', 'file-content-loading', 'Loading…'));

    this._fetchLive().then(r => {
      // Swap body. Replace the header info with the just-fetched stats.
      headerHost.replaceChildren();
      const absolute = this.getAbsolutePath() || r.path || '';
      addFilePath(headerHost, absolute || 'No file', liveFileInfo(r), { pin: absolute });

      // The header above already carries the path and the current stats, so the
      // body renders content alone.
      renderLiveFileBody(body, r, {
        absolutePath: this.getAbsolutePath() || r.path || this.data.path,
        conversationId: this.conversation?.id,
      });
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
   * Resolves the pinned file's contents LIVE from disk every time the prompt is
   * built. Because the pin rides `contextPosition:'prefix'` (before the growing
   * history), an unchanged file renders byte-identically each turn → the prompt
   * cache hits; only a genuine change to the file busts it. Disk bytes are never
   * persisted to Yjs.
   * @param {import('juggler/context-item').ContextParams} _contextParams - Context parameters
   * @returns {Promise<string>} Formatted file content for LLM context
   */
  async createContextText(_contextParams) {
    if (!this.data.path) {
      return '';
    }

    const r = await this._fetchLive();

    if (!r.exists) {
      return `File does not exist: ${r.path || this.data.path}`;
    }

    if (r.isDirectory) {
      return `Directory listing of ${r.path}:\n${r.content || '(empty)'}`;
    }

    if (r.warning) {
      return `File ${r.path}: ${r.warning}`;
    }

    // A file whose bytes are not text carries no `content` of its own — its
    // viewer is what turns it into something the model can read (a PDF's pages).
    // Without this the pin would render as formatFileContentForLLM's "exists but
    // is empty" warning, telling the model the opposite of the truth about a
    // file the user deliberately pinned. Mirrors ReadFileContextItem.execute,
    // except that a pin is live: there is nothing persisted to extract once, so
    // the extraction runs with the read, every turn.
    if (r.isBinary && !r.content) {
      const extracted = await extractFileSource(this._liveFileSource(r), {
        maxChars: MAX_PINNED_FILE_CHARS,
        conversationId: this.conversation?.id,
      });
      if (extracted.text) return extracted.text;
      if (extracted.warning) return `File ${r.path}: ${extracted.warning}`;
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
}

export default FileContentContextItem;
