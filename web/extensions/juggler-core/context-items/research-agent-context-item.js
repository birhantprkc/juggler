//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import ResearchSubagentStrategyType from './subagents/research-strategy.js';
import { effortInstruction, thoroughnessSchema } from './subagents/thoroughness.js';
import strategyRegistry from '../../../js/registries/strategy-registry.js';

/**
 * @typedef {object} ResearchParams
 * @property {string} goal - Short user-facing label for the research
 * @property {string} question - The self-contained question to answer
 * @property {string} [session] - Existing Research session to continue
 * @property {string} [thoroughness] - 'quick' | 'medium' | 'thorough'
 */

/**
 * ResearchAgentContextItem - the `Research` sub-agent.
 *
 * Every call delegates: the question is answered by a child thread under a
 * hidden strategy this item owns (search + fetch, plus read-only local lookups),
 * and only its answer comes back. The multi-source loop — search, read five
 * pages, reconcile them against the version actually installed — is where a
 * caller's context normally dies; here it dies in the child instead.
 * @class
 * @augments ContextItem
 */
class ResearchAgentContextItem extends ContextItem {
  static MANIFEST = {
    id: 'research-agent',
    name: 'Research',
    version: '1.0.0',
    description: 'Answer a question from the web in a sub-agent context',
    author: 'Juggler Team',
    requiresApproval: false,
    // Always delegates: buildSubthreadSpec never returns null. The inline
    // execute() below exists only for the paths the worker can't delegate on
    // (nesting cap, engine round-trip failure), where it says so plainly.
    delegatesToSubthread: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  /**
   * The hidden strategy this item owns — the sub-agent's tool filter, approval
   * policy and brief. Registered (forced hidden) when the item registry loads.
   * @override
   * @returns {Array<typeof import('juggler/strategy-type').default>} The Research strategy
   */
  static getStrategies() {
    return [ResearchSubagentStrategyType];
  }

  /**
   * Get tool definitions for the Research action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    const description =
      'Answer a question from the web in a sub-agent context and get back only the answer. ' +
      'The sub-agent searches, reads as many pages as it needs, and checks what they say against the version actually installed in this project; none of those pages enter this conversation.\n' +
      'Use it when the answer takes several sources — API behaviour, what changed between versions, how a library is meant to be used. ' +
      'For one page you already know the URL of, `WebFetch` with a `prompt` is cheaper. Use `Explore` instead for questions about this codebase.\n' +
      'The question must be self-contained: the sub-agent sees nothing of this conversation.';

    return [
      {
        name: 'Research',
        category: 'read',
        description,
        input_schema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'Very short, single-line, user-facing label shown on the item card and thread header. Aim for a few words (for example, "Check React 20 changes"). Do not put the question or return requirements here.'
            },
            question: {
              type: 'string',
              description: 'What to find out, stated in full — including the library, version, or platform it concerns. The sub-agent shares your project but none of your conversation.'
            },
            session: {
              type: 'string',
              description: 'Optional Research session name returned by an earlier call. Set it to continue that same research with this question; omit it to start a fresh session.'
            },
            thoroughness: thoroughnessSchema()
          },
          required: ['goal', 'question']
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
    const params = /** @type {ResearchParams} */ (toolInput);
    if (typeof params.goal !== 'string' || !params.goal.trim()) {
      return { valid: false, error: 'Missing required parameter: goal' };
    }
    if (typeof params.question !== 'string' || !params.question.trim()) {
      return { valid: false, error: 'Missing required parameter: question' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Seed the delegated run. Always returns a spec — a Research call IS the
   * sub-agent; there is no meaningful inline behaviour to fall back to.
   *
   * The strategy is pinned only when it is actually registered, so a user who
   * has disabled this extension's strategies still gets a working (if
   * unfiltered) child under the caller's own strategy.
   * @override
   * @param {Record<string, unknown>} toolInput - Validated tool input
   * @returns {import('juggler/context-item').SubthreadSpec} The child's seed
   */
  buildSubthreadSpec(toolInput) {
    const params = /** @type {ResearchParams} */ (toolInput);
    const goal = String(params.goal).trim();
    const question = String(params.question).trim();
    const strategyId = ResearchSubagentStrategyType.MANIFEST.id;

    /** @type {import('juggler/context-item').SubthreadSpec} */
    const spec = {
      goal,
      prompt: `Research the following and answer it.\n\n# Question\n${question}\n\n${effortInstruction(params.thoroughness)}`,
      resultSpec:
          'the answer, with a source URL for each claim, and a note of anything that differs from ' +
          'the version installed in this project. Where you found nothing, say so explicitly rather than offering a plausible guess.',
      sessionName: params.session ? String(params.session).trim() : undefined
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
    throw new Error('Research runs as a sub-agent and could not be delegated here (nesting limit reached). Search the web directly with WebSearch and WebFetch.');
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const question = String(toolInput?.question || '');
    return this.buildStatusUI(actionStatus, {
      typeName: 'Research',
      pending: question || 'Researching…',
      success: () => question || 'Researched',
      failurePrefix: 'Research'
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
    if (input.question) helpers.addSubsection(wrapper, 'Question', String(input.question), 'properties-panel-code');
    if (input.thoroughness) helpers.addSubsection(wrapper, 'Thoroughness', String(input.thoroughness));
  }
}

export default ResearchAgentContextItem;
