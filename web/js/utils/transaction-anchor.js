//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Find the transactionId of the most recent assistant message in a thread's
 * items list. This identifies the most recent user-visible LLM call —
 * the right anchor for "what does the footer show" and "should we
 * auto-compact".
 *
 * The anchor is the visible call the user is looking at, so the scan keys on
 * `type === 'assistant'`: the worker stamps `currentTxnID` onto every item
 * produced during a round-trip (assistant, tool-actions, errors, context
 * inserts, post-compaction bookkeeping), and the assistant message is the one
 * whose txnID points at the blob the footer and auto-compact care about.
 * @param {Array<{get?: (key: string) => any}>} items - Y.Array items (or empty)
 * @returns {string} transactionId, or '' if no assistant with a txnId is found
 */
export function findLastAssistantTxnId(items) {
  if (!items) return '';
  for (let i = items.length - 1; i >= 0; i--) {
    const get = items[i]?.get?.bind(items[i]);
    if (!get) continue;
    if (get('type') !== 'assistant') continue;
    const txnId = String(get('transactionId') || '');
    if (txnId) return txnId;
  }
  return '';
}
