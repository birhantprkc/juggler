//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * File-editing permission — the single source of truth for reading and toggling
 * a conversation's "edits allowed" state.
 *
 * File-write permission is one shared boolean rule under the `write-file`
 * itemType, scoped to the conversation. Three call sites need it in lockstep:
 * the permission-controls header summary, the permission popup's toggle button
 * (contributed by the edit extension), and the "toggle file editing" keyboard
 * shortcut. They all route through here so the rule shape lives in one place.
 * @module services/file-editing-permission
 */

/**
 * @typedef {import('../model/message-thread.js').default} MessageThread
 */

/** The itemType under which the shared file-write permission rule lives. */
export const WRITE_FILE_ITEM_TYPE = 'write-file';

/**
 * Session-metadata key holding the per-project "start new tasks with edits
 * allowed" preference. Stored in `session.metadata` (the general-purpose
 * frontend-flag map), so it persists with the session and is shared across
 * windows on the same project — off unless the operator opts in.
 */
export const DEFAULT_FILE_EDITING_META_KEY = 'defaultFileEditingOn';

/**
 * Whether file edits are currently allowed for a conversation.
 * @param {MessageThread|null|undefined} messageThread - The conversation's thread.
 * @returns {boolean} True when a boolean=true write-file rule is present.
 */
export function isFileEditingAllowed(messageThread) {
  if (!messageThread) return false;
  return messageThread.getRulesFor(WRITE_FILE_ITEM_TYPE)
    .some((/** @type {any} */ r) => r.kind === 'boolean' && r.value === true);
}

/**
 * Set a conversation's file-editing permission to an explicit state. Wipes any
 * existing boolean write-file rules first (so a stale `value:false` can't leave
 * a dangling pair that stops the toggle responding), then adds a single
 * `value:true` rule when turning editing on. Idempotent.
 * @param {MessageThread} messageThread - The conversation's thread.
 * @param {boolean} allowed - Desired state — true to allow edits, false to ask.
 * @returns {boolean} The resulting state (equals `allowed`).
 */
export function setFileEditingAllowed(messageThread, allowed) {
  for (const r of messageThread.getRulesFor(WRITE_FILE_ITEM_TYPE)
    .filter((/** @type {any} */ rule) => rule.kind === 'boolean')) {
    messageThread.removeRule(r.id);
  }
  if (allowed) {
    messageThread.addRule(WRITE_FILE_ITEM_TYPE, { kind: 'boolean', value: true, scope: 'conversation' });
  }
  return !!allowed;
}

/**
 * Toggle a conversation's file-editing permission.
 * @param {MessageThread} messageThread - The conversation's thread.
 * @returns {boolean} The new state — true when editing is now allowed.
 */
export function toggleFileEditing(messageThread) {
  return setFileEditingAllowed(messageThread, !isFileEditingAllowed(messageThread));
}

/**
 * Whether new tasks in this session should start with file editing allowed.
 * @param {{getMetadata?: (key: string) => any}|null|undefined} session - The active session.
 * @returns {boolean} True when the per-project default is enabled.
 */
export function isDefaultFileEditingOn(session) {
  return !!(session && session.getMetadata && session.getMetadata(DEFAULT_FILE_EDITING_META_KEY));
}

/**
 * Persist the per-project "start new tasks with edits allowed" preference. The
 * write is optimistic + broadcast through {@link session.patchMetadata}, so it
 * survives restarts and reaches other windows on the same project.
 * @param {{patchMetadata?: (patch: Record<string, any>) => any}|null|undefined} session - The active session.
 * @param {boolean} on - The new default.
 * @returns {void}
 */
export function setDefaultFileEditingOn(session, on) {
  if (!session || typeof session.patchMetadata !== 'function') return;
  session.patchMetadata({ [DEFAULT_FILE_EDITING_META_KEY]: !!on });
}
