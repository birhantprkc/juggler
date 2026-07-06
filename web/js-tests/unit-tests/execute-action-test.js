//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for bash tool execution pipeline.
 *
 * Tests the COMPLETE flow using GOLDEN DATA comparison.
 * Each test shows EXACTLY what the LLM sees.
 * @module unit-tests/execute-action
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
 * Run all bash framework tests.
 * @param {TestContext} ctx - Test context
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: Simple echo command through framework
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'echo "hello from framework test"'
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'echo "hello from framework test"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'hello from framework test',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash echo');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`echo command: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: Non-zero exit code captured
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'exit 42'
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'exit 42' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: '(no output)\n\nexit code: 42\n\nCommand failed with exit code 42',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash exit code');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`exit code: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: Multi-line output captured
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'echo "line1"; echo "line2"; echo "line3"'
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'echo "line1"; echo "line2"; echo "line3"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'line1\nline2\nline3',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash multiline');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`multi-line output: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Command runs in project directory
  // Note: This test verifies the command runs in the correct directory
  // but uses manual assertion since the path is dynamic
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'pwd'
    });

    const { context, outcomes } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    // Check structure is correct (user + tool-use + tool-result + assistant = 4)
    assert(context.messages.length === 4, 'should have 4 messages');
    assert(outcomes.length === 1, 'should have 1 outcome');
    assert(outcomes[0].success === true, 'command should succeed');

    // Verify the result contains the fixture directory path
    // outcomes[0].result is the content string directly
    const stdout = /** @type {string} */ (outcomes[0].result).trim();
    assert(stdout.includes('/'), 'pwd should output a path');
    assert(stdout === ctx.fixtureDir, 'pwd should match fixture dir');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`working directory: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Pipeline command
  try {
    const conversation = await createTestConversation(session);
    // `tr -d " "` strips wc's leading pad: BSD wc (macOS) right-justifies to
    // "       3" while GNU wc (Linux/CI) emits "3". Normalising keeps the
    // golden deterministic across platforms while still exercising a pipeline.
    const pipelineCommand = 'echo "apple banana cherry" | tr " " "\\n" | wc -l | tr -d " "';
    const toolCall = createToolCall('bash', {
      command: pipelineCommand
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: pipelineCommand }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: '3',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash pipeline');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`pipeline: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Command creates file (side effect)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'echo "created by execute" > cmd-created.txt'
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'echo "created by execute" > cmd-created.txt' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: '(no output)',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash file creation');

    // Verify file was created
    const fileContent = await ctx.readFile('cmd-created.txt');
    assert(fileContent.trim() === 'created by execute', 'file content should match');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`file creation: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: Multiple commands in sequence
  try {
    const conversation = await createTestConversation(session);
    const call1 = createToolCall('bash', { command: 'echo "first"' });
    const call2 = createToolCall('bash', { command: 'echo "second"' });

    await executeToolsAndGetContext(conversation, session, [call1]);
    const { context } = await executeToolsAndGetContext(conversation, session, [call2]);

    const expected = [
      // First turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'echo "first"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'first',
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'bash',
        toolInput: { command: 'echo "second"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: 'second',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [call1, call2], 'bash sequential');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`multiple commands: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 8: Special characters in output preserved
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('bash', {
      command: 'echo "quotes: \\"test\\" and <angle> & ampersand"'
    });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'bash',
        toolInput: { command: 'echo "quotes: \\"test\\" and <angle> & ampersand"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'quotes: "test" and <angle> & ampersand',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'bash special chars');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`special characters: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
