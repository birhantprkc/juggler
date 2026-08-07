//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Conversation placeholder naming — the browser-side SINGLE SOURCE OF TRUTH for
 * the default names an untitled conversation carries before it is titled. This is
 * the twin of Go's cmd/juggler/core/conversation_naming.go: the client generates
 * the numbered placeholder for a fresh conversation and the server's auto-namer
 * decides whether to rename based on the same shape, so the two must agree exactly.
 * conversation_naming_test.go reads this file and asserts they never drift — change
 * both together.
 * @module model/conversation-naming
 */

/** The bare display/folder fallback for a conversation that has no name yet. */
export const UNTITLED_BASE = 'Untitled';

/**
 * Matches the numbered placeholder shape ("Untitled 7"), anchored end to end.
 * The capture group exposes N so callers can find the smallest unused number.
 */
export const UNTITLED_NAME_RE = /^Untitled (\d+)$/;

/**
 * The numbered placeholder for n (n >= 1), e.g. `untitledName(3)` → "Untitled 3".
 * @param {number} n
 * @returns {string} The numbered placeholder name for n.
 */
export function untitledName(n) {
  return `${UNTITLED_BASE} ${n}`;
}

/**
 * Whether name is a bare numbered placeholder ("Untitled 7") — a conversation
 * still carrying its auto-assigned default name, and thus a candidate for
 * auto-naming. Mirrors Go core.IsUntitledName.
 * @param {string} name
 * @returns {boolean} True when name is a bare numbered placeholder.
 */
export function isUntitledName(name) {
  return UNTITLED_NAME_RE.test(name || '');
}
