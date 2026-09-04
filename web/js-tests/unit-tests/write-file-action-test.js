//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for write tool execution pipeline.
 * Each test compares the FULL context using GOLDEN DATA comparison.
 * @module unit-tests/write-file-action
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

// Inline the testDirFor logic — this unit test uses its own runner, not the
// integration runner, so it can't import the helper. Each test uses paths under
// this dir so sibling tests in the iframe pool don't cross-pollute.
const TD = 'test_write-file-action';

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
 * @param {TestContext} ctx - Test context
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: Create new file
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test1.txt`, content: 'Hello world' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test1.txt`, content: 'Hello world' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test1.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write create new file');

    assert(await ctx.readFile(`${TD}/test1.txt`) === 'Hello world', 'file content');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`create: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: Overwrite existing file without prior read
  try {
    const conversation = await createTestConversation(session);
    const c1 = createToolCall('write', { file_path: `${TD}/test2.txt`, content: 'Original' });
    const c2 = createToolCall('write', { file_path: `${TD}/test2.txt`, content: 'Updated' });

    await executeToolsAndGetContext(conversation, session, [c1]);
    const { context } = await executeToolsAndGetContext(conversation, session, [c2]);

    const expected = [
      // First turn - create
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test2.txt`, content: 'Original' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test2.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn - overwrite succeeds
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test2.txt`, content: 'Updated' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: `Updated file: ${TD}/test2.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [c1, c2], 'write update existing');

    assert(await ctx.readFile(`${TD}/test2.txt`) === 'Updated', 'file overwritten');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`update: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: Nested directories
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/a/b/c/test3.txt`, content: 'Nested' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/a/b/c/test3.txt`, content: 'Nested' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/a/b/c/test3.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write nested dirs');

    assert(await ctx.readFile(`${TD}/a/b/c/test3.txt`) === 'Nested', 'nested content');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`nested: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Multiple parallel writes
  try {
    const conversation = await createTestConversation(session);
    const calls = [
      createToolCall('write', { file_path: `${TD}/p1.txt`, content: 'A' }),
      createToolCall('write', { file_path: `${TD}/p2.txt`, content: 'B' }),
      createToolCall('write', { file_path: `${TD}/p3.txt`, content: 'C' })
    ];

    const { context } = await executeToolsAndGetContext(conversation, session, calls);

    // Multiple tool calls processed sequentially (tool-use, tool-result pairs)
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/p1.txt`, content: 'A' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/p1.txt`,
        isError: false
      },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'write',
        toolInput: { file_path: `${TD}/p2.txt`, content: 'B' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: `Created file: ${TD}/p2.txt`,
        isError: false
      },
      {
        type: 'tool-use',
        toolUseId: '$3',
        toolName: 'write',
        toolInput: { file_path: `${TD}/p3.txt`, content: 'C' }
      },
      {
        type: 'tool-result',
        toolUseId: '$3',
        content: `Created file: ${TD}/p3.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, calls, 'write parallel');

    assert(await ctx.readFile(`${TD}/p1.txt`) === 'A', 'p1');
    assert(await ctx.readFile(`${TD}/p2.txt`) === 'B', 'p2');
    assert(await ctx.readFile(`${TD}/p3.txt`) === 'C', 'p3');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`parallel: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Special characters
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test5.txt`, content: 'x[0] + <tag> & "q"' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test5.txt`, content: 'x[0] + <tag> & "q"' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test5.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write special chars');

    assert(await ctx.readFile(`${TD}/test5.txt`) === 'x[0] + <tag> & "q"', 'special chars');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`special: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Unicode
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test6.txt`, content: '世界 😀' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test6.txt`, content: '世界 😀' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test6.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write unicode');

    assert(await ctx.readFile(`${TD}/test6.txt`) === '世界 😀', 'unicode');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`unicode: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: Empty file
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test7.txt`, content: '' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test7.txt`, content: '' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test7.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write empty');

    assert(await ctx.readFile(`${TD}/test7.txt`) === '', 'empty');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`empty: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 8: Multiline
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test8.txt`, content: 'line1\nline2\nline3' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test8.txt`, content: 'line1\nline2\nline3' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test8.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write multiline');

    assert(await ctx.readFile(`${TD}/test8.txt`) === 'line1\nline2\nline3', 'multiline');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`multiline: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 9: JSON content
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test9.json`, content: '{"key": "value"}' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test9.json`, content: '{"key": "value"}' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test9.json`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write json');

    assert(await ctx.readFile(`${TD}/test9.json`) === '{"key": "value"}', 'json');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`json: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 10: Code file (has LLM feedback)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/test10.js`, content: 'const x = 1' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/test10.js`, content: 'const x = 1' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Created file: ${TD}/test10.js\n\nConsider running tests to verify your changes`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'write code file');

    assert(await ctx.readFile(`${TD}/test10.js`) === 'const x = 1', 'code');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`code: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 11: Overwriting a pre-existing file the conversation has never read
  // is allowed. A whole-file write carries no read precondition — the approval
  // diff shows the user every byte being replaced, so the human is the guard
  // against clobbering unseen content, not the transcript. The "pre-existing"
  // file is created in a fresh conversation first (to seed it on disk), then a
  // second conversation — with no transcript record of the file — overwrites
  // it. Uses a sandboxed test dir path so the shared iframe-pool fixture isn't
  // polluted across sibling tests.
  try {
    const seedConv = await createTestConversation(session);
    await executeToolsAndGetContext(seedConv, session, [
      createToolCall('write', { file_path: `${TD}/overwrite-target.txt`, content: 'Original' })
    ]);

    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('write', { file_path: `${TD}/overwrite-target.txt`, content: 'Overwritten' });

    const { context } = await executeToolsAndGetContext(conversation, session, [toolCall]);

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'write',
        toolInput: { file_path: `${TD}/overwrite-target.txt`, content: 'Overwritten' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: `Updated file: ${TD}/overwrite-target.txt`,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'unread overwrite allowed');
    assert(await ctx.readFile(`${TD}/overwrite-target.txt`) === 'Overwritten',
      'unread overwrite should replace the file');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`overwrite-without-read allowed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 12: overwriting a file the conversation HAS read works the same way.
  try {
    const conversation = await createTestConversation(session);
    await executeToolsAndGetContext(conversation, session, [
      createToolCall('read', { file_path: `${TD}/overwrite-target.txt` })
    ]);

    await executeToolsAndGetContext(conversation, session, [
      createToolCall('write', { file_path: `${TD}/overwrite-target.txt`, content: 'Rewritten' })
    ]);

    assert(await ctx.readFile(`${TD}/overwrite-target.txt`) === 'Rewritten',
      'read-then-overwrite should update the file');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`read-then-overwrite allowed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
