//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createItem } from 'juggler/registry';
import { createElement } from 'juggler/ui';
import {
  createEmptyState
} from 'juggler/item-utils';
import { renderMarkdown } from 'juggler/ui';

// ============================================================================
// Plan Detail View Styles
// ============================================================================

const PLAN_STYLES = `
/* Plan Detail View */

.plan-detail-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.plan-detail-view .plan-header {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.plan-detail-view .plan-title {
  font-family: var(--font-sans);
  font-size: 1rem;
  font-weight: 600;
  color: var(--context-item-text, var(--text-primary));
  margin: 0;
}

.plan-detail-view .plan-status-badge {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.plan-detail-view .plan-status-badge.status-planning {
  background: rgb(88 166 255 / 15%);
  color: #58a6ff;
}

.plan-detail-view .plan-status-badge.status-approved {
  background: rgb(63 185 80 / 15%);
  color: #3fb950;
}

.plan-detail-view .plan-status-badge.status-executing {
  background: rgb(210 153 34 / 15%);
  color: #d29922;
}

.plan-detail-view .plan-status-badge.status-completed {
  background: rgb(63 185 80 / 15%);
  color: #3fb950;
}

/* Items List */

.plan-detail-view .plan-items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.plan-detail-view .plan-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.25rem 0;
}

/* Item Indicator */
.plan-detail-view .plan-item-indicator {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--context-item-text-secondary, var(--text-secondary));
}

.plan-detail-view .plan-item-indicator svg {
  width: 1.25rem;
  height: 1.25rem;
}

.plan-detail-view .plan-item.status-completed .plan-item-indicator svg {
  fill: #3fb950;
}

.plan-detail-view .plan-item.status-in_progress .plan-item-indicator svg {
  fill: #58a6ff;
}

.plan-detail-view .plan-item.status-failed .plan-item-indicator svg {
  fill: #f85149;
}

.plan-detail-view .plan-item.status-skipped .plan-item-indicator {
  color: var(--context-item-text-secondary, var(--text-secondary));
  opacity: 0.6;
}

/* Item Content */
.plan-detail-view .plan-item-content {
  flex: 1;
  min-width: 0;
}

.plan-detail-view .plan-item-text {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--context-item-text, var(--text-primary));
  margin: 0;
}

.plan-detail-view .plan-item-text p {
  margin: 0;
}

.plan-detail-view .plan-item-text code {
  background: rgb(255 255 255 / 10%);
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.plan-detail-view .plan-item.status-completed .plan-item-text {
  color: var(--context-item-text-secondary, var(--text-secondary));
}

.plan-detail-view .plan-item.status-skipped .plan-item-text {
  color: var(--context-item-text-secondary, var(--text-secondary));
  text-decoration: line-through;
  opacity: 0.6;
}

/* Step result summary — a distinct outcome card, not flowed-on text.
   A left accent bar + inset background separates it from the step
   description above; the accent colour is keyed to the step status. */
.plan-detail-view .plan-item-result {
  margin-top: 0.4375rem;
  padding: 0.375rem 0.5rem 0.375rem 0.625rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--context-item-text-secondary, var(--text-secondary));
  background: var(--overlay-light-5, rgb(255 255 255 / 5%));
  border-left: 0.1875rem solid var(--overlay-light-20, rgb(255 255 255 / 20%));
  border-radius: 0 var(--radius-sm, 0.1875rem) var(--radius-sm, 0.1875rem) 0;
}

.plan-detail-view .plan-item.status-completed .plan-item-result {
  border-left-color: var(--accent-green, #3fb950);
}

.plan-detail-view .plan-item.status-failed .plan-item-result {
  border-left-color: var(--accent-red, #f85149);
}

.plan-detail-view .plan-item.status-in_progress .plan-item-result {
  border-left-color: var(--accent-blue, #58a6ff);
}

/* Thread link icon */
.plan-detail-view .plan-item-thread-link {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.plan-detail-view .plan-item-thread-link:hover {
  opacity: 1;
}

.plan-detail-view .plan-item-thread-link svg {
  width: 0.875rem;
  height: 0.875rem;
  fill: #58a6ff;
}

/* Empty State */

.plan-detail-view .plan-empty {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--context-item-text-secondary, var(--text-secondary));
  font-size: 0.8125rem;
}

/* Action Bubble Variant (smaller padding for message context) */

.action-bubble .plan-detail-view {
  gap: 0.75rem;
}

.action-bubble .plan-detail-view .plan-title {
  font-size: 0.875rem;
}

.action-bubble .plan-detail-view .plan-item {
  padding: 0.5rem 0.75rem;
}

.action-bubble .plan-detail-view .plan-item-text {
  font-size: 0.75rem;
}
`;

// Inject styles once when loaded in a document-owning viewer. Engine workers
// import this module for tool execution and must not touch DOM globals.
if (typeof document !== 'undefined' && !document.getElementById('plan-styles')) {
  const style = document.createElement('style');
  style.id = 'plan-styles';
  style.textContent = PLAN_STYLES;
  document.head.appendChild(style);
}

/**
 * Plan step with status and thread tracking
 * @typedef {object} PlanStep
 * @property {string} content - Step description (markdown)
 * @property {'pending'|'in_progress'|'completed'|'failed'|'skipped'} status - Step status
 * @property {string|null} threadItemId - Links to the sub-thread that executed this step
 * @property {string|null} result - Summary from step completion
 */

/**
 * Plan data structure
 * @typedef {object} PlanData
 * @property {string} title - Plan title
 * @property {'planning'|'approved'|'executing'|'completed'} status - Plan-level status
 * @property {PlanStep[]} steps - List of plan steps with status
 */

/**
 * @typedef {object} SubmitPlanParams
 * @property {string} title - Plan title
 * @property {PlanStep[]} items - List of plan steps (named 'items' in tool input, stored as 'steps' in data)
 */

/**
 * @typedef {object} SubmitPlanResult
 * @property {boolean} approved - Whether the plan was approved
 * @property {string} title - Plan title
 * @property {number} stepCount - Number of steps in the plan
 * @property {boolean} [breakLoop] - Signal to stop the current strategy loop
 */

/**
 * @typedef {object} StepActionResult
 * @property {number} index - 0-based index of updated step
 * @property {string} oldStatus - Previous status
 * @property {string} newStatus - New status
 * @property {string|null} [result] - Step result summary
 * @property {string|null} [threadItemId] - Thread item ID
 * @property {number} completed - Total completed steps
 * @property {number} total - Total steps
 * @property {{title: string, status: string, steps: Array<{content: string, status: string, result: string|null}>}} planSnapshot - Plan state snapshot at execution time
 */

/**
 * PlanContextItem - Manages implementation plans with step tracking and sub-thread orchestration.
 *
 * Unified plugin: serves as both persistent context item (plan data, UI, LLM context)
 * and action handler (plan tool for submitting plans and managing step lifecycle).
 *
 * Tool actions via `action` parameter:
 * - "submit": Displays the plan for user review. On approval, sets status to 'approved'.
 * - "start_step": Mark a step as in_progress.
 * - "complete_step": Mark a step as completed with result summary.
 * - "fail_step": Mark a step as failed with error info.
 * - "skip_step": Mark a step as skipped.
 * @class
 * @augments ContextItem
 */
class PlanContextItem extends ContextItem {
  /**
   * Context item manifest
   * @static
   * @type {import('juggler/context-item').ContextItemManifest}
   */
  static MANIFEST = {
    id: 'plan',
    name: 'Plan',
    version: '4.0.0',
    description: 'Implementation plan with step tracking and sub-thread orchestration',
    author: 'Juggler Team',
    requiresApproval: true,
    contextPosition: 'user',
    syntheticToolName: 'plan',
    exampleData: {
      title: 'Implement User Authentication',
      status: 'executing',
      steps: [
        { content: 'Create user model in `models/user.js`', status: 'completed', threadItemId: null, result: 'Created User model with email and password fields' },
        { content: 'Add login endpoint in `routes/auth.js`', status: 'in_progress', threadItemId: null, result: null },
        { content: 'Write tests in `tests/auth.test.js`', status: 'pending', threadItemId: null, result: null }
      ]
    }
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'plan', icon: 'icon-checklist' };
  }

  /**
   * Re-running a plan-action must re-prompt rather than silently replay the
   * prior outcome. A "submit" action's result IS the user's approval decision,
   * so re-running it has to ask for that approval again — the same reasoning as
   * AskUserQuestion, whose result is the user's answer. The full reset routes
   * back through the new-tool-action flow, which re-derives the correct state
   * per action: "submit" returns to its pending approval, while the
   * auto-permitted step actions (start_step/complete_step/…) re-run directly.
   * @override
   * @returns {boolean} Always true
   */
  static rerunRequiresReprompt() {
    return true;
  }

  /**
   * Title for the properties-panel header / item card. The plan tool drives two
   * distinct operations: "submit" proposes (creates/replaces) the plan, while
   * the step actions change an existing plan. Label each for what it does so a
   * creation and an update aren't both just "plan".
   * @param {Record<string, unknown>} toolInput - Parsed tool input
   * @returns {string} Display title
   */
  static getToolActionTitle(toolInput) {
    return (toolInput?.action || 'submit') === 'submit' ? 'Plan' : 'Update plan';
  }

  // ============================================================================
  // TOOL DEFINITIONS (action interface)
  // ============================================================================

  static getToolDefinitions() {
    return [
      {
        name: 'plan',
        category: 'meta',  // meta = internal state only, doesn't modify files. Ensures MCP ReadOnlyHint=true
        description: 'Manage the implementation plan. Actions: "submit" to create/update plan for approval, "start_step" to begin a step, "complete_step" to finish a step, "fail_step" to mark failure, "skip_step" to skip.',
        input_schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['submit', 'start_step', 'complete_step', 'fail_step', 'skip_step'],
              description: 'Action to perform'
            },
            title: {
              type: 'string',
              description: 'Descriptive title for the plan (required for submit)'
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'What this step will accomplish. Supports markdown (use `backticks` for file paths and code).'
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
                    description: 'Initial status (usually pending)'
                  }
                },
                required: ['content']
              },
              description: 'List of plan steps (required for submit)'
            },
            index: {
              type: 'number',
              description: 'Step index, 1-based (required for start_step, complete_step, fail_step, skip_step)'
            },
            result: {
              type: 'string',
              description: 'Summary of what was accomplished (optional for complete_step, fail_step)'
            },
            threadItemId: {
              type: 'string',
              description: 'Thread item ID that executed this step (optional for complete_step)'
            }
          },
          required: ['action']
        }
      }
    ];
  }

  // ============================================================================
  // SINGLETON / MERGE
  // ============================================================================

  /**
   * Check if new params can be merged with an existing item
   *
   * Plan items are singletons - only one plan per conversation.
   * Reuse existing if one exists.
   * @static
   * @param {Record<string, any>} _newParams - Parameters for the new item request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null if no merge possible
   */
  static mergeOrReplace(_newParams, existingItems) {
    // Singleton pattern: reuse existing plan if one exists
    if (existingItems.length > 0) {
      return { action: 'reuse', item: /** @type {ContextItem} */ (existingItems[0]) }; // bounded: length>0
    }
    return null; // Create new
  }

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  /**
   * Create a new PlanContextItem instance
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // Initialize plan data if not present
    if (!this.data.title) {
      this.data.title = '';
    }
    if (!this.data.status) {
      this.data.status = 'planning';
    }
    if (!this.data.steps) {
      this.data.steps = [];
    }
  }

  // ============================================================================
  // CONTEXT ITEM INTERFACE (data, UI, LLM context)
  // ============================================================================

  /**
   * Get item title
   * @returns {string} Item title
   */
  getTitle() {
    if (this.data.title) {
      return `Plan: ${this.data.title}`;
    }
    return 'Plan';
  }

  /**
   * Get brief summary string for item display
   * @returns {string} Brief summary
   */
  getBriefSummary() {
    const steps = this.data.steps || [];
    const total = steps.length;
    const completed = this._countByStatus('completed');

    if (total === 0) {
      return 'No steps';
    }

    return `${completed}/${total} completed`;
  }

  /**
   * Create properties panel view using plan-detail-view component
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'ci-expanded');

    const steps = this.data.steps || [];
    if (steps.length === 0) {
      const empty = createEmptyState('No plan steps yet', '');
      container.appendChild(empty);
      return container;
    }

    const section = document.createElement('properties-panel-subsection');
    section.appendChild(this._createPlanDetailView(this.data));
    container.appendChild(section);

    return container;
  }

  /**
   * Create context text for LLM
   * @param {object} contextParams - Runtime execution context
   * @param {number} [contextParams.budgetHint] - Optional token budget hint
   * @param {import('juggler/context-item').ModelConfig|null} [contextParams.modelConfig] - Model configuration
   * @param {typeof import("../../../sdk/lib/formatting-helpers.js").FormattingHelpers} contextParams.helpers - Formatting utilities
   * @returns {string} Context text wrapped in XML tags
   */
  createContextText(contextParams) {
    const { helpers } = contextParams;

    const steps = this.data.steps || [];
    if (steps.length === 0) {
      return '';
    }

    const total = steps.length;
    const completed = this._countByStatus('completed');
    const planStatus = this.data.status || 'planning';

    // Build content string for LLM context
    let content = `# Plan${this.data.title ? ': ' + this.data.title : ''}\n`;
    content += `Status: ${planStatus} | Progress: ${completed}/${total} completed\n\n`;

    // Steps with status, results, and thread links
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const status = step.status || 'pending';

      let statusIcon = '\u25CB'; // pending
      if (status === 'completed') {
        statusIcon = '\u2713';
      } else if (status === 'in_progress') {
        statusIcon = '\u25B6';
      } else if (status === 'failed') {
        statusIcon = '\u2717';
      } else if (status === 'skipped') {
        statusIcon = '\u2014';
      }

      let line = `${i + 1}. [${statusIcon}] ${step.content}`;

      if (step.threadItemId) {
        line += ` (thread: ${step.threadItemId})`;
      }

      content += line + '\n';

      if (step.result) {
        content += `   Result: ${step.result}\n`;
      }
    }

    const itemHeader = `=== ${this.id} ===\n`;
    return itemHeader + helpers.xml('plan', content);
  }

  /**
   * Set the plan data (called by strategy or action)
   * @param {object} planData - Plan data to set
   * @param {string} [planData.title] - Plan title
   * @param {'planning'|'approved'|'executing'|'completed'} [planData.status] - Plan status
   * @param {PlanStep[]} planData.steps - Plan steps
   */
  setPlan(planData) {
    this.data.title = planData.title || '';
    this.data.status = planData.status || this.data.status || 'planning';
    this.data.steps = planData.steps || [];
  }

  // ============================================================================
  // ACTION INTERFACE (tool validation, approval, execution, summary)
  // ============================================================================

  /**
   * Validate and normalize plan parameters
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const action = /** @type {string|undefined} */ (toolInput.action);

    if (!action) {
      return { valid: false, error: 'Missing required parameter: action' };
    }

    if (action === 'submit') {
      return this._validateSubmit(toolInput);
    }

    if (action === 'start_step') {
      return this._validateStepAction(toolInput, 'start_step');
    }

    if (action === 'complete_step') {
      return this._validateStepAction(toolInput, 'complete_step');
    }

    if (action === 'fail_step') {
      return this._validateStepAction(toolInput, 'fail_step');
    }

    if (action === 'skip_step') {
      return this._validateStepAction(toolInput, 'skip_step');
    }

    return { valid: false, error: `Unknown action: ${action}. Must be one of: submit, start_step, complete_step, fail_step, skip_step.` };
  }

  /**
   * Validate submit action parameters
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   * @private
   */
  async _validateSubmit(toolInput) {
    // Title: weaker models sometimes omit it or name it differently. A plan
    // without a title is still a usable plan, so default rather than reject.
    const rawTitle = toolInput.title ?? toolInput.name ?? toolInput.plan_title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : 'Implementation Plan';

    // Items: the tool param is `items`, but the stored shape, the PlanData
    // typedef, and the rendered plan context all call them `steps`, so a model
    // frequently sends `steps` (or `tasks`). Accept those aliases — mirrors the
    // id/item alias tolerance in _validateStepAction. May also arrive as a JSON
    // string (some LLMs stringify arrays).
    let items = PlanContextItem._resolvePlanItems(toolInput);
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        return { valid: false, error: 'Items parameter is not valid JSON' };
      }
    }

    if (!items || !Array.isArray(items)) {
      return { valid: false, error: 'Missing required parameter: items (must be array)' };
    }

    if (items.length === 0) {
      return { valid: false, error: 'Plan must have at least one step' };
    }

    // Validate each item and normalize to step format
    const normalizedSteps = [];
    for (const [i, item] of items.entries()) {
      const content = PlanContextItem._resolveStepContent(item);
      if (!content) {
        return { valid: false, error: `Step ${i} is missing content` };
      }
      normalizedSteps.push({
        content,
        status: item.status || 'pending',
        threadItemId: null,
        result: null
      });
    }

    return {
      valid: true,
      params: { action: 'submit', title, items: normalizedSteps }
    };
  }

  /**
   * Resolve the plan-items array from tool input, tolerating the aliases weaker
   * models emit for the `items` param (`steps`, `tasks`). Returns the raw value
   * (array, JSON string, or undefined); parsing/validation happens at the call site.
   * @param {Record<string, unknown>} toolInput - Raw tool input
   * @returns {unknown} The raw items value under whichever alias was present
   * @private
   */
  static _resolvePlanItems(toolInput) {
    return toolInput.items ?? toolInput.steps ?? toolInput.tasks;
  }

  /**
   * Resolve a step's content string, tolerating the field-name aliases weaker
   * models emit (`description`, `text`, `task`, `step`). The string guard keeps
   * a numeric `step` index from being mistaken for content.
   * @param {Record<string, unknown>} item - A raw plan item
   * @returns {string} The content string, or '' when none is present
   * @private
   */
  static _resolveStepContent(item) {
    if (!item || typeof item !== 'object') return '';
    const raw = item.content ?? item.description ?? item.text ?? item.task ?? item.step;
    return typeof raw === 'string' && raw.trim() ? raw : '';
  }

  /**
   * Validate step action parameters (start_step, complete_step, fail_step, skip_step).
   * @param {Record<string, unknown>} toolInput - Raw parameters
   * @param {string} action - The action type
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   * @private
   */
  async _validateStepAction(toolInput, action) {
    // `index` is declared as a number in the tool schema, so a string the LLM
    // emits is coerced at the shared prepare() boundary before we run — this
    // validator only enforces the semantic constraint. `id`/`item` are
    // undocumented aliases kept for resilience.
    const rawIndex = toolInput.index ?? toolInput.id ?? toolInput.item;
    if (rawIndex === undefined || rawIndex === null) {
      return { valid: false, error: 'Missing required parameter: index' };
    }

    if (!Number.isInteger(rawIndex) || /** @type {number} */ (rawIndex) < 1) {
      return { valid: false, error: `index must be a positive integer (1-based), got: ${rawIndex}` };
    }

    /** @type {Record<string, unknown>} */
    const params = { action, index: /** @type {number} */ (rawIndex) };

    // Optional result for complete_step and fail_step
    if ((action === 'complete_step' || action === 'fail_step') && toolInput.result) {
      params.result = String(toolInput.result);
    }

    // Optional threadItemId for complete_step
    if (action === 'complete_step' && toolInput.threadItemId) {
      params.threadItemId = String(toolInput.threadItemId);
    }

    return { valid: true, params };
  }

  /**
   * Build approval UI configuration for plan submission.
   * Only called for submit action (step actions don't require approval).
   * @override
   * @param {Record<string, unknown>} params - Validated params from validate()
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval config
   */
  async getApprovalConfig(params) {
    if (params.action !== 'submit') {
      return null; // No approval needed for step actions
    }

    const planParams = /** @type {SubmitPlanParams} */ (params);
    const planData = {
      title: planParams.title,
      status: 'planning',
      steps: planParams.items
    };

    return {
      title: `Plan: ${planParams.title}`,
      message: `${planParams.items.length} step${planParams.items.length !== 1 ? 's' : ''} - Review and approve to begin execution`,
      options: [
        { label: 'Approve', value: 'yes', style: 'primary' },
        { label: 'Discuss further', value: 'no', style: 'secondary' }
      ],
      display: { planData }
    };
  }

  /**
   * Check if this action is auto-permitted (skips approval).
   * Step actions don't need approval; submit actions do.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw tool input parameters
   * @returns {boolean} True if auto-approved (no approval needed)
   */
  isPermitted(toolInput) {
    return toolInput.action !== 'submit';
  }

  /**
   * Execute plan action
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<SubmitPlanResult|StepActionResult>} Action result
   */
  async execute(params) {
    switch (params.action) {
      case 'submit':
        return this._executeSubmit(params);
      case 'start_step':
        return this._executeStartStep(params);
      case 'complete_step':
        return this._executeCompleteStep(params);
      case 'fail_step':
        return this._executeFailStep(params);
      case 'skip_step':
        return this._executeSkipStep(params);
      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  }

  /**
   * Execute plan submission - update Plan context item, set status to approved
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<SubmitPlanResult>} Action result
   * @private
   */
  async _executeSubmit(params) {
    const planParams = /** @type {SubmitPlanParams} */ (params);

    // Remove old cancelled plan tool-actions (superseded by this new submission)
    const thread = this.messageThread;
    const items = thread.items;
    const cancelledIndices = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.get('type') === 'tool-action' &&
          item.get('toolName') === 'plan') {
        const result = item.get('result');
        const cancelled = result?.get ? result.get('cancelled') : result?.cancelled;
        if (cancelled === true) {
          cancelledIndices.push(i);
        }
      }
    }
    if (cancelledIndices.length > 0) {
      thread.removeItemsAt(cancelledIndices);
    }

    // Find or create Plan context item (may be a different instance from `this`
    // when called via the action executor, which creates ephemeral instances)
    const planContextItem = this._getOrCreatePlanContextItem();

    // Update the plan context item with submitted data
    planContextItem.setPlan({
      title: planParams.title,
      status: 'approved',
      steps: planParams.items
    });

    // Sync updated data back to Yjs (addContextItem updates existing Y.Map by itemId)
    this.messageThread.addContextItem(planContextItem);

    // Save session to persist the plan
    await this.session.save();

    return {
      approved: true,
      title: planParams.title,
      stepCount: planParams.items.length,
      breakLoop: true  // Signal to exit planning runLoop; run() will auto-continue to execution
    };
  }

  /**
   * Execute start_step - mark a step as in_progress
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeStartStep(params) {
    return this._updateStepStatus(params, 'in_progress');
  }

  /**
   * Execute complete_step - mark a step as completed with optional result/threadItemId
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeCompleteStep(params) {
    return this._updateStepStatus(params, 'completed');
  }

  /**
   * Execute fail_step - mark a step as failed with optional result
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeFailStep(params) {
    return this._updateStepStatus(params, 'failed');
  }

  /**
   * Execute skip_step - mark a step as skipped
   * @param {Record<string, unknown>} params - Validated params
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _executeSkipStep(params) {
    return this._updateStepStatus(params, 'skipped');
  }

  /**
   * Common step status update logic
   * @param {Record<string, unknown>} params - Validated params with index and optional result/threadItemId
   * @param {string} newStatus - New status to set
   * @returns {Promise<StepActionResult>} Step action result
   * @private
   */
  async _updateStepStatus(params, newStatus) {
    const oneBasedIndex = /** @type {number} */ (params.index);

    // Find existing plan context item
    const planContextItem = this.messageThread.contextItems.find(
      (/** @type {{type: string}} */ f) => f.type === 'plan'
    );

    if (!planContextItem) {
      throw new Error('No plan exists. Submit a plan first using action: "submit".');
    }

    const steps = planContextItem.data.steps || [];
    if (oneBasedIndex > steps.length) {
      throw new Error(`Invalid index: ${oneBasedIndex}. Plan has ${steps.length} steps (1-${steps.length}).`);
    }
    const index = oneBasedIndex - 1; // Convert to 0-based

    // Update step
    const step = steps[index];
    const oldStatus = step.status;
    step.status = newStatus;

    if (params.result) {
      step.result = /** @type {string} */ (params.result);
    }
    if (params.threadItemId) {
      step.threadItemId = /** @type {string} */ (params.threadItemId);
    }

    // Update plan-level status
    if (newStatus === 'in_progress' && planContextItem.data.status === 'approved') {
      planContextItem.data.status = 'executing';
    }

    // Check if all steps are terminal (completed, failed, or skipped)
    const allTerminal = steps.every((/** @type {PlanStep} */ s) =>
      s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
    );
    if (allTerminal) {
      planContextItem.data.status = 'completed';
    }

    // Persist mutated data back to the CRDT (contextItems creates transient wrappers)
    this.messageThread.addContextItem(planContextItem);

    // Save session to persist changes
    await this.session.save();

    const total = steps.length;
    const completed = steps.filter((/** @type {PlanStep} */ s) => s.status === 'completed').length;

    // Surface the step transition via the conversation's status spinner.
    this.conversation.setStatusMessage(
      `Step ${oneBasedIndex} \u2192 ${newStatus} (${completed}/${total} completed)`
    );

    return {
      index,
      oldStatus,
      newStatus,
      result: /** @type {string|null} */ (params.result || null),
      threadItemId: /** @type {string|null} */ (params.threadItemId || null),
      completed,
      total,
      planSnapshot: {
        title: planContextItem.data.title,
        status: planContextItem.data.status,
        steps: steps.map((/** @type {PlanStep} */ s) => ({ content: s.content, status: s.status, result: s.result || null }))
      }
    };
  }

  /**
   * Get existing Plan context item or create new one
   * @private
   * @returns {PlanContextItem} Plan context item instance
   */
  _getOrCreatePlanContextItem() {
    // Look for existing plan context item
    const existing = this.messageThread.contextItems.find(
      (/** @type {{type: string}} */ f) => f.type === 'plan'
    );

    if (existing) {
      return /** @type {PlanContextItem} */ (existing);
    }

    // Create new plan context item using the context item registry
    const contextItem = createItem({
      id: `PLAN_${Date.now()}`,
      type: 'plan',
      data: { title: '', status: 'planning', steps: [] }
    }, this.session, this.conversation, this.messageThread);

    this.messageThread.addContextItem(contextItem);
    return /** @type {PlanContextItem} */ (contextItem);
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{action?: string, title?: string, items?: PlanStep[], index?: number, result?: string}} */ (prepared?.params || {});

    // Step actions
    if (prepParams.action === 'start_step' || prepParams.action === 'complete_step' ||
        prepParams.action === 'fail_step' || prepParams.action === 'skip_step') {
      return this._getStepActionSummary(outcome);
    }

    // Submit action summary
    const prepTitle = prepParams.title || 'Plan';

    if (outcome.cancelled) {
      return {
        summary: `Plan cancelled: ${prepTitle}`,
        details: 'You can revise the plan and resubmit.',
        success: false,
        icon: '\u2717',
        feedbackForLLM: 'The user wants to discuss the plan further. Ask them what changes they would like, then revise and resubmit.'
      };
    }

    if (!outcome.success) {
      return {
        summary: `Plan submission failed: ${outcome.error}`,
        details: '',
        success: false,
        icon: '\u2717'
      };
    }

    const result = /** @type {SubmitPlanResult} */ (outcome.result);

    return {
      summary: `Plan approved: ${result.title}`,
      details: `${result.stepCount} steps - Execution will begin automatically`,
      success: true,
      icon: '\u2713',
      feedbackForLLM: `Plan "${result.title}" was approved with ${result.stepCount} steps. Execution will begin automatically. Use plan(action: 'start_step', index: N) before working on each step, then plan(action: 'complete_step', index: N, result: '...') when done. Use create_thread for complex steps, or work inline for simple ones.`
    };
  }

  /**
   * Format step action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   * @private
   */
  _getStepActionSummary(outcome) {
    if (!outcome.success) {
      return {
        summary: `Step update failed: ${outcome.error}`,
        details: '',
        success: false,
        icon: '\u2717'
      };
    }

    const result = /** @type {StepActionResult} */ (outcome.result);
    return {
      summary: `Step ${result.index + 1}: ${result.oldStatus} \u2192 ${result.newStatus} (${result.completed}/${result.total} completed)`,
      details: result.result || '',
      success: true,
      icon: '\u2713'
    };
  }

  /**
   * Get status UI for action bubble rendering.
   * Called with no args by context-item-message for the persistent plan item.
   * Called with actionStatus/toolInput by tool-action-message for plan tool-actions.
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Action status
   * @param {Record<string, unknown>} [toolInput] - Tool input
   * @param {{conversation?: unknown, session?: unknown, toolUseId?: string}} [_context] - Context
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status UI config
   */
  getStatusUI(actionStatus, toolInput, _context) {
    // Context-item-message rendering (no args) — the persistent "Current Plan" item
    if (!actionStatus) {
      return {
        typeName: 'Plan',
        summary: this.data.title || 'Implementation Plan'
      };
    }

    const action = /** @type {string|undefined} */ (toolInput?.action) || 'submit';
    const isStepAction = action !== 'submit';
    // "submit" creates/replaces the plan; the step actions change it. Badge each
    // for what it does so creation and update aren't both just "Plan".
    const typeName = isStepAction ? 'Update plan' : 'Plan';

    // Get plan data from displayData (set during prepare)
    const planData = /** @type {any} */ (actionStatus)?.displayData?.planData ||
    /** @type {any} */ (actionStatus)?.planData;

    // For pending/approval / running state, show what the action is doing.
    if (actionStatus?.pending) {
      return {
        typeName,
        summary: isStepAction
          ? this._stepActionSummary(action, toolInput?.index)
          : (planData?.title || 'Implementation Plan')
      };
    }

    // For cancelled state
    if (actionStatus?.cancelled) {
      return {
        typeName,
        summary: `cancelled: ${planData?.title || 'Plan'}`,
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('cancelled')
      };
    }

    // For success state
    if (actionStatus?.success) {
      if (isStepAction) {
        const result = /** @type {StepActionResult} */ (actionStatus.result);
        return {
          typeName,
          summary: `Step ${(result?.index ?? 0) + 1}: ${result?.oldStatus} \u2192 ${result?.newStatus} (${result?.completed}/${result?.total})`,
          status: /** @type {import('juggler/context-item').ResultStatus} */ ('success')
        };
      }
      const result = /** @type {SubmitPlanResult} */ (actionStatus.result);
      return {
        typeName,
        summary: `approved: ${result?.title || 'Plan'}`,
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('success')
      };
    }

    // For error state
    if (actionStatus?.error) {
      const errorSummary = isStepAction
        ? `Step ${toolInput?.index || '?'} failed: ${actionStatus.error}`
        : actionStatus.error;
      return {
        typeName,
        summary: errorSummary,
        status: /** @type {import('juggler/context-item').ResultStatus} */ ('error')
      };
    }

    return null;
  }

  /**
   * Human-readable summary for an in-flight step action (used while the action
   * is pending/running, before a result exists).
   * @param {string} action - The step action (start_step, complete_step, …)
   * @param {unknown} index - 1-based step index from the tool input
   * @returns {string} Summary text
   * @private
   */
  _stepActionSummary(action, index) {
    const n = index ? ` ${index}` : '';
    switch (action) {
      case 'start_step': return `Starting step${n}`;
      case 'complete_step': return `Completing step${n}`;
      case 'fail_step': return `Failing step${n}`;
      case 'skip_step': return `Skipping step${n}`;
      default: return `Updating step${n}`;
    }
  }

  // ============================================================================
  // SHARED PRIVATE HELPERS
  // ============================================================================

  /**
   * Create the plan detail view component
   * @private
   * @param {{title?: string, status?: string, steps?: PlanStep[]}} planData - Plan data to render
   * @returns {HTMLElement} Plan detail view element
   */
  _createPlanDetailView(planData) {
    const view = createElement('div', 'plan-detail-view');

    // Header with title, status badge, and progress
    const header = createElement('div', 'plan-header');

    if (planData.title) {
      const titleRow = createElement('div', 'plan-title-row');
      titleRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem';

      const title = createElement('h3', 'plan-title', planData.title);
      titleRow.appendChild(title);

      if (planData.status && planData.status !== 'planning') {
        const badge = createElement('span', 'plan-status-badge');
        badge.classList.add(`status-${planData.status}`);
        badge.textContent = planData.status;
        titleRow.appendChild(badge);
      }

      header.appendChild(titleRow);
    }

    view.appendChild(header);

    // Steps list
    const steps = planData.steps || [];
    const stepsList = createElement('ol', 'plan-items');

    for (const [i, step] of steps.entries()) {
      const status = step.status || 'pending';

      const stepEl = createElement('li', 'plan-item');
      stepEl.classList.add(`status-${status}`);

      // Step indicator (SVG icon or number)
      const indicator = createElement('div', 'plan-item-indicator');
      if (status === 'completed') {
        indicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M380.1-256.82 168.62-468.31l36-35.74L380.1-328.56l374.87-375.13 36 36L380.1-256.82Z"/></svg>';
      } else if (status === 'in_progress') {
        indicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M340-237.64v-487.69l383.07 243.84L340-237.64Zm50.26-243.85Zm0 152 239.59-152-239.59-152v304Z"/></svg>';
      } else if (status === 'failed') {
        indicator.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m256-192.35-63.65-63.65L416.35-480 192.35-704l63.65-63.65L480-543.65l224-224 63.65 63.65L543.65-480l224 224-63.65 63.65L480-416.35l-224 224Z"/></svg>';
      } else if (status === 'skipped') {
        indicator.textContent = '\u2014';
      } else {
        indicator.textContent = String(i + 1);
      }
      stepEl.appendChild(indicator);

      // Step content
      const content = createElement('div', 'plan-item-content');
      const text = createElement('div', 'plan-item-text markdown');
      text.innerHTML = renderMarkdown(step.content, { escapeXml: false });
      content.appendChild(text);

      // Result summary (if present)
      if (step.result) {
        const resultEl = createElement('div', 'plan-item-result', step.result);
        content.appendChild(resultEl);
      }

      stepEl.appendChild(content);

      // Thread link icon (if present)
      if (step.threadItemId) {
        const threadLink = createElement('div', 'plan-item-thread-link');
        threadLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-280H280q-83.33 0-141.67-58.33Q80-396.67 80-480t58.33-141.67Q196.67-680 280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83.33 0 141.67 58.33Q880-563.33 880-480t-58.33 141.67Q763.33-280 680-280H520Z"/></svg>';
        threadLink.title = 'Open step thread';
        threadLink.dataset.threadItemId = step.threadItemId;
        threadLink.addEventListener('click', (e) => {
          e.stopPropagation();
          // Dispatch item-selected event (bubbles up to conversation-tab)
          threadLink.dispatchEvent(new CustomEvent('item-selected', {
            bubbles: true,
            composed: true,
            detail: { itemId: step.threadItemId }
          }));
        });
        stepEl.appendChild(threadLink);
      }

      stepsList.appendChild(stepEl);
    }

    view.appendChild(stepsList);

    return view;
  }

  /**
   * Count steps by status
   * @private
   * @param {'pending'|'in_progress'|'completed'|'failed'|'skipped'} status - Status to count
   * @returns {number} Count of steps with given status
   */
  _countByStatus(status) {
    const steps = this.data.steps || [];
    return steps.filter((/** @type {PlanStep} */ step) => step.status === status).length;
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { toolAction, input, helpers } = ctx;
    const action = input.action || 'submit';
    /** @type {any} */
    let planData = null;

    if (action === 'submit') {
      // Tolerate the same aliases validate() accepts (items/steps/tasks, plus
      // the content field variants) so the pending preview matches what will
      // execute. items may arrive as a JSON string (some LLMs stringify arrays)
      // or as a partial value mid-stream; coerce to an array before mapping.
      let rawItems = PlanContextItem._resolvePlanItems(input);
      if (typeof rawItems === 'string') {
        try {
          rawItems = JSON.parse(rawItems);
        } catch {
          rawItems = [];
        }
      }
      const items = (Array.isArray(rawItems) ? rawItems : []).map((/** @type {Record<string, unknown>} */ item) => ({
        content: PlanContextItem._resolveStepContent(item),
        status: item.status || 'pending',
        threadItemId: null,
        result: null,
      }));
      planData = { title: input.title || '', status: 'planning', steps: items };
    } else {
      const stepLabel = `${(input.action || '').replace(/_/g, ' ')}: Step ${input.index || '?'}`;
      helpers.addSubsection(wrapper, 'Action', stepLabel, 'properties-panel-code');
      // The step's result summary is rendered inline within the plan view
      // (each completed step shows its own result), so no separate trailing
      // "Result" section is needed — it would just duplicate it.

      const taResult = toolAction.get('result');
      const taFullResult = taResult?.get ? taResult.get('fullResult') : taResult?.fullResult;
      const fullResultObj = taFullResult?.toJSON ? taFullResult.toJSON() : taFullResult;
      const snapshot = fullResultObj?.result?.planSnapshot;
      if (snapshot) {
        planData = snapshot;
      } else {
        const planCI = ctx.messageThread?.contextItems?.find(
          (/** @type {{type: string}} */ ci) => ci.type === 'plan'
        );
        if (planCI?.data) planData = planCI.data;
      }
    }

    if (planData && planData.steps && planData.steps.length > 0) {
      // Plan view lives in its own subsection (direct child of the panel
      // section) so the shared subsection-sibling rule draws a divider before
      // it, separating it from the preceding Action subsection.
      const planSection = document.createElement('properties-panel-subsection');
      planSection.classList.add('context-item-expanded-content');
      planSection.appendChild(this._createPlanDetailView(planData));
      wrapper.appendChild(planSection);
      return { skipResultSection: true };
    } else if (action !== 'submit') {
      return { skipResultSection: true };
    } else {
      helpers.addSubsection(wrapper, 'Action', 'Submit plan', 'properties-panel-code');
    }
  }
}

export default PlanContextItem;
