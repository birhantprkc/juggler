//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { loadBookmarks, saveBookmarks, maxBookmarks, formatBookmarks } from '../lib/bookmark-store.js';

/**
 * What execute() returns, for either tool.
 * @typedef {object} BookmarksResult
 * @property {string} action - Which tool ran: 'add' or 'list'
 * @property {number} count - How many bookmarks exist now
 * @property {string} [name] - The bookmark just added
 * @property {boolean} [evicted] - Whether the cap dropped the oldest bookmark
 * @property {string} [listing] - Formatted bookmarks, for the list tool
 */

/**
 * Saving and listing bookmarks.
 *
 * Two tools on one class, because they share a store and a result shape.
 * Clearing lives in its own class instead — it is the destructive one, and
 * `requiresApproval` is declared per class, not per tool.
 * @augments ContextItem
 */
class BookmarksContextItem extends ContextItem {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'Save and recall named locations in the project',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Two tools, deliberately separate rather than one tool with an `action`
   * parameter: a model picks far more reliably between two well-named tools than
   * between two modes of one.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'bookmark_add',
        category: 'write',
        description: 'Save a named bookmark pointing at a file, optionally a specific line.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short label for this location' },
            path: { type: 'string', description: 'Project-relative file path' },
            line: { type: 'number', description: 'Optional 1-indexed line number' },
            note: { type: 'string', description: 'Optional note on why this matters' }
          },
          required: ['name', 'path']
        }
      },
      {
        name: 'bookmark_list',
        category: 'read',
        description: 'List every saved bookmark in this project.',
        input_schema: { type: 'object', properties: {} }
      }
    ];
  }

  /**
   * Only `bookmark_add` takes parameters worth checking. Errors go to the model,
   * so they say what to do rather than what went wrong.
   * @param {Record<string, unknown>} toolInput - Raw parameters from the tool call
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (toolInput.name === undefined && toolInput.path === undefined) {
      return { valid: true, params: toolInput };   // bookmark_list takes nothing
    }
    if (typeof toolInput.name !== 'string' || toolInput.name.trim() === '') {
      return { valid: false, error: 'Parameter "name" must be a non-empty string' };
    }
    if (typeof toolInput.path !== 'string' || toolInput.path.trim() === '') {
      return { valid: false, error: 'Parameter "path" must be a project-relative file path' };
    }
    if (toolInput.line !== undefined && (typeof toolInput.line !== 'number' || toolInput.line < 1)) {
      return { valid: false, error: 'Parameter "line" must be a positive number' };
    }
    return { valid: true, params: { ...toolInput, name: toolInput.name.trim() } };
  }

  /**
   * Runs in the engine. `this.signal` aborts if the turn is cancelled, so it is
   * forwarded to every op — an extension that ignores it keeps working after the
   * user has moved on.
   * @param {Record<string, unknown>} params - Validated parameters
   * @returns {Promise<BookmarksResult>} What happened
   */
  async execute(params) {
    const bookmarks = await loadBookmarks(this.signal);

    if (params.name === undefined) {
      return { action: 'list', count: bookmarks.length, listing: formatBookmarks(bookmarks) };
    }

    const name = /** @type {string} */ (params.name);
    // Re-saving a name updates it in place rather than accumulating duplicates.
    const kept = bookmarks.filter(b => b.name !== name);
    kept.push({
      name,
      path: /** @type {string} */ (params.path),
      line: typeof params.line === 'number' ? params.line : undefined,
      note: typeof params.note === 'string' ? params.note : undefined,
      savedAt: new Date().toISOString()
    });

    const cap = await maxBookmarks(this.signal);
    const evicted = kept.length > cap;
    const final = evicted ? kept.slice(kept.length - cap) : kept;
    await saveBookmarks(final, this.signal);

    return { action: 'add', name, count: final.length, evicted };
  }

  /**
   * Format the outcome.
   *
   * `summary` is BOTH the tool_result content the model reads and the line shown
   * in the transcript — there is no second hook for LLM-facing text, so put the
   * real content here and let `truncateForLLM` cap it. `details` is the extra
   * plain-text line carried alongside for display.
   *
   * Note `outcome.result` — execute()'s return value is nested there, and
   * reading `outcome.action` instead is the classic first-extension bug.
   * @param {import('juggler/context-item').Outcome} outcome - The execution outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted summary
   */
  getSummary(outcome) {
    if (!outcome.success) return this.failureSummary(outcome.error ?? 'Bookmark operation failed');
    const result = /** @type {BookmarksResult} */ (outcome.result);

    if (result.action === 'list') {
      if (result.count === 0) return this.successSummary('No bookmarks saved.');
      return this.successSummary(
        this.truncateForLLM(result.listing ?? ''),
        { details: `${result.count} bookmarks` }
      );
    }

    return this.successSummary(
      `Saved bookmark "${result.name}". ${result.count} bookmarks total.`
      + (result.evicted ? ' Dropped the oldest to stay under the cap.' : '')
    );
  }
}

export default BookmarksContextItem;
