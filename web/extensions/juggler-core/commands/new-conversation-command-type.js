//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from 'juggler/ui';

/**
 * New Conversation command — open a fresh, empty conversation in a new tab and
 * switch to it.
 *
 * This is a tab-level operation: it creates an independent conversation rather
 * than mutating the current one, so it deliberately does NOT set
 * `mutatesConversation` — opening a new tab must never cancel a turn running in
 * the current tab. Tab management is a Session concern, so the command reaches
 * the session through `messageThread.conversation.session` (the same surface
 * the duplicate/compact-new commands use).
 */
class NewConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'new',
    name: 'New Conversation',
    version: '1.0.0',
    description: 'Open a new, empty conversation in a new tab',
    icon: 'icon-document'
  };

  /**
   * Execute the new-conversation command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const session = this.messageThread?.conversation?.session;
    if (!session) {
      return { handled: true, message: 'No session available', error: true };
    }

    try {
      // Empty name → session assigns the canonical "Task N". activate switches
      // the new tab into view immediately.
      await session.createConversation('', { activate: true, origin: 'slash-command' });
      return { handled: true };
    } catch (error) {
      return {
        handled: true,
        message: `Failed to create conversation: ${extractErrorMessage(error)}`,
        error: true
      };
    }
  }
}

export default NewConversationCommandType;
