//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Wires the session-scoped command shortcuts to their behaviour. The key table
 * itself lives in the KeyShortcutManager; here we only attach handlers for the
 * conversation-level commands, which need the live session. Other commands
 * (undo/redo, zoom, strategy-switch) register themselves from the components
 * that own them.
 * @module services/shortcut-bindings
 */

import keyShortcutManager from './key-shortcut-manager.js';
import {
  createNewConversation,
  binActiveConversation,
  renameActiveConversation,
  jumpToAttentionConversation,
  toggleActiveFileEditing,
} from './conversation-commands.js';
import { markSeen } from './tips-manager.js';
import findBar from '../components/find-bar.js';

/**
 * Register the conversation command handlers and install the global dispatcher.
 * Idempotent: re-registering (e.g. on reconnect with a fresh session) simply
 * rebinds the handlers to the current session.
 *
 * Learn-by-doing: a shortcut whose id also names an onboarding tip retires that
 * tip the moment the user actually uses the key — so a user already fluent with
 * ⌘J/⌘N/etc. is never told about it. For commands that report whether they acted
 * (jump/toggle), we only retire on a real action, so an inapplicable press (no
 * flagged conversation) doesn't spend the tip.
 * @param {import('../model/session.js').default} session
 * @returns {void}
 */
export function registerConversationShortcuts(session) {
  // new/bin always "handle" the key (they attempt on the visible conversation);
  // jump/toggle report whether they acted so an inapplicable press falls through.
  keyShortcutManager.register('new-conversation', () => { createNewConversation(); markSeen('new-conversation'); return true; });
  keyShortcutManager.register('bin-conversation', () => { binActiveConversation(); markSeen('bin-conversation'); return true; });
  keyShortcutManager.register('rename-conversation', () => { renameActiveConversation(); return true; });
  keyShortcutManager.register('jump-to-attention', () => {
    const acted = jumpToAttentionConversation(session);
    if (acted) markSeen('jump-to-attention');
    return acted;
  });
  keyShortcutManager.register('toggle-file-editing', () => {
    const acted = toggleActiveFileEditing(session);
    if (acted) markSeen('toggle-file-editing');
    return acted;
  });
  // Find-in-conversation opens/refocuses the find bar against the active
  // conversation-area column (the focused column of the visible tab). ⌘F never
  // closes — it opens if closed and focuses+selects-all if already open, so
  // repeated presses behave like the platform find field (Esc / ✕ close). Falls
  // through (returns false) when there's no conversation column to search, so
  // the browser's native find still works on empty/project-picker views.
  keyShortcutManager.register('find-in-conversation', () => {
    const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
    const column = tab?.getActiveConversationColumn?.();
    if (!column) return false;
    findBar.open(column);
    return true;
  });
  keyShortcutManager.install();
}
