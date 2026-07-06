//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Application-wide constants
 */

// ===== Timing Constants =====

/** Debounce delay for session save operations (milliseconds) */
export const SAVE_DEBOUNCE_MS = 300;

// ===== Message History Constants =====

/** Maximum number of messages to keep in history */
export const MAX_MESSAGE_HISTORY = 100;

/** Debounce delay for saving draft message in input box (milliseconds) */
export const DRAFT_SAVE_DEBOUNCE_MS = 2000;

// ===== Yjs Sync Constants =====

/** Batching window for Yjs sync updates (milliseconds) */
export const YJS_SYNC_BATCH_MS = 50;

// ===== User-facing notices =====

/**
 * Notice shown when a user action (new thread, /compact, close thread, …)
 * preempts a live LLM turn by cancelling it first. Surfacing this keeps the
 * cancellation from being silent.
 */
export const TURN_CANCELLED_NOTICE = 'Cancelled the active turn';
