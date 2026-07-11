//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { writeUserCommand, USER_COMMAND_NAME_RE } from '../../../js/services/user-commands.js';

/**
 * DefineCommandContextItem — lets the assistant create a user-defined slash
 * command on the user's behalf.
 *
 * The `define_command` tool writes a `.juggler/commands/<name>.md` file through
 * the same validated backend endpoint the editor dialog uses, so a saved command
 * is immediately available as `/name` (the file watcher hot-reloads the menu).
 * The tool ALWAYS requires approval and the approval card shows the full
 * definition (name, run mode, and the complete prompt template) — the user must
 * see exactly what prompt they are installing before it is written.
 * @class
 * @augments ContextItem
 */
class DefineCommandContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'meta', icon: 'icon-slash' };
  }

  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'define-command',
    name: 'Define Command',
    version: '1.0.0',
    description: 'Create a user-defined slash command',
    author: 'Juggler Team',
    // Always gated behind approval: the user must see the full template before
    // a command that will send arbitrary prompts is installed.
    requiresApproval: true,
    userAddable: false,
  };

  /** Allowed run modes for a defined command. */
  static RUN_MODES = ['send', 'draft', 'subthread'];

  /**
   * Tool definition for define_command.
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'define_command',
        category: 'meta',
        description:
          'Create a user-defined slash command the user can invoke with /name. Use when the user asks ' +
          'to save, name, or repeat a prompt or workflow as a reusable command. The command is a prompt ' +
          'template: use $1..$9 for positional arguments and $ARGUMENTS for everything after the command ' +
          'name. Always requires the user to approve the full definition before it is written.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Command name (the /name), lowercase letters, digits and hyphens, starting with a letter',
            },
            description: {
              type: 'string',
              description: 'One-line description shown in the slash menu',
            },
            template: {
              type: 'string',
              description: 'The prompt template. Use $1..$9 for positional args and $ARGUMENTS for the full argument string.',
            },
            run: {
              type: 'string',
              enum: DefineCommandContextItem.RUN_MODES,
              description: 'How invoking the command behaves: send immediately (default), insert as a draft, or run in a sub-thread',
            },
            argsHint: {
              type: 'string',
              description: 'Optional hint text describing the expected arguments (e.g. "<pr-number>")',
            },
            strategy: {
              type: 'string',
              description: 'Optional strategy id override (subthread run mode only), e.g. "read-only"',
            },
            model: {
              type: 'string',
              description: 'Optional model id override (subthread run mode only)',
            },
            goal: {
              type: 'string',
              description: 'Optional sub-thread goal label (subthread run mode only)',
            },
            scope: {
              type: 'string',
              enum: ['user', 'project'],
              description: 'Where to store it: "project" (this project, git-shareable; default) or "user" (all your projects)',
            },
          },
          required: ['name', 'description', 'template'],
        },
      },
    ];
  }

  /**
   * Validate the tool input.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from the LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const name = typeof toolInput.name === 'string' ? toolInput.name.trim() : '';
    if (!USER_COMMAND_NAME_RE.test(name)) {
      return { valid: false, error: 'name must be lowercase letters, digits, and hyphens, starting with a letter' };
    }
    if (typeof toolInput.description !== 'string' || toolInput.description.trim() === '') {
      return { valid: false, error: 'description is required' };
    }
    if (typeof toolInput.template !== 'string' || toolInput.template.trim() === '') {
      return { valid: false, error: 'template is required' };
    }
    if (toolInput.run !== undefined && !DefineCommandContextItem.RUN_MODES.includes(/** @type {string} */ (toolInput.run))) {
      return { valid: false, error: 'run must be one of "send", "draft", or "subthread"' };
    }
    if (toolInput.scope !== undefined && toolInput.scope !== 'user' && toolInput.scope !== 'project') {
      return { valid: false, error: 'scope must be "user" or "project"' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Write the command via the backend PUT endpoint (the same validated path the
   * editor dialog uses). Falls back from project to user scope when no project
   * is open so a saved command is never silently lost.
   * @param {Record<string, any>} params - Validated params
   * @returns {Promise<{name: string, scope: string, path: string, run: string}>} Result
   */
  async execute(params) {
    const name = String(params.name).trim();
    const body = {
      description: String(params.description || '').trim(),
      argsHint: String(params.argsHint || '').trim(),
      run: params.run || 'send',
      strategy: params.run === 'subthread' ? String(params.strategy || '').trim() : '',
      model: params.run === 'subthread' ? String(params.model || '').trim() : '',
      goal: params.run === 'subthread' ? String(params.goal || '').trim() : '',
      icon: '',
      template: String(params.template),
    };

    /** @type {'user'|'project'} */
    let scope = params.scope === 'user' ? 'user' : 'project';
    let res = await writeUserCommand(scope, name, body);
    // No project open → the project scope is unavailable (a plain {error} 400).
    // Fall back to user scope so the command is never silently lost. Validation
    // failures come back as {errors} and would fail identically in either
    // scope, so they are not retried.
    if (!res.ok && scope === 'project' && res.status === 400 && !res.data?.errors) {
      scope = 'user';
      res = await writeUserCommand(scope, name, body);
    }
    if (!res.ok) {
      const msg = res.data?.errors
        ? Object.values(res.data.errors).join('; ')
        : (res.data?.error || `write failed (${res.status})`);
      throw new Error(msg);
    }
    return { name, scope: res.data?.scope || scope, path: res.data?.path || '', run: body.run };
  }

  /**
   * Format the outcome for the LLM tool_result and display.
   * @override
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return { summary: `Could not create command: ${outcome.error}`, details: '', success: false, icon: '✗' };
    }
    const r = /** @type {{name?: string, scope?: string}} */ (outcome.result || {});
    const where = r.scope === 'user' ? 'all projects' : 'this project';
    return { summary: `Created /${r.name} (${where}). Invoke it with /${r.name}.`, details: '', success: true, icon: '✓' };
  }

  /**
   * Status UI for the define-command tool action.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Execution status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) return null;
    const name = String(toolInput?.name || 'command');
    if (actionStatus.pending) {
      return { typeName: 'Define Command', summary: `Creating /${name}…`, status: /** @type {const} */ ('running') };
    }
    if (actionStatus.success) {
      return { typeName: 'Define Command', summary: `Created /${name}`, status: /** @type {const} */ ('success') };
    }
    const { summary, status } = this.resolveTerminalStatus(actionStatus);
    return { typeName: 'Define Command', summary, status };
  }
}

export default DefineCommandContextItem;
