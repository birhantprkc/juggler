//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Thread command - create an empty thread (sub-conversation)
 *
 * Creates a new empty thread and opens it as a new column.
 * The user can then interact with the thread directly.
 */
class ThreadCommandType extends CommandType {
  static MANIFEST = {
    id: 'thread',
    name: 'New Thread',
    version: '1.0.0',
    description: 'Create a new sub-conversation thread',
    icon: 'icon-thread',
    mutatesConversation: true,
    rejectWhileBusy: true
  };

  /**
   * Execute the thread command
   * @param {string[]} args - Command arguments (optional goal text)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(args) {
    // Parse flags
    const hasDraftMessage = args.includes('--draft-message');
    let draftMessage = '';
    let filteredArgs;
    if (hasDraftMessage) {
      const idx = args.indexOf('--draft-message');
      draftMessage = args.slice(idx + 1).join(' ').trim();
      filteredArgs = args.slice(0, idx);
    } else {
      filteredArgs = [...args];
    }
    const goal = filteredArgs.join(' ').trim() || 'New Thread';

    // Create thread message with optional draft.
    // strategyCreated marks this as a user-initiated thread (not LLM tool-created),
    // so the Go worker does not auto-resume the root conversation when it completes.
    // Threads always run isolated: the new thread owns its own context and does
    // not see the parent conversation.
    // canSpawnThreads marks a user-driven thread whose LLM may itself use
    // create_thread; every other creation path omits it and the worker withholds
    // the tool (see filterToolsForThread in llm_request.go).
    const extra = /** @type {any} */ ({ strategyCreated: true, canSpawnThreads: true });
    // Seed the new thread's draft as a {text, attachments} record (the single
    // draft object the input box reads), not a bare string.
    if (draftMessage) extra.draft = { text: draftMessage, attachments: [] };
    const result = this.messageThread?.createSubThread({
      goal,
      index: this.items.length,
      extra
    });

    return {
      handled: true,
      sideEffects: [{ type: 'openThread', data: { threadId: result?.threadId } }]
    };
  }
}

export default ThreadCommandType;
