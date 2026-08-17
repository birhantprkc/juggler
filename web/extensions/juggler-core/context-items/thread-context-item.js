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
        description: 'Run one focused sub-task in an isolated sub-conversation. The child cannot see this conversation, so `prompt` must contain the complete task and all context it needs. Only its last message returns; use `resultSpec` to say what that message must contain and how it must be shaped. `goal` is only the short label shown in the UI. A thread outlives the call: every result opens with its session name, and passing that name back as `session` continues the same thread. Give each thread one self-contained task, never a task list, and never tell it to spawn its own threads.',
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'Very short, single-line, user-facing label for the item card and thread header. Aim for a few words (for example, "Trace auth flow"). Do not put instructions, background, or output requirements here.'
            },
            prompt: {
              type: 'string',
              description: 'Complete, self-contained task and instructions for the child. Include every relevant fact, path, symbol, decision, and constraint because it cannot see this conversation. Put the required shape of the final answer in `resultSpec`, not here.'
            },
            resultSpec: {
              type: 'string',
              description: 'Optional return contract for the child\'s last message: what facts or artifacts it must contain and how to structure them (for example, "each match as `file:line — description`" or "the final diff and nothing else"). Do not repeat the task or background.'
            },
            session: {
              type: 'string',
              description: 'Optional. The session name of a thread you already ran here: your prompt is appended to that thread and it carries on, keeping everything it has read and worked out. A name that matches nothing starts a new thread under it. Omit it to start a fresh thread.'
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
