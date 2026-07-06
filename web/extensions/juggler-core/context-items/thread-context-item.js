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
        description: 'Run a focused sub-task in an isolated sub-conversation. The thread cannot see this conversation, so its `prompt` must carry every fact it needs and state exactly what to return. This call returns only when the thread calls return_result — a plain text reply will not close it. Give the thread one self-contained task: never a task list, and never tell it to spawn its own threads (run further tasks as separate threads yourself).',
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'What this thread should accomplish'
            },
            prompt: {
              type: 'string',
              description: 'Initial prompt/instruction for the sub-conversation. Only the thread\'s final summary returns to you — its internal work is invisible — so state explicitly what the result must contain and in what form (which facts/paths/artifacts, and how to structure them).'
            },
            resultSpec: {
              type: 'string',
              description: 'The contract for what the thread must return: which facts, paths, or artifacts its final summary must contain, and how to structure them (e.g. "each match as `file:line — description`", "the final diff and nothing else"). Surfaced at the top of the thread and appended to its instructions so the summary comes back in the shape you need.'
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
      return {
        summary: outcome.error || 'Failed to create thread',
        details: '',
        success: false,
        icon: '✗'
      };
    }

    return {
      summary: 'Thread completed',
      details: '',
      success: true,
      icon: '▼'
    };
  }
}

export default ThreadContextItem;
