//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for the todo tool execution pipeline.
 *
 * Exercises validate → execute: full-list replacement, singleton reuse,
 * stringified-array tolerance, missing-field rejection, and result counts.
 * @module unit-tests/todo-action
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  executeToolsAndGetContext,
  createToolCall,
  assert
} from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all todo tool framework tests.
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

  // Test 1: basic todo call succeeds and creates a singleton todo context item
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('todo', {
      todos: [
        { content: 'First task', status: 'completed' },
        { content: 'Second task', status: 'pending' }
      ]
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', `todo should succeed, got ${outcomes[0].resultStatus}: ${outcomes[0].error}`);

    const todoItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'todo');
    assert(todoItem !== undefined, 'should create todo context item');
    assert(todoItem?.data?.todos?.length === 2, 'todo item should have 2 todos');
    assert(todoItem?.data?.todos?.[0]?.content === 'First task', 'first todo content should match');
    assert(String(outcomes[0].result).includes('1/2 completed'), `result should report 1/2 completed, got: ${outcomes[0].result}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`basic todo: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: a second call replaces the list wholesale and reuses the singleton
  try {
    const conversation = await createTestConversation(session);

    await executeToolsAndGetContext(conversation, session, [createToolCall('todo', {
      todos: [{ content: 'Old A', status: 'pending' }, { content: 'Old B', status: 'pending' }]
    })]);
    await executeToolsAndGetContext(conversation, session, [createToolCall('todo', {
      todos: [{ content: 'New only', status: 'in_progress' }]
    })]);

    const todoItems = conversation.rootMessageThread.contextItems.filter(f => f.type === 'todo');
    assert(todoItems.length === 1, `should reuse singleton todo item, found ${todoItems.length}`);
    assert(todoItems[0].data.todos.length === 1, 'second call should replace the list wholesale');
    assert(todoItems[0].data.todos[0].content === 'New only', 'list should hold only the latest items');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`singleton replace: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: stringified todos array is tolerated (some LLMs stringify arrays)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('todo', {
      todos: JSON.stringify([
        { content: 'Stringified task', status: 'pending' }
      ])
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes[0].resultStatus === 'success', `stringified todos should succeed, got ${outcomes[0].resultStatus}`);
    const todoItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'todo');
    assert(todoItem?.data?.todos?.[0]?.content === 'Stringified task', 'stringified todos should be parsed');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`stringified todos: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: missing todos parameter is rejected
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('todo', { title: 'oops, wrong field' });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes[0].resultStatus === 'error', `missing todos should error, got ${outcomes[0].resultStatus}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`missing todos: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: mixed statuses normalize and counts are reported
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('todo', {
      todos: [
        { content: 'Done', status: 'completed' },
        { content: 'Working', status: 'in_progress' },
        { content: 'No status' },
        { content: 'Bogus status', status: 'not-a-real-status' }
      ]
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes[0].resultStatus === 'success', 'mixed statuses should succeed');
    const todos = conversation.rootMessageThread.contextItems.find(f => f.type === 'todo')?.data?.todos || [];
    assert(todos.length === 4, 'should have 4 todos');
    assert(todos[2].status === 'pending', 'missing status should default to pending');
    assert(todos[3].status === 'pending', 'unknown status should coerce to pending');
    assert(String(outcomes[0].result).includes('1/4 completed'), `result should report 1/4 completed, got: ${outcomes[0].result}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`mixed statuses: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
