//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the strategy `onToolPending` hook — the sanctioned seam an
 * auto-approve strategy uses to review a parked tool with an out-of-band model
 * and then resolve it. Drives the real engine gate (`handleNewToolAction`)
 * directly with a stub strategy attached to the message thread, rather than the
 * worker-commanded path, so the hook contract is exercised in isolation.
 *
 * Contract under test:
 *   1. A tool that parks PENDING fires onToolPending exactly once, with the
 *      tool's id, name, input, and category.
 *   2. A tool the strategy auto-approves does NOT fire onToolPending (it never
 *      parked).
 *   3. Resolving from inside onToolPending (the auto-approve flow) transitions
 *      the parked tool PENDING → APPROVED.
 *   4. A throwing onToolPending is swallowed — the tool stays PENDING
 *      (fail-closed) and the gate still returns.
 * @module unit-tests/tool-pending-hook-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { handleNewToolAction } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Insert an unstarted (no-state) tool-action so the engine gate treats it as a
 * freshly-observed call and runs its approval logic (the CAS guards key off an
 * empty current state).
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
 * Run all onToolPending hook tests.
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

  // The gate returns early for viewers; run these as the engine so the approval
  // logic (and the hook) actually execute. Restore afterwards.
  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  try {
    // =======================================================================
    // Test 1: parking a tool fires onToolPending once, with the tool info
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;

      /** @type {any[]} */
      const calls = [];
      const toolUseId = insertUnstartedBash(conversation, 'pending-1', 'echo pending-hook');
      // Force the park with REQUIRE_APPROVAL rather than relying on the command
      // being unsafe — execute auto-permits safe commands like `echo`, which
      // would otherwise approve before parking. 'require-approval' models a
      // "review everything" strategy and makes the fire path deterministic.
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => { calls.push(info); }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING, `should park pending, got ${ta?.get('state')}`);
      assert(calls.length === 1, `onToolPending should fire exactly once, got ${calls.length}`);
      assert(calls[0].toolUseId === toolUseId, 'hook receives toolUseId');
      assert(calls[0].toolName === 'bash', `hook receives toolName, got ${calls[0].toolName}`);
      assert(calls[0].toolInput?.command === 'echo pending-hook', 'hook receives plain toolInput');
      assert(calls[0].category === 'write', `bash category should be write, got ${calls[0].category}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`fires on park: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 2: an auto-approved tool never parks, so the hook must NOT fire
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;

      /** @type {any[]} */
      const calls = [];
      const toolUseId = insertUnstartedBash(conversation, 'approved-1', 'echo no-hook');
      // YOLO-like: approve everything. needsApproval becomes false → APPROVED,
      // and onToolPending must not be called.
      mt.strategy = {
        getApprovalPolicy: () => 'approve',
        onToolPending: (/** @type {any} */ info) => { calls.push(info); }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.APPROVED, `should auto-approve, got ${ta?.get('state')}`);
      assert(calls.length === 0, `onToolPending must NOT fire for an auto-approved tool, got ${calls.length}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`skips when auto-approved: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 3: resolving from inside onToolPending approves the parked tool
    // (the auto-approve strategy's core flow)
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'resolve-1', 'echo resolved');
      // Force the park so this genuinely exercises the hook: without it firing,
      // the tool would stay PENDING and this test would fail — so a pass proves
      // the hook ran and resolved.
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: (/** @type {any} */ info) => {
          // Classify → approve. The tool is PENDING at hook time, so this flips
          // it to APPROVED exactly as a real cheap-model verdict would.
          mt.resolveApproval(info.toolUseId, 'yes');
        }
      };

      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.APPROVED,
        `resolving in the hook should approve the tool, got ${ta?.get('state')}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`resolve from hook: ${e instanceof Error ? e.message : String(e)}`);
    }

    // =======================================================================
    // Test 4: a throwing onToolPending is swallowed — the tool stays PENDING
    // (fail-closed) and the gate still completes.
    // =======================================================================
    try {
      const conversation = await createApprovalTestConversation(session);
      const mt = conversation.rootMessageThread;

      const toolUseId = insertUnstartedBash(conversation, 'throws-1', 'echo boom');
      mt.strategy = {
        getApprovalPolicy: () => 'require-approval',
        onToolPending: () => { throw new Error('classifier exploded'); }
      };

      // Must not reject even though the hook throws.
      await handleNewToolAction(mt, toolUseId, conversation);

      const ta = mt.getToolAction(toolUseId);
      assert(ta?.get('state') === TOOL_STATES.PENDING,
        `a throwing hook must leave the tool parked (fail-closed), got ${ta?.get('state')}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`throwing hook is fail-closed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
