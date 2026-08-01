//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Contract test: a todo call NEVER parks for approval.
 *
 * The whole point of splitting `todo` out of `plan` is that tracking your own
 * progress carries no approval friction. This pins that contract at the action
 * layer: the tool is registered, its manifest does not require approval, and a
 * prepared call yields no approval config — so the approval gate has nothing to
 * park on.
 * @module unit-tests/todo-no-approval
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the todo no-approval contract tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: the todo tool is registered and its manifest requires no approval
  try {
    const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName('todo'));
    assert(ActionClass, 'todo tool should be registered');
    assert(ActionClass.MANIFEST.requiresApproval !== true,
      'todo MANIFEST must not require approval');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`todo manifest no-approval: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: a prepared todo call reports no approval requirement and no config
  try {
    const conversation = await createTestConversation(session);
    const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName('todo'));
    const action = new ActionClass({
      id: ActionClass.MANIFEST.id,
      session: conversation._session || session,
      conversation,
      messageThread: conversation.rootMessageThread
    });

    assert(action.requiresApproval() === false,
      'requiresApproval() should be false for todo');

    const prepared = await action.prepare({ todos: [{ content: 'Track something', status: 'pending' }] });
    assert(prepared.valid, 'todo should prepare as valid');
    assert(prepared.approval === undefined || prepared.approval === null,
      'prepared todo should carry no approval config');

    const approvalConfig = await action.getApprovalConfig(prepared.params);
    assert(approvalConfig === null,
      'todo getApprovalConfig should return null (no approval dialog)');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`todo prepare no-approval: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
