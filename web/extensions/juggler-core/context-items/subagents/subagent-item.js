//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { effortInstruction, thoroughnessSchema } from './thoroughness.js';
import strategyRegistry from '../../../../js/registries/strategy-registry.js';

/**
 * What one sub-agent is, stated as data.
 *
 * Everything structural about a sub-agent tool — the shape of its schema, that
 * it always delegates, that it pins its own strategy, that its inline path only
 * explains itself — is identical across sub-agents and lives in
 * {@link SubagentContextItem}. What genuinely differs is the wording a caller
 * reads and the strategy the child runs under, which is all this descriptor is.
 * @typedef {object} SubagentDescriptor
 * @property {string} tool - Tool name, e.g. 'Explore'
 * @property {typeof import('juggler/strategy-type').default} strategy - The hidden strategy the child runs under
 * @property {{color: string, icon?: string}} badge - Badge colour and icon for the item card
 * @property {string} description - What the tool is for and when to reach for it, minus the self-contained clause every sub-agent shares
 * @property {string} goalExample - A few words in the shape of a good `goal`, e.g. 'Trace auth flow'
 * @property {string} task - Description of the `task` argument: what a good one contains for this agent
 * @property {string} continues - What a session continues, completing "to continue that same …" (e.g. 'investigation')
 * @property {string} lead - Opening line of the child's seed, above the task
 * @property {string} resultSpec - The child's return contract, completing "Your final message must contain …"
 * @property {{pending: string, done: string}} verbs - Status-line wording while running and once finished
 * @property {string} fallback - What the caller should do by hand when delegation was impossible
 */

/**
 * Shared base for the sub-agent context items: a tool whose every call runs as a
 * delegated child thread under a strategy the item owns, returning only the
 * child's final message.
 *
 * A sub-agent has exactly one degree of freedom worth exposing — how much effort
 * to spend, see `thoroughness.js` — so two sub-agents differ only in their
 * wording and their strategy. Those are the {@link SubagentDescriptor}; the
 * behaviour is here, once, and a third sub-agent is a descriptor rather than
 * another copy of this file.
 *
 * Subclasses declare a `MANIFEST` (the registry requires one per class, and it
 * must set `delegatesToSubthread: true`) and a `static SUBAGENT` descriptor.
 * Nothing else.
 * @augments ContextItem
 * @abstract
 */
export default class SubagentContextItem extends ContextItem {
  /**
   * The descriptor. Subclasses define it; this class has none, which is what
   * makes it abstract.
   * @type {SubagentDescriptor|undefined}
   */
  static SUBAGENT;

  /**
   * The descriptor, or a failure that names the class that forgot it.
   * @returns {SubagentDescriptor} This sub-agent's descriptor
   * @throws {Error} When a subclass declares no SUBAGENT
   * @protected
   */
  static descriptor() {
    const descriptor = this.SUBAGENT;
    if (!descriptor) {
      throw new Error(`${this.name} extends SubagentContextItem but defines no static SUBAGENT descriptor`);
    }
    return descriptor;
  }

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return this.descriptor().badge;
  }

  /**
   * The hidden strategy this item owns — the sub-agent's tool filter, approval
   * policy and brief. Registered (forced hidden) when the item registry loads.
   * @override
   * @returns {Array<typeof import('juggler/strategy-type').default>} The owned strategy
   */
  static getStrategies() {
    return [this.descriptor().strategy];
  }

  /**
   * The one tool this item provides.
   *
   * `goal` is separate from `task` because they are read by different audiences:
   * `goal` is a label a human scans in a list, `task` is the entire brief the
   * child works from. Collapsing them yields either an unreadable label or a
   * starved child. `resultSpec` is deliberately absent — the pre-shaped return
   * contract is what a sub-agent adds over a bare `create_thread`.
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    const { tool, description, goalExample, task, continues } = this.descriptor();

    return [
      {
        name: tool,
        category: 'read',
        description: `${description}\nThe task must be self-contained: the sub-agent sees nothing of this conversation.`,
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: `Very short, single-line, user-facing label shown on the item card and thread header. Aim for a few words (for example, "${goalExample}"). Do not put the task or the return requirements here.`
            },
            task: {
              type: 'string',
              description: task
            },
            session: {
              type: 'string',
              description: `Optional ${tool} session name returned by an earlier call. Set it to continue that same ${continues} with this task; omit it to start a fresh session.`
            },
            thoroughness: thoroughnessSchema()
          },
          required: ['goal', 'task']
        }
      }
    ];
  }

  /**
   * Validate and normalize parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    for (const key of ['goal', 'task']) {
      const value = toolInput[key];
      if (typeof value !== 'string' || !value.trim()) {
        return { valid: false, error: `Missing required parameter: ${key}` };
      }
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Seed the delegated run. Always returns a spec — calling a sub-agent IS the
   * delegation; there is no meaningful inline behaviour to fall back to.
   *
   * The strategy is pinned only when it is actually registered. A user who has
   * disabled this extension's strategies still gets a working (if unfiltered)
   * child under the caller's own strategy, rather than a tool that fails.
   * @override
   * @param {Record<string, unknown>} toolInput - Validated tool input
   * @returns {import('juggler/context-item').SubthreadSpec} The child's seed
   */
  buildSubthreadSpec(toolInput) {
    const { lead, resultSpec, strategy } = /** @type {typeof SubagentContextItem} */ (this.constructor).descriptor();
    const strategyId = strategy.MANIFEST.id;

    /** @type {import('juggler/context-item').SubthreadSpec} */
    const spec = {
      goal: String(toolInput.goal).trim(),
      prompt: `${lead}\n\n# Task\n${String(toolInput.task).trim()}\n\n${effortInstruction(toolInput.thoroughness)}`,
      resultSpec,
      sessionName: toolInput.session ? String(toolInput.session).trim() : undefined
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
    const { tool, fallback } = /** @type {typeof SubagentContextItem} */ (this.constructor).descriptor();
    throw new Error(`${tool} runs as a sub-agent and could not be delegated here (nesting limit reached). ${fallback}`);
  }

  /**
   * Get status UI configuration.
   * @override
   * @param {import('../../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const { tool, verbs } = /** @type {typeof SubagentContextItem} */ (this.constructor).descriptor();
    const task = String(toolInput?.task || '');
    return this.buildStatusUI(actionStatus, {
      typeName: tool,
      pending: task || verbs.pending,
      success: () => task || verbs.done,
      failurePrefix: tool
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
