//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { shellKill } from 'juggler/ops';

/**
 * TaskStopContextItem — stop a background task started by `Monitor` or by `bash`
 * with `run_in_background`. Halts the process and (for a monitor) ends the
 * stream of events into the conversation.
 *
 * Exposes two interchangeable tool names for the same operation: `TaskStop`
 * (param `task_id`) and `KillShell` (param `shell_id`). Either name resolves to
 * this item, so a caller can use whichever name/param it prefers.
 * @class
 * @augments ContextItem
 */
class TaskStopContextItem extends ContextItem {
  static MANIFEST = {
    id: 'task-stop',
    name: 'Task Stop',
    version: '1.0.0',
    description: 'Stop a background task',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'execute', icon: 'icon-terminal' };
  }

  /** @returns {string} Short type label */
  static getTypeName() {
    return 'TaskStop';
  }

  /**
   * Stopping an already-stopped task is a no-op — re-running changes nothing,
   * so offer no "Re-run" control.
   * @returns {boolean} False — re-running this item type is a no-op.
   */
  static isRerunnable() {
    return false;
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'TaskStop',
        category: 'write',
        description: 'Stop a running background task by id (started by Monitor or by bash with run_in_background). For a monitor, this also ends the stream of events into the conversation.',
        input_schema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The task id returned when the background task was started.'
            }
          },
          required: ['task_id']
        }
      },
      {
        name: 'KillShell',
        category: 'write',
        description: 'Kill a running background shell (or monitor) by its shell id. Alias of TaskStop.',
        input_schema: {
          type: 'object',
          properties: {
            shell_id: {
              type: 'string',
              description: 'The shell/task id returned when the background task was started.'
            }
          },
          required: ['shell_id']
        }
      }
    ];
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    // TaskStop uses `task_id`; the KillShell alias uses `shell_id`. Accept either.
    const id = toolInput.task_id || toolInput.shell_id;
    if (!id || typeof id !== 'string') {
      return { valid: false, error: 'Missing required parameter: task_id (or shell_id)' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<Record<string, unknown>>} Kill result
   */
  async execute(params) {
    const id = /** @type {string} */ (params.task_id || params.shell_id);
    const result = await shellKill({ shell_id: id });
    return /** @type {Record<string, unknown>} */ (result);
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return { summary: outcome.error || 'Failed to stop task', details: '', success: false, icon: '✗' };
    }
    const result = /** @type {{shell_id?: string, killed?: boolean, error?: string}} */ (outcome.result);
    if (result.killed) {
      return { summary: `Stopped task ${result.shell_id || ''}.`, details: '', success: true, icon: '✓' };
    }
    return { summary: `Task ${result.shell_id || ''} was not stopped: ${result.error || 'not running'}.`, details: '', success: true, icon: '✓' };
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) return null;
    const taskId = String(toolInput?.task_id || toolInput?.shell_id || '');
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `Stopping ${taskId}...`;
      status = 'running';
    } else if (actionStatus.success) {
      summary = `Stopped ${taskId}`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, 'Failed to stop task'));
    }
    return { typeName: TaskStopContextItem.getTypeName(), summary, status };
  }

  /**
   * Render the properties-panel detail view. Without this the panel falls back
   * to dumping the raw input as JSON; instead show the target id as a labeled
   * property. Accepts either `task_id` (TaskStop) or `shell_id` (KillShell).
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {void}
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    const id = String(input.task_id || input.shell_id || '');
    helpers.addSubsection(wrapper, 'Task', id, 'properties-panel-code');
  }
}

export default TaskStopContextItem;
