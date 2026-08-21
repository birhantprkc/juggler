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

/**
 * Debounce delay for saving draft message in composer (milliseconds).
 *
 * This is how long freshly typed text exists only in the textarea, recoverable
 * by nothing — so it is a data-loss window, not just a tuning knob, and it is
 * kept near the shortest pause that still reads as "stopped typing" rather than
 * "mid-word". Its only cost is Yjs update chatter: each expiry rewrites the
 * whole draft record, and repeated writes to the same key merge cheaply.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 750;

/**
 * How long the close/quit handshake waits for one conversation's worker to
 * confirm a rescued draft reached disk (milliseconds). Deliberately short: the
 * native host is blocked on our reply and would rather quit with a draft in
 * flight than hang on a wedged worker.
 */
export const CLOSE_FLUSH_ACK_TIMEOUT_MS = 2500;

/**
 * How long a lookup on the send path may take before the composer gives up on
 * it and sends anyway (milliseconds).
 *
 * The skill snapshot and the `@`-mention existence check both run between the
 * user pressing Send and the message being dispatched, and `fetch` on its own
 * will wait out the browser's full network timeout. Over a slow tunnel or a
 * mobile link that turns Send into a control that appears to do nothing, so
 * these two calls give up and degrade instead: an unresolved `$name` stays as
 * prose, an unverified bareword `@foo` makes no context item, and the message
 * still goes. Generous enough for a remote-access round trip, short enough that
 * a dead link is over before the user reaches for the button again.
 */
export const SEND_LOOKUP_TIMEOUT_MS = 8000;

// ===== Yjs Sync Constants =====

/** Batching window for Yjs sync updates (milliseconds) */
export const YJS_SYNC_BATCH_MS = 50;

// ===== Conversation naming =====

/**
 * Maximum length (in characters) of a conversation / tab name. Enforced at the
 * UI level (the inline-rename input's `maxlength`), the data level
 * (`Session.renameConversation`), and for machine-derived names
 * (`uniqueSuffixedName`, which clips the base so "(copy)" / "(continued)"
 * fits), so it is the single source of truth for the limit. Kept just under the
 * server's filesystem-safety cap of 50 runes (`core.SanitizedNameMaxRunes`) so
 * a name we accept is never silently truncated when the folder is written to
 * disk.
 */
export const MAX_CONVERSATION_NAME_LENGTH = 48;

// ===== User-facing notices =====

/**
 * Notice shown when a user action (new thread, /compact, …)
 * preempts a live LLM turn by cancelling it first. Surfacing this keeps the
 * cancellation from being silent.
 */
export const TURN_CANCELLED_NOTICE = 'Cancelled the active turn';

/**
 * Notice shown when a duplication opts out of forking a running source (via
 * refuseWhileActive — currently only /handoff, whose follow-up LLM turn needs a
 * settled source). Plain duplicate/branch fork mid-turn instead: the server
 * snapshots the live doc and the clone loads stopped, so they never show this.
 */
export const DUPLICATE_WHILE_ACTIVE_NOTICE =
  "Can't duplicate while a turn is running — wait for it to finish, or cancel it first.";
