//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { loadBookmarks, saveBookmarks, formatBookmarks } from '../lib/bookmark-store.js';

/**
 * What execute() returns.
 * @typedef {object} ClearResult
 * @property {number} removed - How many bookmarks were deleted
 */

/**
 * Deleting every bookmark — the destructive half of this extension, in its own
 * class so that `requiresApproval` applies to it and not to saving or listing.
 * That flag is declared per class, so a class mixing safe and destructive tools
 * would have to gate all of them or none.
 * @augments ContextItem
 */
class BookmarkClearContextItem extends ContextItem {
  static MANIFEST = {
    id: 'bookmark-clear',
    name: 'Clear Bookmarks',
    version: '1.0.0',
    description: 'Delete every saved bookmark in this project',
    author: 'Juggler Team',
    // Park the call and ask, every time. The user can still grant a standing
    // permission from the dialog; that decision is theirs, not the tool's.
    requiresApproval: true
  };

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'bookmark_clear',
      category: 'write',
      description: 'Delete every saved bookmark in this project. Cannot be undone.',
      input_schema: { type: 'object', properties: {} }
    }];
  }

  /**
   * Describe the damage before it happens.
   *
   * The dialog is the user's last look at this, so it names what will actually
   * be lost rather than restating the tool. Reading the store here — before
   * approval — is safe because it only reads.
   * @param {Record<string, unknown>} _params - Validated parameters (this tool takes none)
   * @returns {Promise<import('juggler/context-item').ApprovalConfig>} Approval dialog configuration
   */
  async getApprovalConfig(_params) {
    const bookmarks = await loadBookmarks(this.signal);
    if (bookmarks.length === 0) {
      return { title: 'Clear bookmarks', message: 'There are no bookmarks to clear.' };
    }
    return {
      title: 'Clear bookmarks',
      message: `Delete all ${bookmarks.length} bookmarks? This cannot be undone.\n\n`
        + formatBookmarks(bookmarks)
    };
  }

  /**
   * @param {Record<string, unknown>} _params - Validated parameters (this tool takes none)
   * @returns {Promise<ClearResult>} How many were removed
   */
  async execute(_params) {
    const bookmarks = await loadBookmarks(this.signal);
    await saveBookmarks([], this.signal);
    return { removed: bookmarks.length };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - The execution outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted summary
   */
  getSummary(outcome) {
    if (!outcome.success) return this.failureSummary(outcome.error ?? 'Could not clear bookmarks');
    const result = /** @type {ClearResult} */ (outcome.result);
    return this.successSummary(
      result.removed === 0 ? 'No bookmarks to clear.' : `Cleared ${result.removed} bookmarks.`
    );
  }
}

export default BookmarkClearContextItem;
