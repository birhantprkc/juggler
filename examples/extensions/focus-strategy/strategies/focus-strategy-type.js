//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';

/** Categories this strategy will let through. Everything else is withheld. */
const ALLOWED_CATEGORIES = new Set(['read', 'meta']);

/**
 * Uninterrupted investigation: read and meta tools only, auto-approved.
 *
 * The model can survey the project without touching a file and without stopping
 * for approval — useful for "work out what's going on here" before any change.
 * @augments StrategyType
 */
class FocusStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'focus',
    name: 'Focus',
    version: '1.0.0',
    description: 'Read-only investigation, auto-approved — survey without changing anything',
    author: 'Juggler Team',
    icon: 'icon-search',
    // No write tools survive filterTools(), so permission toggles would be
    // controls over something that cannot happen.
    showsApprovalControls: false
  };

  /**
   * Tell the model what mode it is in, once, when the user switches to this
   * strategy. The base class injects this as a durable system-reminder —
   * authoring system-prompt text instead would bust the prompt cache on every
   * switch — and Settings → Extensions shows it verbatim, so the user reads the
   * same string the model does.
   * @type {string}
   */
  static GUIDANCE =
    'Focus mode: investigation only. Writing tools are withheld this turn — '
    + 'read, search and reason, and report what you find rather than changing it.';

  /**
   * Withhold every write tool. The model is never offered one, so it cannot
   * plan around a refusal — a cleaner outcome than denying the call later.
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools - Every available tool
   * @returns {import('juggler/strategy-type').ToolDefinition[]} Only the read and meta tools
   */
  filterTools(tools) {
    return tools.filter(tool => ALLOWED_CATEGORIES.has(tool.category ?? ''));
  }

  /**
   * Auto-approve what survived the filter, with two deliberate exceptions.
   *
   * An elicitation's "approval" IS the user's answer, so approving one runs the
   * tool having silently answered for them; and a call the tool itself marks
   * non-auto-approvable is a deliberate human checkpoint. Both must fall through
   * to DEFAULT so they still park. AskUserQuestion is category `read`, so it
   * reaches this method — the guard is doing real work.
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean, interactionKind: string, autoApprovable: boolean}} info - Call context
   * @returns {'approve'|'require-approval'|'default'} The policy decision
   */
  getApprovalPolicy({ category, interactionKind, autoApprovable }) {
    if (interactionKind === 'elicitation' || !autoApprovable) return APPROVAL_POLICY.DEFAULT;
    if (ALLOWED_CATEGORIES.has(category ?? '')) return APPROVAL_POLICY.APPROVE;
    return APPROVAL_POLICY.DEFAULT;
  }
}

export default FocusStrategyType;
