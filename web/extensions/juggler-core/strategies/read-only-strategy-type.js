//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';

/**
 * ReadOnlyStrategyType - Read-only exploration mode.
 *
 * The least-autonomous rung of the autonomy axis (Read-only → Default → YOLO):
 * only read and meta tools are exposed, so the model physically cannot modify
 * files or run shell commands. Ideal for understanding unfamiliar codebases,
 * investigating bugs before fixing them, code review, and answering questions
 * about the code.
 *
 * The read-only guarantee is enforced two ways: filterTools() withholds every
 * write/exec tool from the model, and getApprovalPolicy() auto-approves the
 * read/meta tools that remain so exploration never stops for an approval prompt.
 * The loop ends naturally like Default — there is no special completion signal.
 * @augments {StrategyType}
 */
export default class ReadOnlyStrategyType extends StrategyType {
  /**
   * Strategy manifest describing capabilities and recommendations
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'read-only',
    name: 'Read-only',
    version: '3.0.0',
    description: 'Read-only mode — any actions that may change files are automatically refused',
    author: 'Juggler Team',
    color: 'var(--accent-purple)',
    icon: 'icon-grep',
    showsApprovalControls: false, // Read-only: no write actions to approve
    recommendations: {
      recommendedFor: [
        'Understanding unfamiliar codebases',
        'Exploring architecture and patterns',
        'Investigating bugs before fixing them',
        'Code review and analysis',
        'Answering questions about the code'
      ],
      exampleTriggers: [
        'help me understand...',
        'explain how...',
        'explore the codebase...',
        'what does this code do...',
        'how is X implemented...',
        'analyze the architecture...'
      ],
      approach: 'Read and meta tools only — every write, edit, and shell command is withheld, so the model cannot modify anything. Read/meta tools are auto-approved, so exploration runs uninterrupted.',
      tradeoffs: {
        pros: [
          'Hard guarantee: cannot modify files or run commands',
          'Safe to point at unfamiliar or sensitive code',
          'Auto-approved reads mean exploration never stops for a prompt'
        ],
        cons: [
          'Cannot make any changes of any kind',
          'To edit, run, or fix anything, switch to Default or YOLO'
        ]
      }
    }
  };

  /**
   * Inject the read-only mode notice when this strategy becomes active.
   *
   * Situational guidance is delivered as a durable system-reminder message
   * (not a system-prompt API), so it reaches the LLM on the worker path and
   * leaves the cached system prefix untouched across the strategy switch. The
   * read-only constraint itself is enforced by tool filtering / getApprovalPolicy;
   * this message just makes the constraint explicit to the model.
   * @override
   * @returns {void}
   */
  onActivate() {
    this.injectGuidance(
      'READ-ONLY MODE: Only read-only tools are available this session — you cannot modify ' +
      'any files or run commands. Explore the code and answer thoroughly within that constraint.'
    );
  }

  /**
   * Auto-approve read and meta tools (read-only mode exposes nothing else).
   * @override
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean}} info
   * @returns {'approve'|'require-approval'|'default'} Approval policy
   */
  getApprovalPolicy({ category }) {
    if (category === 'read' || category === 'meta') return APPROVAL_POLICY.APPROVE;
    return APPROVAL_POLICY.DEFAULT;
  }

  /**
   * Restrict the available tools to read-only + meta.
   * @override
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]} Filtered tools
   */
  filterTools(tools) {
    return tools.filter(t => t.category === 'read' || t.category === 'meta');
  }

}
