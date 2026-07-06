//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for plan tool execution pipeline.
 *
 * Tests the COMPLETE flow using GOLDEN DATA comparison.
 * Each test compares the FULL context structure.
 * @module unit-tests/submit-plan-action
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  executeToolsAndGetContext,
  createToolCall,
  assert,
  assertContextGolden
} from '../utilities/test-helpers.js';


/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 * @property {function(string): Promise<string>} readFile - Read file helper
 * @property {function(string, number): Promise<{exitCode: number, stdout: string, stderr: string}>} executeCommand - Execute command helper
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all plan tool framework tests.
 * @param {TestContext} ctx - Test context
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(ctx) {
  void ctx; // ctx.fixtureDir not needed for plan tests

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: submit_plan returns breakLoop=true and creates plan context item
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Test Plan',
      items: [
        { content: 'Step 1', status: 'pending' },
        { content: 'Step 2', status: 'pending' }
      ]
    });

    const { outcomes, context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Test Plan',
          items: [
            { content: 'Step 1', status: 'pending' },
            { content: 'Step 2', status: 'pending' }
          ]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Test Plan\n\nPlan "Test Plan" was approved with 2 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'basic submit_plan');

    // Secondary checks: outcome behavior
    assert(outcomes.length === 1, 'should have one outcome');
    const outcome = outcomes[0];
    assert(outcome.resultStatus === 'success',
      'submit_plan should succeed');

    // Secondary check: plan context item created
    const planContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'plan');
    assert(planContextItem !== undefined, 'should create plan context item');
    assert(planContextItem?.data?.title === 'Test Plan', 'plan title should match');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`basic submit_plan: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: submit_plan keeps strategy as 'plan' (no longer switches to execute)
  try {
    const conversation = await createTestConversation(session);
    const strategyBefore = conversation.rootMessageThread.currentStrategyId;

    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Strategy Test',
      items: [{ content: 'Task', status: 'pending' }]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Strategy Test',
          items: [{ content: 'Task', status: 'pending' }]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Strategy Test\n\nPlan "Strategy Test" was approved with 1 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'strategy stays plan');

    // Secondary check: strategy should not switch to 'execute' (the old broken behavior)
    const strategyAfter = conversation.rootMessageThread.currentStrategyId;
    assert(strategyAfter === strategyBefore,
      `strategy should not change: was '${strategyBefore}', now '${strategyAfter}'`);
    assert(strategyAfter !== 'execute',
      `strategy should not switch to 'execute'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`strategy stays plan: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: Plan items with mixed statuses
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Mixed Status Plan',
      items: [
        { content: 'Task A', status: 'pending' },
        { content: 'Task B', status: 'in_progress' },
        { content: 'Task C', status: 'completed' }
      ]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Mixed Status Plan',
          items: [
            { content: 'Task A', status: 'pending' },
            { content: 'Task B', status: 'in_progress' },
            { content: 'Task C', status: 'completed' }
          ]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Mixed Status Plan\n\nPlan "Mixed Status Plan" was approved with 3 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'mixed status');

    // Secondary check: plan context item data structure
    const planContextItem = conversation.rootMessageThread.contextItems.find(f =>
      f.type === 'plan' && f.data.title === 'Mixed Status Plan'
    );
    assert(planContextItem !== undefined, 'plan context item should exist');
    assert(planContextItem?.data?.steps?.[0]?.content === 'Task A', 'first step content');
    assert(planContextItem?.data?.steps?.[1]?.status === 'in_progress', 'second step status');
    assert(planContextItem?.data?.steps?.[2]?.status === 'completed', 'third step status');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`mixed status: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Plan items normalized (missing status defaults to pending)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Normalization Test',
      items: [
        { content: 'No status' },
        { content: 'Explicit pending', status: 'pending' }
      ]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    // Note: items without status get normalized to 'pending' during validate()
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Normalization Test',
          items: [
            { content: 'No status' },
            { content: 'Explicit pending', status: 'pending' }
          ]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Normalization Test\n\nPlan "Normalization Test" was approved with 2 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'status normalization');

    // Secondary check: normalization applied to plan context item
    const planContextItem = conversation.rootMessageThread.contextItems.find(f =>
      f.type === 'plan' && f.data.title === 'Normalization Test'
    );

    if (planContextItem) {
      const steps = planContextItem.data.steps || [];
      assert(steps.length === 2, 'should have 2 steps');
      assert(steps[0].status === 'pending', 'missing status should default to pending');
      assert(steps[1].status === 'pending', 'explicit pending should remain');
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`status normalization: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Multiple submit_plan calls show history in context
  try {
    const conversation = await createTestConversation(session);

    const toolCall1 = createToolCall('plan', {
      action: 'submit',
      title: 'First Plan',
      items: [{ content: 'Task 1', status: 'pending' }]
    });
    const toolCall2 = createToolCall('plan', {
      action: 'submit',
      title: 'Second Plan',
      items: [{ content: 'Task 2', status: 'pending' }]
    });

    await executeToolsAndGetContext(conversation, session, [toolCall1]);
    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall2]);

    const expected = [
      // First turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'First Plan',
          items: [{ content: 'Task 1', status: 'pending' }]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: First Plan\n\nPlan "First Plan" was approved with 1 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Second Plan',
          items: [{ content: 'Task 2', status: 'pending' }]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: 'Plan approved: Second Plan\n\nPlan "Second Plan" was approved with 1 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall1, toolCall2], 'multiple plans');

    // Secondary check: should not create duplicate plan context items (singleton pattern)
    const planContextItemsAfter = conversation.rootMessageThread.contextItems.filter(f => f.type === 'plan').length;
    assert(planContextItemsAfter === 1, 'should reuse existing plan context item (singleton)');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`multiple plans: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Conversation items contain tool-use and tool-result
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Items Test',
      items: [{ content: 'Task', status: 'pending' }]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Items Test',
          items: [{ content: 'Task', status: 'pending' }]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Items Test\n\nPlan "Items Test" was approved with 1 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'conversation items');

    // Secondary check: verify conversation items contain tool-action
    // Internally, tool-use + tool-result are stored together as tool-action
    const items = conversation.rootMessageThread.getMessages();
    const toolActionItem = items.find((/** @type {any} */ m) =>
      m.get('type') === 'tool-action' &&
			m.get('toolUseId') === toolCall.id
    );

    assert(toolActionItem !== undefined, 'tool-action should be in items');
    assert(/** @type {any} */ (toolActionItem).get('result') !== null, 'tool-action should have result');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`conversation items: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: Plan with markdown content
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Markdown Plan',
      items: [
        { content: 'Update `src/main.js` with new function', status: 'pending' },
        { content: 'Add tests in `tests/main.test.js`', status: 'pending' }
      ]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Markdown Plan',
          items: [
            { content: 'Update `src/main.js` with new function', status: 'pending' },
            { content: 'Add tests in `tests/main.test.js`', status: 'pending' }
          ]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Markdown Plan\n\nPlan "Markdown Plan" was approved with 2 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'markdown content');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`markdown content: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 8: Single item plan
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Single Item',
      items: [{ content: 'Only task', status: 'pending' }]
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'plan',
        toolInput: {
          action: 'submit',
          title: 'Single Item',
          items: [{ content: 'Only task', status: 'pending' }]
        }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Plan approved: Single Item\n\nPlan "Single Item" was approved with 1 steps. Execution will begin automatically. Use plan(action: \'start_step\', index: N) before working on each step, then plan(action: \'complete_step\', index: N, result: \'...\') when done. Use create_thread for complex steps, or work inline for simple ones.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'single item');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`single item: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 9: submit_plan ignores irrelevant optional fields emitted with defaults
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      index: 0,
      title: 'Default Optional Fields',
      items: [{ content: 'Step with defaulted index', status: 'pending' }],
      result: '',
      threadItemId: ''
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'submit_plan with index 0 should succeed');

    const toolActionItem = conversation.rootMessageThread.getMessages().find((/** @type {any} */ m) =>
      m.get('type') === 'tool-action' &&
			m.get('toolUseId') === toolCall.id
    );
    assert(toolActionItem !== undefined, 'tool-action should exist');
    assert(/** @type {any} */ (toolActionItem).get('state') === 'completed', 'tool-action should complete');
    assert(/** @type {any} */ (toolActionItem).get('result') !== null, 'tool-action should have result');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'plan');
    assert(planContextItem?.data?.title === 'Default Optional Fields', 'plan title should match');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`submit_plan default optional fields: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 10: start_step action marks step as in_progress
  try {
    const conversation = await createTestConversation(session);

    // First submit a plan
    const submitCall = createToolCall('plan', {
      action: 'submit',
      title: 'Step Action Test',
      items: [
        { content: 'Step 1', status: 'pending' },
        { content: 'Step 2', status: 'pending' }
      ]
    });
    await executeToolsAndGetContext(conversation, session, [submitCall]);

    // Then start step 1
    const startCall = createToolCall('plan', {
      action: 'start_step',
      index: 1
    });
    const { outcomes } = await executeToolsAndGetContext(conversation, session, [startCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'start_step should succeed');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'plan');
    assert(planContextItem?.data?.steps?.[0]?.status === 'in_progress', 'step 1 should be in_progress');
    assert(planContextItem?.data?.status === 'executing', 'plan status should be executing');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`start_step: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 11: complete_step action marks step as completed with result
  try {
    const conversation = await createTestConversation(session);

    // Submit a plan
    const submitCall = createToolCall('plan', {
      action: 'submit',
      title: 'Complete Step Test',
      items: [{ content: 'Step 1', status: 'pending' }]
    });
    await executeToolsAndGetContext(conversation, session, [submitCall]);

    // Complete step 1
    const completeCall = createToolCall('plan', {
      action: 'complete_step',
      index: 1,
      result: 'Created the user model'
    });
    const { outcomes } = await executeToolsAndGetContext(conversation, session, [completeCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'complete_step should succeed');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'plan');
    assert(planContextItem?.data?.steps?.[0]?.status === 'completed', 'step 1 should be completed');
    assert(planContextItem?.data?.steps?.[0]?.result === 'Created the user model', 'step result should match');
    assert(planContextItem?.data?.status === 'completed', 'plan should be completed (all steps done)');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`complete_step: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 12: fail_step and skip_step actions
  try {
    const conversation = await createTestConversation(session);

    // Submit a plan with 3 steps
    const submitCall = createToolCall('plan', {
      action: 'submit',
      title: 'Fail Skip Test',
      items: [
        { content: 'Step 1', status: 'pending' },
        { content: 'Step 2', status: 'pending' },
        { content: 'Step 3', status: 'pending' }
      ]
    });
    await executeToolsAndGetContext(conversation, session, [submitCall]);

    // Fail step 1
    const failCall = createToolCall('plan', {
      action: 'fail_step',
      index: 1,
      result: 'File not found'
    });
    await executeToolsAndGetContext(conversation, session, [failCall]);

    // Skip step 2
    const skipCall = createToolCall('plan', {
      action: 'skip_step',
      index: 2
    });
    await executeToolsAndGetContext(conversation, session, [skipCall]);

    // Complete step 3
    const completeCall = createToolCall('plan', {
      action: 'complete_step',
      index: 3,
      result: 'Done'
    });
    await executeToolsAndGetContext(conversation, session, [completeCall]);

    const planContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'plan');
    assert(planContextItem?.data?.steps?.[0]?.status === 'failed', 'step 1 should be failed');
    assert(planContextItem?.data?.steps?.[0]?.result === 'File not found', 'fail result should match');
    assert(planContextItem?.data?.steps?.[1]?.status === 'skipped', 'step 2 should be skipped');
    assert(planContextItem?.data?.steps?.[2]?.status === 'completed', 'step 3 should be completed');
    assert(planContextItem?.data?.status === 'completed', 'plan should be completed (all terminal)');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`fail_skip_step: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 13: submit tolerates `steps` alias for the `items` param
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Steps Alias',
      steps: [
        { content: 'Alias step 1', status: 'pending' },
        { content: 'Alias step 2', status: 'pending' }
      ]
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'submit with `steps` alias should succeed');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f =>
      f.type === 'plan' && f.data.title === 'Steps Alias'
    );
    assert(planContextItem !== undefined, 'plan context item should exist');
    assert(planContextItem?.data?.steps?.length === 2, 'both steps should be captured from `steps` alias');
    assert(planContextItem?.data?.steps?.[0]?.content === 'Alias step 1', 'first step content from alias');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`steps alias: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 14: submit tolerates content field aliases (description/text/task)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Content Aliases',
      items: [
        { description: 'From description', status: 'pending' },
        { text: 'From text', status: 'pending' },
        { task: 'From task', status: 'pending' }
      ]
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'submit with content aliases should succeed');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f =>
      f.type === 'plan' && f.data.title === 'Content Aliases'
    );
    assert(planContextItem !== undefined, 'plan context item should exist');
    const steps = planContextItem?.data?.steps || [];
    assert(steps.length === 3, 'all three aliased steps should be captured');
    assert(steps[0].content === 'From description', 'description alias resolves to content');
    assert(steps[1].content === 'From text', 'text alias resolves to content');
    assert(steps[2].content === 'From task', 'task alias resolves to content');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`content aliases: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 15: submit defaults a missing title rather than rejecting
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      items: [{ content: 'Untitled step', status: 'pending' }]
    });

    const { outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    assert(outcomes.length === 1, 'should have one outcome');
    assert(outcomes[0].resultStatus === 'success', 'submit without title should succeed');

    const planContextItem = conversation.rootMessageThread.contextItems.find(f =>
      f.type === 'plan' && f.data.title === 'Implementation Plan'
    );
    assert(planContextItem !== undefined, 'plan should default title to "Implementation Plan"');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`default title: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
