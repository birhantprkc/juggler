//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import ExaSearchContextItem from '../../extensions/exa/context-items/exa-search-context-item.js';
import { assert, createTestConversation, createTestSession, initializeRegistries } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing tests.
 * @property {number} failed Number of failing tests.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {any} session
 * @param {any} conversation
 * @returns {ExaSearchContextItem} Test context item.
 */
function createItem(session, conversation) {
  return new ExaSearchContextItem({
    id: 'exa-search',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
}

/**
 * @param {object} data - Operation result data.
 * @returns {{ok: boolean, json: () => Promise<object>}} Mock fetch response.
 */
function opResponse(data) {
  return {
    ok: true,
    json: async () => ({ success: true, data })
  };
}

/**
 * Run Exa extension tests.
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
    const [definition] = ExaSearchContextItem.getToolDefinitions();
    assert(definition.name === 'exa_search', `unexpected tool name ${definition.name}`);
    assert(definition.category === 'read', `unexpected category ${definition.category}`);
    assert(ExaSearchContextItem.MANIFEST.requiresApproval === false, 'Exa search should not require approval');
    assert(definition.input_schema.required.length === 1 && definition.input_schema.required[0] === 'query',
      'query should be the only required input');
  });

  await test('validation rejects malformed inputs and trims the query', async () => {
    const item = createItem(session, conversation);
    assert(!(await item.validate({ query: '' })).valid, 'empty query should fail');
    assert(!(await item.validate({ query: 'ok', numResults: 101 })).valid, 'out-of-range count should fail');
    assert(!(await item.validate({ query: 'ok', type: 'neural' })).valid, 'unsupported current search type should fail');
    assert(!(await item.validate({ query: 'ok', include_domains: [''] })).valid, 'blank domain should fail');
    const result = await item.validate({ query: '  exa search  ', text: false });
    assert(result.valid && result.params?.query === 'exa search', 'valid query should be trimmed');
  });

  await test('execute resolves the secret and maps tool inputs to Exa JSON', async () => {
    const realFetch = globalThis.fetch;
    /** @type {any[]} */
    const calls = [];
    try {
      globalThis.fetch = /** @type {any} */ (async (_url, init) => {
        const request = JSON.parse(init.body);
        calls.push(request);
        if (request.toolId === 'extconfig') return opResponse({ api_key: 'secret-key' });
        return opResponse({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: JSON.stringify({ requestId: 'req-1', results: [{ title: 'Exa', url: 'https://exa.ai', text: 'Search' }] }),
          truncated: false
        });
      });
      const result = await createItem(session, conversation).execute({
        query: 'search engines',
        numResults: 3,
        type: 'fast',
        include_domains: ['exa.ai'],
        exclude_domains: ['example.com'],
        text: false
      });
      assert(calls.length === 2, `expected two ops calls, got ${calls.length}`);
      assert(calls[0].toolId === 'extconfig' && calls[0].operation === 'resolve', 'first call should resolve config');
      assert(calls[1].toolId === 'http' && calls[1].operation === 'request', 'second call should make HTTP request');
      const http = calls[1].params;
      const body = JSON.parse(http.body);
      assert(http.url === 'https://api.exa.ai/search' && http.method === 'POST', 'unexpected Exa endpoint request');
      assert(http.headers['x-api-key'] === 'secret-key', 'API key header missing');
      assert(body.query === 'search engines' && body.numResults === 3 && body.type === 'fast', 'basic request fields missing');
      assert(body.contents.text === false, 'text option was not forwarded');
      assert(body.includeDomains[0] === 'exa.ai' && body.excludeDomains[0] === 'example.com', 'domain filters missing');
      assert(result.count === 1 && result.provider === 'Exa' && result.requestId === 'req-1', 'unexpected normalized result');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('execute reports missing configuration without making a search request', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = /** @type {any} */ (async () => {
        calls++;
        return opResponse({});
      });
      let message = '';
      try {
        await createItem(session, conversation).execute({ query: 'test' });
      } catch (/** @type {any} */ error) {
        message = error.message;
      }
      assert(/Settings → Extensions → Exa Search/.test(message), `unexpected missing-key error: ${message}`);
      assert(calls === 1, `missing key should stop after config resolution, got ${calls} calls`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('execute surfaces non-2xx JSON errors', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = /** @type {any} */ (async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.toolId === 'extconfig') return opResponse({ api_key: 'secret-key' });
        return opResponse({
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          body: JSON.stringify({ error: 'Invalid API key' }),
          truncated: false
        });
      });
      let message = '';
      try {
        await createItem(session, conversation).execute({ query: 'test' });
      } catch (/** @type {any} */ error) {
        message = error.message;
      }
      assert(message === 'Exa request failed (HTTP 401): Invalid API key', `unexpected API error: ${message}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('execute reports malformed successful JSON', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = /** @type {any} */ (async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.toolId === 'extconfig') return opResponse({ api_key: 'secret-key' });
        return opResponse({ status: 200, statusText: 'OK', headers: {}, body: 'not-json', truncated: false });
      });
      let message = '';
      try {
        await createItem(session, conversation).execute({ query: 'test' });
      } catch (/** @type {any} */ error) {
        message = error.message;
      }
      assert(message === 'Exa returned invalid JSON (HTTP 200)', `unexpected JSON error: ${message}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('summary reads outcome.result and formats links and text', () => {
    const item = createItem(session, conversation);
    const summary = item.getSummary(/** @type {any} */ ({
      success: true,
      prepared: { params: { query: 'test' } },
      result: {
        query: 'test', count: 1, provider: 'Exa',
        results: [{ title: 'Result', url: 'https://example.com', author: 'Author', publishedDate: '2026-01-01', text: 'Snippet' }]
      }
    }));
    assert(summary.success && summary.summary.includes('[Result](https://example.com)'), 'summary should include result link');
    assert(summary.summary.includes('Author — 2026-01-01') && summary.summary.includes('Snippet'), 'summary should include metadata and text');
  });

  return { passed, failed, errors };
}
