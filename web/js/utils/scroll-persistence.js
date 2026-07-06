//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-conversation scroll-state persistence (localStorage).
 *
 * Stores an element-anchored marker rather than an absolute scrollTop so
 * restore survives changes to content height (added messages, expanded
 * tool actions, resized window). `atBottom` is the fast path: it lets us
 * snap to the live bottom without caring how tall the conversation is now.
 */

/**
 * @typedef {{atBottom: boolean, topItemId: string|null}} ScrollState
 */

const STORAGE_KEY = 'jugglerScrollStates';

/**
 * @returns {{[conversationId: string]: ScrollState}} All persisted states.
 */
function readAll() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/**
 * @param {string} conversationId
 * @param {ScrollState} state
 */
export function saveScrollState(conversationId, state) {
  const all = readAll();
  all[conversationId] = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/**
 * @param {string} conversationId
 * @returns {ScrollState|null} Saved state, or null if none persisted.
 */
export function getScrollState(conversationId) {
  const all = readAll();
  return all[conversationId] ?? null;
}
