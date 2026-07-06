//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for glob action execution pipeline.
 * Tests that glob returns matching file paths in tool-result.
 *
 * Uses GOLDEN DATA comparison - compares ENTIRE context structure, not substrings.
 * @module unit-tests/glob-action
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  executeToolsAndGetContext,
  createToolCall,
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

// ============================================================================
// GOLDEN DATA - Expected content
// ============================================================================

/** Single .go file match */
const GLOB_GO_SINGLE = 'src/main.go';

/** No matches result */
const GLOB_NO_MATCHES = 'No files found matching pattern: *.xyz';

/** JSON file match */
const GLOB_JSON_SINGLE = 'config.json';

/** Markdown file match */
const GLOB_MD_SINGLE = 'README.md';

// ============================================================================
// TESTS
// ============================================================================

/**
 * Run all glob action tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: Basic pattern matching (*.go)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', { pattern: '*.go', path: 'src' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: '*.go', path: 'src' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GLOB_GO_SINGLE,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob basic *.go');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`basic *.go: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: No matches found
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', { pattern: '*.xyz' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: '*.xyz' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GLOB_NO_MATCHES,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob no matches');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`no matches: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: JSON pattern matching
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', { pattern: '*.json' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: '*.json' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GLOB_JSON_SINGLE,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob *.json');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`*.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Alias tool name (Glob vs glob)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('Glob', { pattern: '*.md' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'Glob',
        toolInput: { pattern: '*.md' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GLOB_MD_SINGLE,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'Glob alias');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`Glob alias: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Path parameter (subdirectory)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', { pattern: '*.go', path: 'src' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: '*.go', path: 'src' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'src/main.go',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob with path');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`path param: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Missing pattern (validation error)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', {});

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: {}
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Missing required parameter: pattern',
        isError: true
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob missing pattern');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`missing pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: Invalid pattern type (validation error)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('glob', { pattern: 123 });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: 123 }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'Parameter "pattern" must be a string',
        isError: true
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'glob invalid pattern type');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`invalid pattern type: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 8: Multiple parallel glob calls
  try {
    const conversation = await createTestConversation(session);
    const toolCalls = [
      createToolCall('glob', { pattern: '*.json' }),
      createToolCall('glob', { pattern: '*.md' })
    ];

    const { context } = await executeToolsAndGetContext(
      conversation, session, toolCalls
    );

    // Multiple tool calls: processed sequentially (tool-use, tool-result pairs)
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'glob',
        toolInput: { pattern: '*.json' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GLOB_JSON_SINGLE,
        isError: false
      },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'glob',
        toolInput: { pattern: '*.md' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: GLOB_MD_SINGLE,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, toolCalls, 'glob parallel calls');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`parallel calls: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
