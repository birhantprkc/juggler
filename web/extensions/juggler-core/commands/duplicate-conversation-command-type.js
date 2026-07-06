//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { extractErrorMessage } from '../../../sdk/lib/error-utils.js';

/**
 * Duplicate Conversation command — clone the current conversation into a new
 * tab placed directly after the source, then switch to the clone. The source
 * is left intact.
 *
 * `mutatesConversation` is set so the handler settles the source
 * (`cancelAndSettle`) before the clone is taken: duplicating mid-turn would
 * otherwise copy a `state: 'running'` item into a tab whose worker will never
 * flip it to completed/cancelled. Settling first guarantees a clean clone.
 *
 * Tab management is a Session concern, so the command reaches the session
 * through `messageThread.conversation.session`. `/compact-new` used to be
 * "duplicate then compact"; with this command that composition is just
 * `/duplicate` followed by `/compact`.
 */
class DuplicateConversationCommandType extends CommandType {
  static MANIFEST = {
    id: 'duplicate',
    name: 'Duplicate Conversation',
    version: '1.0.0',
    description: 'Clone this conversation into a new tab',
    icon: 'icon-box',
    mutatesConversation: true
  };

  /**
   * Execute the duplicate command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const sourceConversation = this.messageThread?.conversation;
    const session = sourceConversation?.session;
    if (!session) {
      return { handled: true, message: 'No session available', error: true };
    }

    try {
      const newId = await session.duplicateConversation(sourceConversation.id);
      if (!newId) {
        return { handled: true, message: 'Failed to duplicate conversation', error: true };
      }
      session.switchConversation(newId);
      return { handled: true };
    } catch (error) {
      return {
        handled: true,
        message: `Duplication failed: ${extractErrorMessage(error)}`,
        error: true
      };
    }
  }
}

export default DuplicateConversationCommandType;
