//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Clear command - clears conversation messages
 */
class ClearCommandType extends CommandType {
  static MANIFEST = {
    id: 'clear',
    name: 'Clear Conversation',
    version: '1.0.0',
    description: 'Clear conversation messages',
    danger: true,
    icon: 'icon-trashcan',
    mutatesConversation: true,
    // Wipe + re-seed of always-present auto items must revert as one undo.
    coalesceUndo: true
  };

  /**
   * Execute the clear command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    const mt = this.messageThread;
    mt?.clearHistory();
    // Re-seed the always-present auto items (AI assistant files + memory) so a
    // cleared conversation matches a freshly-created one. This is the same
    // single source of truth createConversation uses, so the two never drift.
    const conversation = mt?.conversation;
    await conversation?.session?.seedConversationAutoItems(conversation, mt);
    return {
      handled: true,
      message: 'Conversation cleared'
    };
  }
}

export default ClearCommandType;
