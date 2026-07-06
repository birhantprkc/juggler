//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { APPROVAL_POLICY } from 'juggler/strategy-type';
import DefaultStrategyType from './default-strategy-type.js';

/**
 * YoloStrategyType - Default behavior with all tool approvals auto-granted.
 *
 * Identical to the default strategy (it extends DefaultStrategyType), but
 * getApprovalPolicy() returns APPROVE for every tool, so nothing ever halts
 * at an approval prompt — including side-effecting tools (`bash`, `write`,
 * `edit`). The name and the red warning icon are the only safeguard: switching
 * to YOLO is the user's explicit, informed choice.
 * @augments {DefaultStrategyType}
 */
export default class YoloStrategyType extends DefaultStrategyType {
  /**
   * Strategy manifest describing capabilities and recommendations
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'yolo',
    name: 'YOLO',
    version: '1.0.0',
    description: 'Auto-approves every tool use — use at your own risk!',
    author: 'Juggler Team',
    color: 'var(--accent-red)',
    icon: 'icon-warning',
    // Permission toggles are meaningless when the strategy auto-approves
    // everything — hide them rather than show dead controls.
    showsApprovalControls: false,
    defaultRules: [],
    recommendations: {
      recommendedFor: [
        'Trusted, low-stakes tasks where you want zero interruptions',
        'Sandboxed or disposable environments',
        'Rapid iteration when you are watching every step'
      ],
      exampleTriggers: [
        'just do it...',
        'no need to ask, go ahead...',
        'run everything...'
      ],
      approach: 'Standard agentic loop, but every tool call is auto-approved — including file writes and shell commands.',
      tradeoffs: {
        pros: [
          'No approval interruptions — fully autonomous',
          'Fastest path for trusted tasks'
        ],
        cons: [
          'No human checkpoint before destructive shell commands or writes',
          'Mistakes execute immediately with no chance to deny'
        ]
      }
    }
  };

  /**
   * Auto-approve every tool. YOLO grants master-control approval for all
   * categories, so the permission system's default decision is bypassed.
   * @override
   * @returns {'approve'|'require-approval'|'default'} Approval policy
   */
  getApprovalPolicy() {
    return APPROVAL_POLICY.APPROVE;
  }
}
