//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// This suite lives inside the about-juggler extension (declared via
// `provides.tests` in juggler.extension.json) rather than the shared js-tests/
// pool, so the extension owns its tests. The test harness discovers it through
// the /api/test/extension-tests endpoint. Imports are extension-local; only the
// shared test harness is reached across the tree (../../../js-tests/utilities).

import JugglerSourceContextItem from '../context-items/juggler-source-context-item.js';
import { assert, createTestConversation, createTestSession, initializeRegistries } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing tests.
 * @property {number} failed Number of failing tests.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {any} session
 * @param {any} conversation
 * @returns {JugglerSourceContextItem} Test context item.
 */
function createItem(session, conversation) {
  return new JugglerSourceContextItem({
    id: 'juggler-source',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
}

/**
 * Run the item's execute() with fetch stubbed, capturing the URL it requested.
 * The asset prefix is set for the duration of the call and restored after, so a
 * test controls the exact prefix rather than inheriting the harness page's.
 * @param {any} item - The context item under test.
 * @param {Record<string, unknown>} params - Params for execute().
 * @param {string|undefined} prefix - Value for globalThis.__assetPrefix (undefined deletes it).
 * @param {{ok: boolean, status?: number, body?: string}} response - Stub fetch response.
 * @returns {Promise<{url: string, result: any, error: string}>} What was fetched and what came back.
 */
async function runExecute(item, params, prefix, response) {
  const realFetch = globalThis.fetch;
  const hadPrefix = '__assetPrefix' in globalThis;
  const realPrefix = /** @type {any} */ (globalThis).__assetPrefix;
  let url = '';
  let result = null;
  let error = '';
  try {
    if (prefix === undefined) {
      delete (/** @type {any} */ (globalThis).__assetPrefix);
    } else {
      /** @type {any} */ (globalThis).__assetPrefix = prefix;
    }
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ requested) => {
      url = requested;
      return {
        ok: response.ok,
        status: response.status ?? 200,
        text: async () => response.body ?? ''
      };
    });
    try {
      result = await item.execute(params);
    } catch (/** @type {any} */ err) {
      error = err.message;
    }
  } finally {
    globalThis.fetch = realFetch;
    if (hadPrefix) {
      /** @type {any} */ (globalThis).__assetPrefix = realPrefix;
    } else {
      delete (/** @type {any} */ (globalThis).__assetPrefix);
    }
  }
  return { url, result, error };
}

/**
 * Run Juggler-source extension tests.
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregate test results.
 */
export async function runTests(_ctx) {
  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ error) {
      failed++;
      errors.push(`${name}: ${error.message}`);
    }
  }

  await test('tool definition is a read tool with no approval', () => {
    const [definition] = JugglerSourceContextItem.getToolDefinitions();
    assert(definition.name === 'ReadJugglerSource', `unexpected tool name ${definition.name}`);
    assert(definition.category === 'read', `unexpected category ${definition.category}`);
    assert(JugglerSourceContextItem.MANIFEST.requiresApproval === false, 'reading bundled source should not require approval');
    assert(definition.input_schema.required.length === 1 && definition.input_schema.required[0] === 'path',
      'path should be the only required input');
  });

  await test('validation accepts the sdk/ and extensions/ trees and a leading web/', async () => {
    const item = createItem(session, conversation);
    assert((await item.validate({ path: 'sdk/context-item.js' })).valid, 'sdk path should validate');
    assert((await item.validate({ path: 'extensions/juggler-core/context-items/read-file-context-item.js' })).valid,
      'extensions path should validate');
    assert((await item.validate({ path: 'web/sdk/command-type.js' })).valid, 'leading web/ should validate');
  });

  await test('validation rejects escapes, out-of-tree prefixes and empty input', async () => {
    const item = createItem(session, conversation);
    assert(!(await item.validate({ path: '' })).valid, 'empty path should fail');
    assert(!(await item.validate({ path: '   ' })).valid, 'blank path should fail');
    assert(!(await item.validate({ path: /** @type {any} */ (42) })).valid, 'non-string path should fail');
    assert(!(await item.validate({ path: 'sdk/../js/app.js' })).valid, 'parent escape should fail');
    assert(!(await item.validate({ path: '/js/app.js' })).valid, 'out-of-tree prefix should fail');
    assert(!(await item.validate({ path: 'resources/juggler-logo.svg' })).valid, 'non-source tree should fail');
  });

  // The regression this suite exists for: the app mounts its assets ONLY under
  // the cache-busting "/v<staticVersion>" prefix, so fetching the bare path 404s.
  await test('execute fetches the version-prefixed asset URL', async () => {
    const { url, result, error } = await runExecute(
      createItem(session, conversation),
      { path: 'sdk/context-item.js' },
      '/vtest',
      { ok: true, body: 'export default class ContextItem {}' }
    );
    assert(error === '', `execute should not have thrown: ${error}`);
    assert(url === '/vtest/sdk/context-item.js', `expected the prefixed URL, fetched ${url}`);
    assert(result.path === 'sdk/context-item.js', `unexpected reported path ${result.path}`);
    assert(result.url === '/sdk/context-item.js', `reported url should stay unprefixed, got ${result.url}`);
    assert(result.content === 'export default class ContextItem {}', 'source text should be returned verbatim');
    assert(result.bytes === result.content.length, 'bytes should be the content length');
  });

  await test('execute leaves the path alone when no asset prefix is set', async () => {
    const { url, error } = await runExecute(
      createItem(session, conversation),
      { path: 'web/extensions/juggler-core/context-items/read-file-context-item.js' },
      undefined,
      { ok: true, body: 'source' }
    );
    assert(error === '', `execute should not have thrown: ${error}`);
    assert(url === '/extensions/juggler-core/context-items/read-file-context-item.js',
      `expected the bare URL, fetched ${url}`);
  });

  await test('execute surfaces the status and the path asked for when the fetch fails', async () => {
    const { error } = await runExecute(
      createItem(session, conversation),
      { path: 'sdk/context-item.js' },
      '/vtest',
      { ok: false, status: 404 }
    );
    assert(error === 'Could not read /sdk/context-item.js (HTTP 404)', `unexpected fetch error: ${error}`);
  });

  await test('execute refuses a path outside the allowed trees', async () => {
    const { url, error } = await runExecute(
      createItem(session, conversation),
      { path: '/js/app.js' },
      '/vtest',
      { ok: true, body: 'source' }
    );
    assert(error === 'path must be under sdk/ or extensions/', `unexpected rejection: ${error}`);
    assert(url === '', 'a rejected path should never be fetched');
  });

  await test('summary returns the source text as the tool result', () => {
    const item = createItem(session, conversation);
    const summary = item.getSummary(/** @type {any} */ ({
      success: true,
      result: { path: 'sdk/context-item.js', url: '/sdk/context-item.js', bytes: 6, content: 'source' }
    }));
    assert(summary.success && summary.summary === 'source', 'summary should be the source text');
    const failure = item.getSummary(/** @type {any} */ ({ success: false, error: 'Could not read /sdk/x.js (HTTP 404)' }));
    assert(!failure.success && failure.summary.includes('HTTP 404'), 'failure summary should keep the error text');
  });

  return { passed, failed, errors };
}
