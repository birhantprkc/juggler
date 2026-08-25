//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';

/**
 * What {@link WordCountContextItem.execute} returns. Keeping the result shape in
 * a typedef is worth the four lines: it is what makes `outcome.result.words`
 * type-check in getSummary().
 * @typedef {object} WordCountResult
 * @property {number} words - Number of whitespace-separated words
 * @property {number} characters - Number of characters, whitespace included
 */

/**
 * Counts the words in a string — the smallest tool worth writing, and the shape
 * every other context item follows.
 * @augments ContextItem
 */
class WordCountContextItem extends ContextItem {
  static MANIFEST = {
    id: 'word-count',
    name: 'Word Count',
    version: '1.0.0',
    description: 'Count the words in a piece of text',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * The schema the model sees. `category` drives tool gating — a strategy such
   * as read-only keeps `read` and `meta` and drops `write`, so getting this
   * right is what makes your tool behave sensibly under someone else's strategy.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [{
      name: 'word_count',
      category: 'read',
      description: 'Count the words and characters in a piece of text.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to count' }
        },
        required: ['text']
      }
    }];
  }

  /**
   * Reject bad input before anything runs. The error text goes to the model, so
   * write it as an instruction it can act on, not as a stack trace.
   * @param {Record<string, unknown>} toolInput - Raw parameters from the tool call
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (typeof toolInput.text !== 'string' || toolInput.text.trim() === '') {
      return { valid: false, error: 'Parameter "text" must be a non-empty string' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Do the work and return RAW data — the framework wraps it as
   * `outcome.result`. Nothing here touches the DOM: execute() runs in the
   * engine, where there isn't one.
   * @param {Record<string, unknown>} params - Validated parameters
   * @returns {Promise<WordCountResult>} The counts
   */
  async execute(params) {
    const text = /** @type {string} */ (params.text);
    return {
      words: text.split(/\s+/).filter(Boolean).length,
      characters: text.length
    };
  }

  /**
   * Format the outcome for the transcript.
   *
   * Note `outcome.result.words` — NOT `outcome.words`. execute()'s return value
   * is nested under `result`, and reading it at the top level is the single most
   * common mistake in a first extension: it yields undefined, and the model sees
   * an empty result with nothing to explain it.
   * @param {import('juggler/context-item').Outcome} outcome - The execution outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted summary
   */
  getSummary(outcome) {
    if (!outcome.success) return this.failureSummary(outcome.error ?? 'Count failed');
    const result = /** @type {WordCountResult} */ (outcome.result);
    return this.successSummary(`${result.words} words, ${result.characters} characters`);
  }
}

export default WordCountContextItem;
