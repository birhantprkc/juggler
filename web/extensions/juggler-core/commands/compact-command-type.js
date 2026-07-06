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
  defaultSummarizationPrompt
} from 'juggler/model';
import { createThreadMessage, createUserMessage } from 'juggler/model';

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
      const items = this.items;

      // Blocklist by persistence, not allowlist by type. Anything tagged
      // `preventUserDeletion` is a sticky parent-level setting (today only
      // the system-prompt) and stays put — the new thread inherits it from
      // the parent at LLM-call time. Everything else is part of the
      // conversation the user wants to fold up: regular messages, tool
      // actions, meta-tool-results, thinking, AND dynamic context items
      // the LLM produced during the conversation (plans, rules-snippets,
      // files etc.). An allowlist over message types misses that last
      // category and leaves orphans at the parent ("first and last items
      // not moved into the sub-thread" → those were context items
      // produced by tools).
      //
      // The one exception is the *leading* run of pinned file-content
      // context items — the project's ambient instruction files
      // (CLAUDE.md / AGENTS.md / …) that the session auto-loads at the top
      // of every conversation (see Session.addAIAssistantFiles). Those are
      // working context, not conversation history: sweeping them into the
      // sub-thread leaves the parent without its agents files after the
      // summary lands, which is never what the user expects. We keep them
      // at the parent. The summarization turn still sees them unchanged
      // because the worker always sources context items from the ROOT items
      // array regardless of which thread it is processing
      // (ConversationDocument.GetContextItemIDs reads root; the render-context
      // callback reads conv.rootMessageThread.contextItems), so the
      // prompt-cache prefix is preserved during compaction. Only the leading
      // run is preserved — a file
      // pinned mid-conversation is part of the work being folded up and is
      // swept like any other item.
      /** @type {object[]} */
      const snapshots = [];
      /** @type {number[]} */
      const indicesToDelete = [];
      let inLeadingContext = true;
      items.forEach((item, idx) => {
        if (!item || typeof item.toJSON !== 'function') return;
        if (item.get?.('preventUserDeletion') === true) return;
        // Leading agents-file pins stay at the parent (see above). A
        // preventUserDeletion item above doesn't end the leading run, so the
        // system-prompt placeholder at index 0 is transparent here.
        if (
          inLeadingContext &&
          item.get?.('itemId') &&
          !item.get?.('toolUseId') &&
          item.get?.('type') === 'file-content'
        ) return;
        // First conversational item reached: everything from here on is
        // folded into the thread, including any later file-content pins.
        inLeadingContext = false;
        // Defensive: a thread we ourselves just inserted is content by
        // type but must not be re-swallowed.
        if (
          item.get?.('noAutoSelect') &&
          item.get?.('type') === 'thread' &&
          !item.get?.('result')
        ) return;
        snapshots.push(item.toJSON());
        indicesToDelete.push(idx);
      });

      if (snapshots.length === 0) {
        return { handled: true, message: 'Nothing to compact', error: true };
      }

      const threadMsg = createThreadMessage({ goal: 'Compacted conversation history' });
      /** @type {any} */ (threadMsg).needsStrategyRun = true;
      // The user did not ask to drill into the new thread — they just want
      // their conversation to compact in-place.
      /** @type {any} */ (threadMsg).noAutoSelect = true;
      // Force the summarization turn to call return_result rather than replying
      // in plain text. `forceTool` is the generic framework mechanism (any plugin
      // may set it on a thread it creates); the worker translates it into a
      // provider tool_choice. Providers without forced-tool support (claudecode)
      // fall back to the plain-text → writeThreadResult path.
      /** @type {any} */ (threadMsg).forceTool = 'return_result';

      const userMsg = createUserMessage(defaultSummarizationPrompt(snapshots.length));

      // Insert position: where the first content item was (so the thread
      // lands among the content, not before context items at index 0).
      const insertAt = /** @type {number} */ (indicesToDelete[0]); // bounded: snapshots.length>0 guard guarantees ≥1 index

      // Single Yjs transaction so undo reverses everything atomically.
      mt.transact(() => {
        const threadYMap = mt.buildThreadYMap(threadMsg, [...snapshots, userMsg]);

        for (let i = indicesToDelete.length - 1; i >= 0; i--) {
          mt.deleteAt(/** @type {number} */ (indicesToDelete[i])); // bounded by loop
        }

        mt.insertAt(insertAt, threadYMap);
      });

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
