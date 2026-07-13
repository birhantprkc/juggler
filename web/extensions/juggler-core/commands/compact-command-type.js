//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import {
  getContentMessages,
  isCompactionPending,
  startCompaction,
  endCompaction,
  foldConversationIntoSummaryThread
} from 'juggler/model';

/**
 * Compact command — collapse the entire conversation into a sub-thread.
 *
 * Every content item is moved into a new thread; the thread carries a
 * summarization user message that the worker's strategy loop answers via
 * `return_result`. The conversation then contains exactly one thread tile
 * whose `result` is the summary. Standard Yjs undo reverses the transaction.
 */
class CompactCommandType extends CommandType {
  static MANIFEST = {
    id: 'compact',
    name: 'Compact',
    version: '1.0.0',
    description: 'Compact the entire conversation into a summary thread',
    icon: 'icon-compact',
    mutatesConversation: true
  };

  /**
   * Execute the compact command
   * @param {string[]} _args - Command arguments (unused)
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(_args) {
    if (!this.messageThread?.modelConfig) {
      return { handled: true, message: 'Please select a model before compacting', error: true };
    }

    const mt = /** @type {import('../../../js/model/message-thread.js').MessageThread} */ (this.messageThread);

    if (isCompactionPending(mt.conversationId)) {
      return { handled: true, message: 'Compaction already in progress', error: true };
    }

    const contentCount = getContentMessages(mt).length;
    if (contentCount === 0) {
      return { handled: true, message: 'Nothing to compact', error: true };
    }

    startCompaction(mt.conversationId);

    try {
      // The heavy lifting — the blocklist-by-persistence classification, the
      // leading-context-preservation rule, and the atomic fold-into-thread
      // transaction — lives in foldConversationIntoSummaryThread so /handoff
      // can reuse it verbatim. See that function for the full reasoning on why
      // standing context items (agents files, memory, system prompt) are kept
      // at the parent while all conversation history is swept into the thread.
      const folded = foldConversationIntoSummaryThread(mt, {
        goal: 'Compacted conversation history'
      });
      if (!folded) {
        return { handled: true, message: 'Nothing to compact', error: true };
      }

      return { handled: true };
    } catch (error) {
      const { extractErrorMessage: extractErr } = await import('juggler/ui');
      return {
        handled: true,
        message: `Compaction failed: ${extractErr(error)}`,
        error: true
      };
    } finally {
      endCompaction(mt.conversationId);
    }
  }
}

export default CompactCommandType;
