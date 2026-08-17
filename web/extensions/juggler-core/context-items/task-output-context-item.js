//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { shellOutputDelta } from 'juggler/ops';

/**
 * TaskOutputContextItem — read the captured output of a background task started
 * by `Monitor` or by `bash` with `run_in_background`.
 * @class
 * @augments ContextItem
 */
class TaskOutputContextItem extends ContextItem {
  static MANIFEST = {
    id: 'task-output',
    name: 'Task Output',
    version: '1.0.0',
    description: 'Read output from a background task',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'execute', icon: 'icon-terminal' };
  }

  /** @returns {string} Short type label */
  static getTypeName() {
    return 'TaskOutput';
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'TaskOutput',
        category: 'read',
        description: 'Read a background task\'s status and NEW output since your last read (started by Monitor or by bash with run_in_background). Each call returns only output produced since the previous TaskOutput call for this task — NOT the whole log again — plus the exit code once finished. So polling a running task is cheap and never re-returns output you have already seen. To be told when a task finishes rather than polling, prefer an `until … done` guard in the background command (one completion notification) or the Monitor tool.',
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
      }
    ];
  }

  /**
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    if (!toolInput.task_id || typeof toolInput.task_id !== 'string') {
      return { valid: false, error: 'Missing required parameter: task_id' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<Record<string, unknown>>} Task output result
   */
  async execute(params) {
    const result = await shellOutputDelta({ task_id: /** @type {string} */ (params.task_id) });
    return /** @type {Record<string, unknown>} */ (result);
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to read task output');
    }
    const result = /** @type {{task_id?: string, status?: string, output?: string, exitCode?: number, error?: string}} */ (outcome.result);

    if (result.status === 'not_found') {
      return this.failureSummary(`Task ${result.task_id || ''} not found (it may have already finished and been reaped).`);
    }

    let summary = `Status: ${result.status || 'unknown'}`;
    if (result.exitCode !== undefined) summary += ` (exit code ${result.exitCode})`;
    summary += '\n\n' + (result.output || '(no new output since last read)');
    if (result.error) summary += `\n\n${result.error}`;

    return this.successSummary(this.truncateForLLM(summary));
  }

  /**
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const taskId = String(toolInput?.task_id || '');
    return this.buildStatusUI(actionStatus, {
      typeName: TaskOutputContextItem.getTypeName(),
      pending: `Reading output of ${taskId}...`,
      success: `Read output of ${taskId}`,
      failurePrefix: 'Failed to read task output'
    });
  }

  /**
   * @override
   * @returns {string} Section label
   */
  static getResultSectionLabel() {
    return 'Output';
  }

  /**
   * Render the properties-panel detail view. Without this the panel falls back
   * to dumping the raw `{task_id}` input as JSON; instead show the task id as a
   * labeled property. The captured output renders below in the shared Result
   * section (terminal-formatted via {@link rendersTerminalOutput}).
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {void}
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    helpers.addSubsection(wrapper, 'Task', String(input.task_id || ''), 'properties-panel-code');
  }

  /**
   * @override
   * @returns {boolean} Render terminal output with ANSI colours
   */
  static rendersTerminalOutput() {
    return true;
  }
}

export default TaskOutputContextItem;
