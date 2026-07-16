//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath } from 'juggler/item-utils';
import { isPathInsideAllowedRoots, canonicalRoot } from 'juggler/utils/path-containment';
import { renderWriteFilePermissionSection } from './edit/permission-section.js';

/**
 * The single `itemType` used by every edit-family plugin. The rule shape is
 * `{kind: 'boolean', value: true|false}`; a single enabled rule means "allow
 * file writes". We use one shared itemType so the toggle in the UI affects
 * write-file / replace-text / etc. uniformly, matching the previous UX.
 */
const EDIT_ITEM_TYPE = 'write-file';

/**
 * Common parameter aliases for edit operations.
 * LLMs may use various names for the same parameter.
 */
const OLD_CONTENT_ALIASES = ['old_str', 'oldContent', 'old', 'pattern', 'search', 'oldText', 'searchText'];
const NEW_CONTENT_ALIASES = ['new_str', 'newContent', 'new', 'replacement', 'replace', 'newText', 'replacementText', 'content', 'text', 'new_content'];

/**
 * Base class for all file editing actions
 * Provides common validation, diff handling, and result formatting
 * @abstract
 */
class EditBase extends ContextItem {
  /** @returns {{allowedScopes: Array<'conversation'>, defaultScope: 'conversation'}} Permission scope policy */
  static getPermissionScopePolicy() {
    return { allowedScopes: ['conversation'], defaultScope: 'conversation' };
  }

  /**
   * Normalize a parameter by checking for known aliases.
   * Returns the value from the first matching alias, or undefined if none found.
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @param {string[]} aliases - List of aliases to check (in priority order)
   * @param {string} [prefixFallback] - Optional prefix for fallback matching (e.g., 'old', 'new')
   * @returns {any} The parameter value, or undefined if not found
   */
  static _findParamByAlias(params, aliases, prefixFallback) {
    // Check explicit aliases first
    for (const alias of aliases) {
      if (params[alias] !== undefined) {
        return params[alias];
      }
    }
    // Fallback: check for any param starting with prefix
    if (prefixFallback) {
      const key = Object.keys(params).find(k => k.toLowerCase().startsWith(prefixFallback.toLowerCase()));
      if (key) {
        return params[key];
      }
    }
    return undefined;
  }

  /**
   * Normalize old content parameter from various aliases to a standard field.
   * Accepts: old_str, oldContent, old, pattern, search, oldText, searchText
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @returns {string|undefined} Normalized old content value
   */
  static _normalizeOldContent(params) {
    return EditBase._findParamByAlias(params, OLD_CONTENT_ALIASES, 'old');
  }

  /**
   * Normalize new content parameter from various aliases to a standard field.
   * Accepts: new_str, newContent, new, replacement, replace, newText, etc.
   * @protected
   * @param {Record<string, any>} params - Raw parameters
   * @returns {string|undefined} Normalized new content value
   */
  static _normalizeNewContent(params) {
    return EditBase._findParamByAlias(params, NEW_CONTENT_ALIASES, 'new');
  }

  /**
   * Get permission key for file editing actions
   *
   * All file editing actions use 'write-file' permission.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input (unused)
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return 'write-file';
  }

  /**
   * Extract the target path from a tool input, tolerating the `file_path`
   * alias LLMs sometimes emit (mirrors {@link normalizeFilePath} without
   * mutating the caller's object). Returns '' when no usable path is present.
   * @protected
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {string} The target path, or '' if none
   */
  static _editPath(toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    const p = toolInput.path ?? toolInput.file_path;
    return typeof p === 'string' ? p : '';
  }

  /**
   * Does this write target sit inside the project root or the user's standing
   * allowed-paths grant? A path we can't read is treated as out-of-root so the
   * write prompts.
   * @protected
   * @param {string} path - Target path
   * @returns {boolean} True if the path is within an allowed root
   */
  _isPathAllowed(path) {
    if (!path) return false;
    const mt = this.messageThread;
    if (!mt) return false;
    return isPathInsideAllowedRoots(
      path,
      mt.getAllowedPaths(),
      this.session?.home || '',
      this.session?.platform || ''
    );
  }

  /**
   * Wrap a backend edit-family write so the backend's defence-in-depth check
   * (AuthorizeOutOfScopeWrite) admits it. Returns the params to send and the
   * standing allowed-paths grant to carry as top-level transport:
   *  - `allowedPaths` puts the user's grant in the backend PathScope, so a write
   *    to a granted out-of-project root is treated as in-scope;
   *  - `outOfRootApproved:true` is added to params ONLY when the target is
   *    outside those roots. Reaching execute() at all means approval was granted
   *    — {@link isPermitted} rejects out-of-root standing rules, so an
   *    out-of-root write can only arrive here via an explicit modal approval, and
   *    the action-executor throws before execute() otherwise. So this marks a
   *    genuinely user-approved write without ever trusting a standing rule.
   * @protected
   * @param {Record<string, any>} params - Backend op params (must include `path`)
   * @returns {{params: Record<string, any>, allowedPaths: string[]}} Call inputs
   */
  _authorizeWrite(params) {
    const allowedPaths = this.getAllowedPaths();
    const path = typeof params?.path === 'string' ? params.path : '';
    if (path && !this._isPathAllowed(path)) {
      return { params: { ...params, outOfRootApproved: true }, allowedPaths };
    }
    return { params, allowedPaths };
  }

  /**
   * Check if write-file actions are auto-approved.
   *
   * TWO conditions must both hold: (1) an enabled `{kind:'boolean', value:true}`
   * rule exists under the shared `write-file` itemType (the "allow file edits"
   * toggle), AND (2) the target path resolves inside the project root or the
   * user's allowed-paths grant. The toggle alone is deliberately NOT sufficient
   * for an out-of-root write: otherwise one "don't ask again" on an innocuous
   * in-project write would silently auto-approve writes to `C:\`, `~`, or
   * anywhere on disk (issues #23/#24). An out-of-root write always prompts until
   * the user explicitly grants that folder.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {boolean} True if the write is auto-approved
   */
  isPermitted(toolInput) {
    const mt = this.messageThread;
    if (!mt) return false;
    const toggleOn = mt.getRulesFor(EDIT_ITEM_TYPE)
      .some(r => r.kind === 'boolean' && r.value === true && r.scope !== 'session');
    if (!toggleOn) return false;
    return this._isPathAllowed(EditBase._editPath(toolInput));
  }

  /**
   * Collapse an absolute path's home-dir prefix to `~` for display (purely
   * cosmetic; the persisted grant is the absolute path).
   * @protected
   * @param {string} p - Absolute path
   * @param {string} home - Backend home dir (may be empty)
   * @returns {string} `~`-collapsed display path
   */
  static _tildeify(p, home) {
    if (!home) return p;
    const base = home.endsWith('/') ? home.slice(0, -1) : home;
    if (p === base) return '~';
    if (p.startsWith(base + '/')) return '~' + p.slice(base.length);
    return p;
  }

  /**
   * Directory portion of a path, handling both `/` and `\` separators (the
   * backend reports native OS paths).
   * @protected
   * @param {string} p - File path
   * @returns {string} The parent directory, or '' if none
   */
  static _dirname(p) {
    if (!p) return '';
    const trimmed = p.replace(/[/\\]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx <= 0 ? '' : trimmed.slice(0, idx);
  }

  /**
   * Offer "don't ask again" choices for a write that isn't yet auto-approved.
   *
   * In-root writes (or writes whose path we can't read) need only the shared
   * "allow file edits" toggle, so there is a single suggestion — same as the
   * original single-toggle UX.
   *
   * An out-of-root write is different: the toggle alone will NOT auto-approve
   * it (see {@link isPermitted}), so we offer, narrowest first:
   *   1. allow file edits AND add this file's folder to the allowed paths — the
   *      grant that actually stops future prompts here (and, since the list is
   *      shared, widens shell access too). Only offered when the folder
   *      canonicalises to a grantable absolute root ({@link canonicalRoot}
   *      returns null for `~`, `$`-bearing, over-broad, or Windows drive paths).
   *   2. allow file edits only — which will keep prompting for this and other
   *      out-of-root writes; the label says so.
   *
   * Returns `[]` when the write is already permitted (no prompt appears).
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
   */
  getApprovalSuggestions(toolInput) {
    if (!this.messageThread || this.isPermitted(toolInput)) return [];
    /** @type {{kind: 'boolean', value: true, scope: 'conversation'}} */
    const allowRule = { kind: 'boolean', value: true, scope: 'conversation' };
    const path = EditBase._editPath(toolInput);

    // In-root (toggle merely off) or path unknown: the write only needs the
    // file-edit toggle.
    if (!path || this._isPathAllowed(path)) {
      return [{ itemType: EDIT_ITEM_TYPE, rules: [allowRule], label: 'file edits' }];
    }

    // Out-of-root: two tiers.
    const home = this.session?.home || '';
    /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
    const suggestions = [];
    const folder = canonicalRoot(EditBase._dirname(path), home);
    if (folder) {
      suggestions.push({
        itemType: EDIT_ITEM_TYPE,
        rules: [allowRule],
        allowedPaths: [folder],
        label: `file edits + allow ${EditBase._tildeify(folder, home)}`
      });
    }
    suggestions.push({
      itemType: EDIT_ITEM_TYPE,
      rules: [allowRule],
      label: 'file edits (writes outside the project still prompt)'
    });
    return suggestions;
  }

  /**
   * Render the file-write permission UI for the permission-controls popup.
   * Lazy-loads the section module to avoid pulling the DOM-touching code
   * into worker / engine contexts that never call this method.
   * @override
   * @param {import('../../../js/model/message-thread.js').MessageThread} messageThread Owning thread
   * @returns {{id: string, element: HTMLElement, dispose: () => void}} Permission section
   */
  static getPermissionSection(messageThread) {
    return renderWriteFilePermissionSection(messageThread);
  }

  /**
   * Build standard approval config for edit actions
   * @protected
   * @param {string} path - File path being edited
   * @param {{oldContent: string, newContent: string, startLineNumber?: number}} diffData - Diff data
   * @returns {import('juggler/context-item').ApprovalConfig} Approval config
   */
  _buildApprovalConfig(path, diffData) {
    // When the target is outside the project root + allowed paths, make that
    // unmistakable: show the full absolute path as the title (not `./`-prefixed,
    // which would read as project-relative) and a warning message. This is
    // exactly the case #24 needed the user to notice.
    const outOfRoot = path && !this._isPathAllowed(path);
    return {
      title: outOfRoot ? path : formatDisplayPath(path),
      message: outOfRoot ? `⚠ Write outside the project folder: ${path}` : '',
      display: {
        diffData: {
          oldContent: diffData.oldContent,
          newContent: diffData.newContent,
          path: path,
          startLineNumber: diffData.startLineNumber || 1
        }
      }
    };
  }

  /**
   * Format edit result with standard structure
   * @protected
   * @param {string} path - File path that was edited
   * @param {string} details - Detailed description of what was edited
   * @returns {{summary: string, details: string, success: boolean, icon: string}} Formatted result object for display
   */
  _formatEditResult(path, details) {
    return {
      summary: `Edited file: ${path}`,
      details: details,
      success: true,
      icon: '✓'
    };
  }

}

export default EditBase;
