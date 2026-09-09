//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// This suite lives inside the exa extension (declared via `provides.tests` in
// juggler.extension.json) rather than the shared js-tests/ pool, so the
// extension owns its tests. The test harness discovers it through the
// /api/test/extension-tests endpoint. Imports are extension-local; only the
// shared test harness is reached across the tree (../../../js-tests/utilities).

import ExaSearchContextItem from '../context-items/exa-search-context-item.js';
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
 * Run a search against a stubbed Exa endpoint and hand back the request it sent.
 * @param {ExaSearchContextItem} item - Item under test.
 * @param {Record<string, unknown>} params - Tool parameters.
 * @param {object[]} [results] - Results the stub returns.
 * @returns {Promise<{body: any, result: any}>} Parsed Exa request body and normalized result.
 */
async function captureSearch(item, params, results = []) {
  const realFetch = globalThis.fetch;
  /** @type {any} */
  let body = null;
  try {
    globalThis.fetch = /** @type {any} */ (async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.toolId === 'extconfig') return opResponse({ api_key: 'secret-key' });
      body = JSON.parse(request.params.body);
      return opResponse({
        status: 200, statusText: 'OK', headers: {}, truncated: false,
        body: JSON.stringify({ results })
      });
    });
    const result = await item.execute(params);
    return { body, result };
  } finally {
    globalThis.fetch = realFetch;
  }
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
    assert(!(await item.validate({ query: 'ok', contents: 'summary' })).valid, 'unsupported contents mode should fail');
    assert(!(await item.validate({ query: 'ok', maxCharacters: 0 })).valid, 'out-of-range maxCharacters should fail');
    assert(!(await item.validate({ query: 'ok', maxCharacters: 20000 })).valid, 'above-ceiling maxCharacters should fail');
    const result = await item.validate({ query: '  exa search  ', contents: 'none' });
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
        contents: 'none'
      });
      assert(calls.length === 2, `expected two ops calls, got ${calls.length}`);
      assert(calls[0].toolId === 'extconfig' && calls[0].operation === 'resolve', 'first call should resolve config');
      assert(calls[1].toolId === 'http' && calls[1].operation === 'request', 'second call should make HTTP request');
      const http = calls[1].params;
      const body = JSON.parse(http.body);
      assert(http.url === 'https://api.exa.ai/search' && http.method === 'POST', 'unexpected Exa endpoint request');
      assert(http.headers['x-api-key'] === 'secret-key', 'API key header missing');
      assert(body.query === 'search engines' && body.numResults === 3 && body.type === 'fast', 'basic request fields missing');
      assert(body.contents.text === false && body.contents.highlights === undefined,
        'contents "none" should ask Exa for no page content');
      assert(body.includeDomains[0] === 'exa.ai' && body.excludeDomains[0] === 'example.com', 'domain filters missing');
      assert(result.count === 1 && result.provider === 'Exa' && result.requestId === 'req-1', 'unexpected normalized result');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('search asks for highlights by default, capped per result', async () => {
    const item = createItem(session, conversation);
    const { body } = await captureSearch(item, { query: 'exa', numResults: 8 });
    assert(body.contents.text === undefined, 'default search should not ask for full page text');
    const cap = body.contents.highlights?.maxCharacters;
    assert(Number.isInteger(cap) && cap > 0 && cap <= 10000, `highlights should carry a character cap, got ${cap}`);
    assert(cap <= item.truncationBudget(), `per-result cap ${cap} exceeds the whole budget`);
  });

  await test('full text is capped per result and shrinks as results are added', async () => {
    const item = createItem(session, conversation);
    const few = await captureSearch(item, { query: 'exa', contents: 'text', numResults: 2 });
    const many = await captureSearch(item, { query: 'exa', contents: 'text', numResults: 40 });
    assert(few.body.contents.highlights === undefined, 'text mode should not also request highlights');
    const fewCap = few.body.contents.text?.maxCharacters;
    const manyCap = many.body.contents.text?.maxCharacters;
    assert(Number.isInteger(fewCap) && fewCap <= 10000, `text should carry a character cap, got ${fewCap}`);
    assert(manyCap < fewCap, `cap should fall as results rise, got ${fewCap} then ${manyCap}`);
    assert(manyCap > 0, 'cap should never reach zero');
  });

  await test('an explicit maxCharacters overrides the derived cap', async () => {
    const item = createItem(session, conversation);
    const { body } = await captureSearch(item, { query: 'exa', contents: 'text', maxCharacters: 750 });
    assert(body.contents.text.maxCharacters === 750, `explicit cap ignored, got ${body.contents.text?.maxCharacters}`);
  });

  await test('summary of oversized results stays within the truncation budget', () => {
    const item = createItem(session, conversation);
    const budget = item.truncationBudget();
    const results = [1, 2, 3].map(n => ({
      title: `Result ${n}`, url: `https://example.com/${n}`, text: 'x'.repeat(300000)
    }));
    const summary = item.getSummary(/** @type {any} */ ({
      success: true,
      prepared: { params: { query: 'test' } },
      result: { query: 'test', count: 3, provider: 'Exa', results }
    }));
    assert(summary.summary.length <= budget + 200,
      `summary was ${summary.summary.length} chars against a budget of ${budget}`);
    assert(/Output truncated from/.test(summary.summary), 'oversized summary should say it was truncated');
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

  await test('summary renders highlight snippets', () => {
    const item = createItem(session, conversation);
    const summary = item.getSummary(/** @type {any} */ ({
      success: true,
      prepared: { params: { query: 'test' } },
      result: {
        query: 'test', count: 1, provider: 'Exa',
        results: [{ title: 'Result', url: 'https://example.com', highlights: ['First snippet', 'Second snippet'] }]
      }
    }));
    assert(summary.summary.includes('First snippet') && summary.summary.includes('Second snippet'),
      'summary should include every highlight');
  });

  return { passed, failed, errors };
}
