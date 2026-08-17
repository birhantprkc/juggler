//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import ExploreSubagentStrategyType from './subagents/explore-strategy.js';
import { effortInstruction, thoroughnessSchema } from './subagents/thoroughness.js';
import strategyRegistry from '../../../js/registries/strategy-registry.js';

/**
 * @typedef {object} ExploreParams
 * @property {string} task - The self-contained investigation to carry out
 * @property {string} [thoroughness] - 'quick' | 'medium' | 'thorough'
 */

/**
 * ExploreAgentContextItem - the `Explore` sub-agent.
 *
 * Every call delegates: the investigation runs as a child thread under a hidden
 * strategy this item owns (read tools + `bash`, no network, no writes), and only
 * the child's final answer comes back as the tool result. The dozen greps and
 * file reads it took never enter the caller's context, which is the whole point
 * — an open question like "how does auth work here" costs the caller one tool
 * result instead of thirty.
 * @class
 * @augments ContextItem
 */
class ExploreAgentContextItem extends ContextItem {
  static MANIFEST = {
    id: 'explore-agent',
    name: 'Explore',
    version: '1.0.0',
    description: 'Investigate this codebase in a sub-agent context',
    author: 'Juggler Team',
    requiresApproval: false,
    // Always delegates: buildSubthreadSpec never returns null. The inline
    // execute() below exists only for the paths the worker can't delegate on
    // (nesting cap, engine round-trip failure), where it says so plainly.
    delegatesToSubthread: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'thread', icon: 'icon-grep' };
  }

  /**
   * The hidden strategy this item owns — the sub-agent's tool filter, approval
   * policy and brief. Registered (forced hidden) when the item registry loads.
   * @override
   * @returns {Array<typeof import('juggler/strategy-type').default>} The Explore strategy
   */
  static getStrategies() {
    return [ExploreSubagentStrategyType];
  }

  /**
   * Get tool definitions for the Explore action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const description =
      'Investigate this codebase in a sub-agent context and get back only what it found. ' +
      'The sub-agent searches and reads with its own read-only tools; the files it opens never enter this conversation, so an open-ended question costs you one result instead of thirty tool calls.\n' +
      'Use it for questions that need reading and judgment — "how does auth work here", "what calls this and why", "where would a new X go". ' +
      'Use `query_code` instead when the answer is one you can compute in a script and want exactly; use `Research` instead when the answer is on the web (Explore has no network access).\n' +
      'The task must be self-contained: the sub-agent sees nothing of this conversation.';

    return [
      {
        name: 'Explore',
        category: 'read',
        description,
        input_schema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'What to find out, stated in full. The sub-agent shares your project but none of your conversation, so name the files, symbols, or behaviour you mean rather than referring to what was said here.'
            },
            thoroughness: thoroughnessSchema()
          },
          required: ['task']
        }
      }
    ];
  }

  /**
   * Validate and normalize parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {ExploreParams} */ (toolInput);
    if (typeof params.task !== 'string' || !params.task.trim()) {
      return { valid: false, error: 'Missing required parameter: task' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Seed the delegated run. Always returns a spec — an Explore call IS the
   * sub-agent; there is no meaningful inline behaviour to fall back to.
   *
   * The strategy is pinned only when it is actually registered. A user who has
   * disabled this extension's strategies still gets a working (if unfiltered)
   * child under the caller's own strategy, rather than a tool that fails.
   * @override
   * @param {Record<string, unknown>} toolInput - Validated tool input
   * @returns {import('juggler/context-item').SubthreadSpec} The child's seed
   */
  buildSubthreadSpec(toolInput) {
    const params = /** @type {ExploreParams} */ (toolInput);
    const task = String(params.task).trim();
    const strategyId = ExploreSubagentStrategyType.MANIFEST.id;

    /** @type {import('juggler/context-item').SubthreadSpec} */
    const spec = {
      goal: 'Explore',
      prompt: `Investigate this codebase and answer the following.\n\n# Task\n${task}\n\n${effortInstruction(params.thoroughness)}`,
      resultSpec:
        'the answer to the task; the evidence as a list of `file:line — what is there`; ' +
        'and the paths worth reading next. Say what you looked for and did not find rather than guessing.'
    };
    if (strategyRegistry.has(strategyId)) spec.strategyId = strategyId;
    return spec;
  }

  /**
   * Only reached when the call could NOT be delegated — the thread nesting cap,
   * or an engine round-trip that failed. There is no sensible inline version of
   * a sub-agent, so say what happened and hand the work back.
   * @override
   * @returns {Promise<Record<string, unknown>>} Never resolves
   * @throws {Error} Always
   */
  async execute() {
    throw new Error('Explore runs as a sub-agent and could not be delegated here (nesting limit reached). Search the code directly with grep, glob and read.');
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const task = String(toolInput?.task || '');
    return this.buildStatusUI(actionStatus, {
      typeName: 'Explore',
      pending: task || 'Exploring…',
      success: () => task || 'Explored',
      failurePrefix: 'Explore'
    });
  }

  /**
   * @override
   * @param {HTMLElement} wrapper - Details container
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {void}
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    if (input.task) helpers.addSubsection(wrapper, 'Task', String(input.task), 'properties-panel-code');
    if (input.thoroughness) helpers.addSubsection(wrapper, 'Thoroughness', String(input.thoroughness));
  }
}

export default ExploreAgentContextItem;
