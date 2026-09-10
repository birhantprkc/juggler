//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the deny cascade — the UI policy that refusing one call in a batch
 * refuses the whole batch.
 *
 * The batch a model asks for arrives as several tool-actions at once, and the
 * engine evaluates them one at a time: each is appended unevaluated (state "")
 * and only becomes `pending` when its own evaluation finishes. So at the moment
 * a person clicks Deny on the first prompt, a sibling may not have been
 * described yet. A cascade that reads only `pending` cannot see that sibling,
 * cancels one call, and leaves the rest to park on prompts nobody asked for —
 * with the turn resting on them, since the worker rests while any tool-action
 * is non-terminal.
 *
 * Contract under test:
 *   1. Denying a batch cancels a sibling the engine has not evaluated yet, with
 *      the same result a parked sibling gets.
 *   2. The cascade refuses parked and unstarted work only — a sibling that is
 *      already executing is left to the stop path, and settled siblings are
 *      untouched.
 *   3. An APPROVAL still requires a parked call: nothing can approve a call the
 *      engine has not described, because there are no options to answer yet.
 * @module unit-tests/deny-cascade-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  releaseTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Append a bash tool-action in a chosen state, standing in for one member of a
 * batch. Omit `state` for a call the engine has not evaluated yet — the state
 * every member of a batch starts in.
 * @param {any} thread - Message thread to append to
 * @param {string} toolUseId - Unique tool-use id
 * @param {string} [state] - State to force, or undefined to leave unevaluated
 * @returns {string} The toolUseId, for convenience
 */
function addBatchMember(thread, toolUseId, state) {
  thread.addEvent(createToolActionMessage({
    toolUseId,
    toolName: 'bash',
    toolInput: { command: `env echo ${toolUseId}` }
  }));
  if (state) thread.updateToolActionState(toolUseId, state, { ifState: '' });
  return toolUseId;
}

/**
 * Read a field off a tool-action's result, through Y.Map or plain object.
 * @param {any} thread - Message thread holding the tool-action
 * @param {string} toolUseId - Tool-use id to read
 * @param {string} field - Result field name
 * @returns {any} The field value, or undefined when there is no result
 */
function resultField(thread, toolUseId, field) {
  const result = thread.getToolAction(toolUseId)?.get('result');
  if (!result) return undefined;
  return result.get ? result.get(field) : result[field];
}

/**
 * Run all deny-cascade tests.
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
  // Test 1: denying cancels a sibling the engine has not evaluated yet
  //
  // The failure this exists to catch: call_1 parked and denied while call_2 and
  // call_3 are still unevaluated. Reading only `pending` cancels call_1 alone,
  // the engine then writes `pending` onto the other two, and the turn rests on
  // approvals the user already refused.
  // =========================================================================
  let conversation = null;
  try {
    conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;

    addBatchMember(mt, 'batch-1-call-1', TOOL_STATES.PENDING);
    addBatchMember(mt, 'batch-1-call-2');
    addBatchMember(mt, 'batch-1-call-3');

    mt.cancelPendingApprovals();

    for (const id of ['batch-1-call-1', 'batch-1-call-2', 'batch-1-call-3']) {
      assert(mt.getToolAction(id)?.get('state') === TOOL_STATES.CANCELLED,
        `${id} should be cancelled by the cascade, got ${mt.getToolAction(id)?.get('state')}`);
      assert(resultField(mt, id, 'content') === 'Action was cancelled.',
        `${id} should carry the cancellation result, got ${JSON.stringify(resultField(mt, id, 'content'))}`);
      assert(resultField(mt, id, 'cancelled') === true,
        `${id} should be flagged cancelled so the worker stops the turn`);
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`cascade reaches an unevaluated sibling: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (conversation) await releaseTestConversation(session, conversation.id, 'deny-cascade-1');
  }

  // =========================================================================
  // Test 2: the cascade refuses parked and unstarted work only
  //
  // Bounding the change. A running call is real work with a process behind it,
  // and killing it is the stop path's job (CancelInFlightToolActions), which
  // has to abort the execution as well as write the state. A settled call is
  // history.
  // =========================================================================
  conversation = null;
  try {
    conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;

    addBatchMember(mt, 'batch-2-parked', TOOL_STATES.PENDING);
    addBatchMember(mt, 'batch-2-unstarted');
    addBatchMember(mt, 'batch-2-running', TOOL_STATES.RUNNING);
    addBatchMember(mt, 'batch-2-approved', TOOL_STATES.APPROVED);
    addBatchMember(mt, 'batch-2-done', TOOL_STATES.COMPLETED);

    mt.cancelPendingApprovals();

    assert(mt.getToolAction('batch-2-parked')?.get('state') === TOOL_STATES.CANCELLED,
      'a parked call is cancelled');
    assert(mt.getToolAction('batch-2-unstarted')?.get('state') === TOOL_STATES.CANCELLED,
      'an unstarted call is cancelled');
    assert(mt.getToolAction('batch-2-running')?.get('state') === TOOL_STATES.RUNNING,
      `a running call is left to the stop path, got ${mt.getToolAction('batch-2-running')?.get('state')}`);
    assert(mt.getToolAction('batch-2-approved')?.get('state') === TOOL_STATES.APPROVED,
      `an approved call is left to the stop path, got ${mt.getToolAction('batch-2-approved')?.get('state')}`);
    assert(mt.getToolAction('batch-2-done')?.get('state') === TOOL_STATES.COMPLETED,
      `a settled call is untouched, got ${mt.getToolAction('batch-2-done')?.get('state')}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`cascade is bounded to parked and unstarted work: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (conversation) await releaseTestConversation(session, conversation.id, 'deny-cascade-2');
  }

  // =========================================================================
  // Test 3: an approval still requires a parked call
  //
  // The widened rule is asymmetric on purpose. A refusal needs to know nothing
  // about the call to be a valid answer; an approval answers options the engine
  // has not derived yet, so there is nothing to say yes to.
  // =========================================================================
  conversation = null;
  try {
    conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;

    addBatchMember(mt, 'batch-3-unstarted');

    assert(mt.resolveApproval('batch-3-unstarted', 'yes') === false,
      'approving a call the engine has not described must report false');
    assert((mt.getToolAction('batch-3-unstarted')?.get('state') ?? '') === '',
      `a refused approval writes nothing, got ${mt.getToolAction('batch-3-unstarted')?.get('state')}`);
    assert(mt.getToolAction('batch-3-unstarted')?.get('approvalResponse') === undefined,
      'a refused approval must not record a response');

    assert(mt.resolveApproval('batch-3-unstarted', 'no') === true,
      'refusing a call the engine has not described must be written');
    assert(mt.getToolAction('batch-3-unstarted')?.get('state') === TOOL_STATES.CANCELLED,
      'refusing an unstarted call cancels it');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`approval still requires a parked call: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (conversation) await releaseTestConversation(session, conversation.id, 'deny-cascade-3');
  }

  return { passed, failed, errors };
}
