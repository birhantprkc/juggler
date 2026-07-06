//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatDisplayPath } from 'juggler/item-utils';
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
   * Check if write-file actions are auto-approved.
   *
   * Looks for an enabled `{kind:'boolean', value:true}` rule under the
   * shared `write-file` itemType. Any plugin (write-file, replace-text,
   * the patch variants) gets auto-approval the moment a single such rule
   * exists, matching the original single-toggle UX.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input parameters (unused)
   * @returns {boolean} True if write-file permission is enabled
   */
  isPermitted(_toolInput) {
    const mt = this.messageThread;
    if (!mt) return false;
    return mt.getRulesFor(EDIT_ITEM_TYPE)
      .some(r => r.kind === 'boolean' && r.value === true && r.scope !== 'session');
  }

  /**
   * Offer a single "don't ask again" choice: allow file edits for this
   * conversation. File-write permission is one shared boolean toggle (the
   * `write-file` itemType), so there is exactly one suggestion and no
   * escalating breadth — selecting it persists the same `{value:true}` rule
   * the permission popup toggle sets, satisfying the `isPermitted` invariant.
   *
   * Returns `[]` when writes are already allowed (the approval prompt wouldn't
   * appear in that case anyway) so the framework shows no redundant button.
   * @override
   * @param {Record<string, unknown>} toolInput - Tool input parameters
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} One suggestion, or none if already allowed
   */
  getApprovalSuggestions(toolInput) {
    if (!this.messageThread || this.isPermitted(toolInput)) return [];
    return [{
      itemType: EDIT_ITEM_TYPE,
      rules: [{ kind: 'boolean', value: true, scope: 'conversation' }],
      label: 'file edits'
    }];
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
    return {
      title: formatDisplayPath(path),
      message: '',
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
