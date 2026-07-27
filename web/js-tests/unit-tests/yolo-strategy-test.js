//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the YOLO strategy's approval policy.
 *
 * YOLO auto-approves every go/no-go **gate**, but must NOT auto-approve an
 * **elicitation** (a tool whose parked state awaits the user's own input, e.g.
 * AskUserQuestion). Approving one would run the tool with no answer and silently
 * decide for the user — "auto-approve everything" is meant to remove approval
 * prompts, not put words in the user's mouth.
 *
 * Contract under test:
 *   1. getApprovalPolicy returns APPROVE for a gate and DEFAULT for an
 *      elicitation (the pure policy decision).
 *   2. Driven through the real engine gate (`handleNewToolAction`), a
 *      normally-gated bash auto-approves while an AskUserQuestion stays PENDING
 *      — proving `interactionKind` is threaded into getApprovalPolicy and YOLO
 *      acts on it end to end.
 * @module unit-tests/yolo-strategy-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { handleNewToolAction } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import { INTERACTION_KIND } from '../../sdk/context-item.js';
import { APPROVAL_POLICY } from '../../sdk/strategy-type.js';
import YoloStrategyType from '../../extensions/juggler-core/strategies/yolo-strategy-type.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Insert an unstarted (no-state) bash tool-action so the engine gate treats it
 * as a freshly-observed call and runs its approval logic.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @param {string} command - bash command to place in toolInput
 * @returns {string} The toolUseId, for convenience
 */
function insertUnstartedBash(conversation, toolUseId, command) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'bash',
    toolInput: { command }
  }));
  return toolUseId;
}

/**
 * Insert an unstarted AskUserQuestion tool-action — an *elicitation*, whose
 * approval surface is a user-input form rather than a go/no-go gate.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @returns {string} The toolUseId, for convenience
 */
function insertUnstartedAsk(conversation, toolUseId) {
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' }
        ],
        multiSelect: false
      }]
    }
  }));
  return toolUseId;
}

/**
 * Run all YOLO strategy approval-policy tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: getApprovalPolicy — APPROVE for a gate, DEFAULT for an elicitation
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const strategy = new YoloStrategyType({ messageThread: conversation.rootMessageThread });

    const gate = strategy.getApprovalPolicy({ interactionKind: INTERACTION_KIND.GATE });
    assert(gate === APPROVAL_POLICY.APPROVE,
      `YOLO must APPROVE a gate, got ${gate}`);

    const elicitation = strategy.getApprovalPolicy({ interactionKind: INTERACTION_KIND.ELICITATION });
    assert(elicitation === APPROVAL_POLICY.DEFAULT,
      `YOLO must NOT auto-approve an elicitation (expected DEFAULT), got ${elicitation}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`policy distinguishes gate vs elicitation: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The engine gate returns early for viewers; run the remaining tests as the
  // engine so the approval logic actually executes. Restore afterwards.
  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  try {
    // =======================================================================
    // Test 2: under YOLO, a normally-gated bash auto-approves (control case)
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = new YoloStrategyType({ messageThread: mt });

      // `env echo` defeats the trivially-safe builtin check, so absent a
      // strategy override it would park; YOLO's APPROVE for a gate skips that.
      const toolUseId = insertUnstartedBash(conversation, 'yolo-bash-1', 'env echo yolo');
      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.APPROVED,
        `YOLO should auto-approve a gated bash, got ${ta?.get('state')}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`auto-approves a gated bash: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 3: under YOLO, an AskUserQuestion still parks PENDING — the fix.
    // interactionKind is threaded into getApprovalPolicy, so YOLO returns
    // DEFAULT for the elicitation and the question waits for the human.
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;
      mt.strategy = new YoloStrategyType({ messageThread: mt });

      const toolUseId = insertUnstartedAsk(conversation, 'yolo-ask-1');
      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING,
        `YOLO must leave an AskUserQuestion parked for the user, got ${ta?.get('state')}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`leaves an elicitation parked: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
