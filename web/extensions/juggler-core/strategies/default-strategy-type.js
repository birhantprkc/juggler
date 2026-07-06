//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import StrategyType from 'juggler/strategy-type';

/**
 * DefaultStrategyType - Baseline strategy using coroutine pattern
 *
 * This strategy implements the standard Juggler behavior:
 * - No iteration limit (continues until LLM stops calling tools)
 * - Standard context assembly with context items, messages, decision framework
 * - No sub-conversation spawning
 *
 * Use this as the baseline/regression test for comparing other strategies.
 * @augments {StrategyType}
 */
export default class DefaultStrategyType extends StrategyType {
  /**
   * Strategy manifest describing capabilities and recommendations
   * @type {import('juggler/strategy-type').StrategyManifest}
   */
  static MANIFEST = {
    id: 'default',
    name: 'Default Strategy',
    version: '2.0.0',
    description: 'Standard Juggler behavior - general-purpose coding assistant',
    author: 'Juggler Team',
    color: 'var(--accent-yellow)',
    showsApprovalControls: true,
    defaultRules: [],
    recommendations: {
      recommendedFor: [
        'General coding tasks',
        'Bug fixes',
        'Code refactoring',
        'Feature implementation',
        'Code review and analysis'
      ],
      exampleTriggers: [
        'fix the bug in...',
        'refactor this code...',
        'add a new feature...',
        'implement...',
        'update the...'
      ],
      approach: 'Iterative agentic loop with the full toolset. Read tools run automatically; writes and shell commands pause for your approval before they run. The loop continues until the task is done — there is no fixed iteration cap.',
      tradeoffs: {
        pros: [
          'Well-tested, predictable baseline behaviour',
          'Asks before writing files or running commands, so you stay in control',
          'Read tools run without interruption',
          'Suits the full range of everyday coding tasks'
        ],
        cons: [
          'Stops for approval on writes and shell commands — use YOLO for an uninterrupted run',
          'Does not guarantee read-only safety — use Read-only to make changes impossible'
        ]
      }
    }
  };

}
