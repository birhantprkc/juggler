//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for grep action execution pipeline.
 * Tests that search tools return content directly in tool-result (not as context items).
 *
 * Uses GOLDEN DATA comparison - compares ENTIRE context structure, not substrings.
 * @module unit-tests/search-action
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

// ============================================================================
// GOLDEN DATA - Expected search results (new simplified format)
// ============================================================================

/** grep for "main" - matches in src/main.go (scoped to src/) */
const GREP_MAIN_RESULTS = 'src/main.go:\n' +
	'1: package main\n' +
	'5: func main() {';

/** grep for "add" - finds the add function */
const GREP_ADD_RESULTS = 'src/main.go:\n' +
	'9: func add(a, b int) int {';

/** grep for non-existent pattern */
const GREP_NO_MATCHES = 'No matches found for pattern: thisPatternDoesNotExistAnywhere12345';

/** grep for "package" */
const GREP_PACKAGE = 'src/main.go:\n' +
	'1: package main';

/** grep for "import" */
const GREP_IMPORT = 'src/main.go:\n' +
	'3: import "fmt"';

/** grep for "func" */
const GREP_FUNC = 'src/main.go:\n' +
	'5: func main() {\n' +
	'9: func add(a, b int) int {';

/** grep for "func" in files_with_matches mode (default) - returns only file paths */
const GREP_FUNC_FILES = 'src/main.go';

/** grep for "func" in count mode - returns match counts per file */
const GREP_FUNC_COUNT = 'src/main.go:2';

/** grep for "func" with head_limit=1 - first match only with pagination hint */
const GREP_FUNC_LIMIT_1 = 'src/main.go:\n' +
	'5: func main() {\n' +
	'\n' +
	'(Showing 1 of 2 matches. Use offset=1 to see more.)';

// ============================================================================
// TESTS
// ============================================================================

/**
 * Run all search action tests.
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

  // Test 1: grep returns matches in tool-result (no context item created)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('grep', { pattern: 'main', output_mode: 'content', path: 'src', glob: '*.go' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'main', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_MAIN_RESULTS,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep content mode');

    // Verify NO context item was created
    const grepContextItems = conversation.rootMessageThread.contextItems.filter(
      (/** @type {any} */ f) => f.type === 'grep' || f.type === 'search'
    );
    assert(grepContextItems.length === 0, 'grep action should NOT create a context item');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`grep basic: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: grep for function definition (replaces old find_symbol test)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('grep', { pattern: 'func add', output_mode: 'content', path: 'src', glob: '*.go' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'func add', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_ADD_RESULTS,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep func add');

    // Verify NO context item was created
    const grepContextItems = conversation.rootMessageThread.contextItems.filter(
      (/** @type {any} */ f) => f.type === 'grep' || f.type === 'search'
    );
    assert(grepContextItems.length === 0, 'grep action should NOT create a context item');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`grep func add: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: grep with no matches returns appropriate message
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('grep', {
      pattern: 'thisPatternDoesNotExistAnywhere12345'
    });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'thisPatternDoesNotExistAnywhere12345' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_NO_MATCHES,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep no matches');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`grep no matches: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Multiple grep calls in sequence (not parallel to avoid race issues)
  try {
    const conversation = await createTestConversation(session);

    const call1 = createToolCall('grep', { pattern: 'package', output_mode: 'content', path: 'src', glob: '*.go' });
    await executeToolsAndGetContext(conversation, session, [call1]);

    const call2 = createToolCall('grep', { pattern: 'import', output_mode: 'content', path: 'src', glob: '*.go' });
    const { context } = await executeToolsAndGetContext(
      conversation, session, [call2]
    );

    // GOLDEN: The ENTIRE expected context (two complete turns)
    const expected = [
      // First turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'package', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_PACKAGE,
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'grep',
        toolInput: { pattern: 'import', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: GREP_IMPORT,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [call1, call2], 'grep multiple');

    // Verify no context items were created
    const grepContextItems = conversation.rootMessageThread.contextItems.filter(
      (/** @type {any} */ f) => f.type === 'grep' || f.type === 'search'
    );
    assert(grepContextItems.length === 0, 'parallel grep calls should NOT create context items');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`parallel grep: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Same search multiple times (actions are stateless, no deduplication)
  try {
    const conversation = await createTestConversation(session);

    // First search
    const call1 = createToolCall('grep', { pattern: 'func', output_mode: 'content', path: 'src', glob: '*.go' });
    await executeToolsAndGetContext(conversation, session, [call1]);

    // Second search with same pattern
    const call2 = createToolCall('grep', { pattern: 'func', output_mode: 'content', path: 'src', glob: '*.go' });
    const { context } = await executeToolsAndGetContext(conversation, session, [call2]);

    // GOLDEN: The ENTIRE expected context (both searches, both have full results)
    const expected = [
      // First turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'func', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_FUNC,
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'grep',
        toolInput: { pattern: 'func', output_mode: 'content', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: GREP_FUNC,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [call1, call2], 'grep no dedup');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`no deduplication: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: files_with_matches mode (default) - returns only file paths
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('grep', { pattern: 'func', path: 'src', glob: '*.go' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'func', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_FUNC_FILES,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep files_with_matches mode');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`files_with_matches mode: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: count mode - returns match counts per file
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('grep', { pattern: 'func', output_mode: 'count', path: 'src', glob: '*.go' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'func', output_mode: 'count', path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_FUNC_COUNT,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep count mode');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`count mode: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 8: head_limit pagination
  try {
    const conversation = await createTestConversation(session);
    // Request content mode but limit to 1 match
    const toolCall = createToolCall('grep', {
      pattern: 'func',
      output_mode: 'content',
      head_limit: 1,
      path: 'src',
      glob: '*.go'
    });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'grep',
        toolInput: { pattern: 'func', output_mode: 'content', head_limit: 1, path: 'src', glob: '*.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: GREP_FUNC_LIMIT_1,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'grep head_limit pagination');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`head_limit pagination: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
