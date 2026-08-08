//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Freeze-at-add tests for FileContentContextItem.
 *
 * A pinned file is now snapshotted ONCE at add-time (`onToolCall`) and rides the
 * cached leading prefix (`contextPosition: 'prefix'`); later turns must re-use
 * that frozen snapshot rather than re-reading the live file — that re-read is
 * exactly what re-billed CLAUDE.md/AGENTS.md at full price every turn. These
 * tests stub `_fetchLive` so no backend is needed, and assert (a) onToolCall
 * stores the rendered content, (b) createContextText returns the stored snapshot
 * with NO further fetch, and (c) the manifest position is 'prefix'.
 * @module unit-tests/file-content-freeze-test
 */

import FileContentContextItem from '../../extensions/juggler-core/context-items/file-content-context-item.js';
import DroppedFileContextItem from '../../extensions/juggler-core/context-items/dropped-file-context-item.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Build a FileContentContextItem with stub dependencies and a stubbed
 * `_fetchLive` so the test never touches a backend. `fetches` records each call
 * so a test can assert no re-read happened.
 * @param {object} fetchResult - The canned FetchResult _fetchLive returns
 * @returns {{item: any, fetches: string[]}} The item and a call log
 */
function makeItem(fetchResult) {
  const item = new FileContentContextItem({
    id: 'FILE_1',
    type: 'file-content',
    session: /** @type {any} */ ({ projectPath: '/proj' }),
    conversation: /** @type {any} */ ({}),
    messageThread: /** @type {any} */ ({}),
  });
  /** @type {string[]} */
  const fetches = [];
  item._fetchLive = async () => {
    fetches.push(item.data.path || '');
    return fetchResult;
  };
  return { item, fetches };
}

/**
 * Run FileContentContextItem freeze tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => Promise<void>|void} fn - Assertions
   */
  async function test(name, fn) {
    try { await fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e?.message || e}`); }
  }

  // Manifest position is the source-of-truth for the worker's prefix/tail split.
  await test('file-content manifest position is prefix', () => {
    assert(FileContentContextItem.MANIFEST.contextPosition === 'prefix',
      `expected 'prefix', got '${FileContentContextItem.MANIFEST.contextPosition}'`);
  });
  await test('dropped-file manifest position is prefix', () => {
    assert(DroppedFileContextItem.MANIFEST.contextPosition === 'prefix',
      `expected 'prefix', got '${DroppedFileContextItem.MANIFEST.contextPosition}'`);
  });

  // onToolCall freezes the rendered content into data.content at add-time.
  await test('onToolCall snapshots rendered content', async () => {
    const { item, fetches } = makeItem({
      path: 'src/main.go', isDirectory: false, exists: true,
      content: 'package main\n', language: 'go',
      size: 13, totalLines: 1, lineOffset: 1, lineCount: 1, warning: null,
    });
    await item.onToolCall('file-content', { path: 'src/main.go' });
    assert(item.data.path === 'src/main.go', 'path recorded');
    assert(typeof item.data.content === 'string' && item.data.content.length > 0,
      'content snapshot stored');
    assert(item.data.content.includes('package main'), 'snapshot carries the file body');
    assert(fetches.length === 1, `add-time fetch happens once, got ${fetches.length}`);
  });

  // Later turns: createContextText returns the FROZEN snapshot and does NOT
  // re-read the file — even if the underlying file "changed".
  await test('createContextText returns frozen snapshot, no re-read', async () => {
    const { item, fetches } = makeItem({
      path: 'src/main.go', isDirectory: false, exists: true,
      content: 'package main\n', language: 'go',
      size: 13, totalLines: 1, lineOffset: 1, lineCount: 1, warning: null,
    });
    await item.onToolCall('file-content', { path: 'src/main.go' });
    const frozen = item.data.content;
    const fetchesAfterAdd = fetches.length;

    // Make any live fetch explode: if createContextText re-reads, this throws.
    item._fetchLive = async () => { throw new Error('createContextText must not re-read a frozen pin'); };

    const t1 = await item.createContextText({});
    const t2 = await item.createContextText({});
    assert(t1 === frozen, 'first later-turn render returns the frozen snapshot');
    assert(t2 === frozen, 'snapshot is byte-identical across turns');
    assert(fetches.length === fetchesAfterAdd, 'no additional fetch after add-time');
  });

  // Migration backstop: a legacy pin persisted before freezing has no snapshot,
  // so createContextText falls back to a one-off live render (non-empty).
  await test('legacy pin without snapshot falls back to live render', async () => {
    const { item, fetches } = makeItem({
      path: 'src/main.go', isDirectory: false, exists: true,
      content: 'package main\n', language: 'go',
      size: 13, totalLines: 1, lineOffset: 1, lineCount: 1, warning: null,
    });
    // Simulate an old persisted pin: path only, no frozen content.
    item.data = { path: 'src/main.go', isDirectory: false };
    const text = await item.createContextText({});
    assert(text.includes('package main'), 'legacy pin still renders its content');
    assert(fetches.length === 1, `legacy fallback reads live once, got ${fetches.length}`);
  });

  return { passed, failed, errors };
}
