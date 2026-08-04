//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { APPROVAL_POLICY } from 'juggler/strategy-type';
import { INTERACTION_KIND } from 'juggler/context-item';
import DefaultStrategyType from './default-strategy-type.js';

/**
 * YoloStrategyType - Default behavior with all tool approvals auto-granted.
 *
 * Identical to the default strategy (it extends DefaultStrategyType), but
 * getApprovalPolicy() returns APPROVE for every **gate**, so nothing ever halts
 * at a go/no-go approval prompt — including side-effecting tools (`bash`,
 * `write`, `edit`). The name and the red warning icon are the only safeguard:
 * switching to YOLO is the user's explicit, informed choice.
 *
 * Two kinds of parked call are the exception and still stop for a human:
 *
 *   - an **elicitation** — a tool whose parked state is a request for the user's
 *     own input (e.g. AskUserQuestion), where the "approval" IS that answer.
 *     Approving one would run the tool with no answer and silently decide for
 *     the user.
 *   - a **non-auto-approvable checkpoint** (`autoApprovable === false`) — a
 *     deliberate human review point such as a plan `submit` or a catastrophic
 *     delete, whose entire purpose is that a human sees it before it proceeds.
 *
 * Neither is what "auto-approve everything" is meant to do: YOLO removes routine
 * approval prompts; it does not put words in the user's mouth nor tick past a
 * checkpoint that exists to be reviewed. Both still park for a human, exactly as
 * under Default (mirroring how the framework never routes elicitations, nor a
 * non-auto-approvable call, to the auto-approve reviewer either).
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
    order: 3,
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
   * Auto-approve every ordinary gate. YOLO grants master-control approval for
   * all categories, so the permission system's default decision is bypassed —
   * with two deliberate exceptions, both of which return DEFAULT so the call
   * parks for the human exactly as under Default:
   *
   *   1. an elicitation (e.g. AskUserQuestion): its resolution IS the user's
   *      typed answer, which no auto-approval can supply; approving it would run
   *      the tool with no answer.
   *   2. a non-auto-approvable call (`autoApprovable === false`, e.g. a plan
   *      `submit` or a catastrophic delete): a deliberate human checkpoint whose
   *      whole point is review. A blanket auto-approve must not tick past it —
   *      the same floor the auto-approve reviewer honours.
   * @override
   * @param {{interactionKind: string, autoApprovable?: boolean}} info - Approval context (see StrategyType#getApprovalPolicy)
   * @returns {'approve'|'require-approval'|'default'} Approval policy
   */
  getApprovalPolicy({ interactionKind, autoApprovable }) {
    if (interactionKind === INTERACTION_KIND.ELICITATION) {
      return APPROVAL_POLICY.DEFAULT;
    }
    if (autoApprovable === false) {
      return APPROVAL_POLICY.DEFAULT;
    }
    return APPROVAL_POLICY.APPROVE;
  }
}
