//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Token estimation for numbers the UI works out for itself.
 *
 * The browser ships no tokenizer, so anything counted here is the same
 * ~4-characters-per-token approximation the server uses when it admits a
 * request (`provider.EstimateTokens`). One definition lives here so the
 * properties-panel chip, the transaction view's per-message sizes and the
 * context-item render path can't drift apart — or away from the server.
 *
 * Provider-reported counts never pass through this module: those are exact,
 * arrive on the transaction blob, and are displayed without a `~`.
 * @module utils/token-estimate
 */

import { yGet, plain } from '../model/item-accessor.js';

/** Characters per token in the shared approximation. */
const CHARS_PER_TOKEN = 4;

/** Text longer than this contributes its own labelled block in detail views. */
export const LONG_TEXT_CHARS = 160;

/**
 * Estimate the token cost of a string.
 * @param {string|null|undefined} text - Text to measure.
 * @returns {number} Estimated tokens (0 for empty/absent text).
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

/**
 * Estimate the token cost of an arbitrary value as it would go on the wire:
 * strings measure directly, everything else measures its compact JSON (the
 * shape the provider actually receives — not the pretty-printed form the UI
 * shows, whose indentation would inflate the count).
 * @param {unknown} value - Value to measure.
 * @returns {number} Estimated tokens (0 when the value can't be serialised).
 */
export function estimateValueTokens(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTokens(value);
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/**
 * The text a conversation item contributes to the LLM, mirroring the worker's
 * wire projection (`buildMessagesFromItems`) closely enough to size the item:
 * a tool-action costs its input arguments plus its result, a thread costs its
 * goal plus its summary, everything else costs its content.
 *
 * This is what the item sent, which is not always what the panel shows — tool
 * output is clipped by `truncateForLLM` before it reaches the model, and the
 * stored result holds the clipped text, so measuring it here stays honest for
 * exactly the enormous read where the difference matters.
 * @param {any} item - Conversation item Y.Map (or a plain equivalent).
 * @returns {string} The item's LLM-facing text ('' when it contributes none).
 */
export function llmTextForItem(item) {
  if (!item || typeof item.get !== 'function') return '';
  const type = item.get('type');

  if (type === 'tool-action') {
    const input = yGet(item, 'toolInput');
    const result = plain(item.get('result')) || {};
    const args = input ? JSON.stringify(input) : '';
    const output = typeof result.content === 'string'
      ? result.content
      : (typeof result.output === 'string' ? result.output : '');
    return args + output;
  }

  if (type === 'thread') {
    const goal = item.get('goal') || '';
    const summary = item.get('summary') || item.get('content') || '';
    return `${goal}${summary}`;
  }

  return item.get('content') || '';
}
