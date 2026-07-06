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
 * Toggle a conversation's file-editing permission. Wipes any existing boolean
 * write-file rules first (so a stale `value:false` can't leave a dangling pair
 * that stops the toggle responding), then adds a single `value:true` rule when
 * turning editing on.
 * @param {MessageThread} messageThread - The conversation's thread.
 * @returns {boolean} The new state — true when editing is now allowed.
 */
export function toggleFileEditing(messageThread) {
  const nowAllowed = !isFileEditingAllowed(messageThread);
  for (const r of messageThread.getRulesFor(WRITE_FILE_ITEM_TYPE)
    .filter((/** @type {any} */ rule) => rule.kind === 'boolean')) {
    messageThread.removeRule(r.id);
  }
  if (nowAllowed) {
    messageThread.addRule(WRITE_FILE_ITEM_TYPE, { kind: 'boolean', value: true, scope: 'conversation' });
  }
  return nowAllowed;
}
