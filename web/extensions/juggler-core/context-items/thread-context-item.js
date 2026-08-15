//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';

/**
 * ThreadContextItem - UI rendering for the create_thread tool.
 *
 * Execution is handled by the Go worker (sync tool).
 * This plugin provides tool definitions, badge options, and summary formatting.
 * @class
 * @augments ContextItem
 */
class ThreadContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'thread', icon: 'icon-thread' };
  }

  /** @returns {string} Short type label shown on the item badge and panel header */
  static getTypeName() {
    return 'Thread';
  }

  static MANIFEST = {
    id: 'thread',
    name: 'Create Thread',
    version: '1.0.0',
    description: 'Create a nested sub-conversation (thread)',
    author: 'Juggler',
    requiresApproval: false,
    workerManaged: true // Execution handled by Go worker, not browser
  };

  /**
   * Get tool definitions for the create_thread action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'create_thread',
        category: 'write',
        description: 'Run a focused sub-task in an isolated sub-conversation. The thread cannot see this conversation, so its `prompt` must carry every fact it needs and state exactly what to return. The call returns when the thread comes to rest, and what comes back is its last message — so say what that message must contain. A thread outlives the call: every result opens with the thread\'s session name, and passing that name back as `session` puts your next prompt into the same thread, which still has everything it read and worked out. (A human may later open the thread and converse in it, but that is not a channel you take part in.) Give the thread one self-contained task: never a task list, and never tell it to spawn its own threads (run further tasks as separate threads yourself).',
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'What this thread should accomplish'
            },
            prompt: {
              type: 'string',
              description: 'Initial prompt/instruction for the sub-conversation. Only the thread\'s last message returns to you — its internal work is invisible — so state explicitly what that message must contain and in what form (which facts/paths/artifacts, and how to structure them).'
            },
            resultSpec: {
              type: 'string',
              description: 'The contract for what the thread must return: which facts, paths, or artifacts its last message must contain, and how to structure them (e.g. "each match as `file:line — description`", "the final diff and nothing else"). Surfaced at the top of the thread and appended to its instructions so the answer comes back in the shape you need.'
            },
            session: {
              type: 'string',
              description: 'Optional. The session name of a thread you already ran here: your prompt is appended to that thread and it carries on, keeping everything it has read and worked out — far cheaper than starting over, and the right way to ask a follow-up. A name that matches nothing starts a new thread under it. Omit it to start a fresh thread.'
            }
          },
          required: ['goal', 'prompt']
        }
      }
    ];
  }

  /**
   * Format result for display
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary} Display summary
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to create thread');
    }

    return this.successSummary('Thread completed', { icon: '▼' });
  }
}

export default ThreadContextItem;
