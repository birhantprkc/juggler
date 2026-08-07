//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for WebSearch action plugin
 * Tests parsing, domain filtering, and URL building in isolation
 */

import WebSearchContextItem from '../context-items/web-search-context-item.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * Fixture: DuckDuckGo HTML response
 */
const DUCKDUCKGO_HTML_RESPONSE = `
<!DOCTYPE html>
<html>
<body>
	<div class="results">
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://example.com/duck1">Duck Result 1</a>
		</h2>
		<a class="result__snippet" href="https://example.com/duck1">Duck description 1</a>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://test.org/duck2">Tom &amp; Jerry &lt;2&gt;</a>
		</h2>
		<a class="result__snippet" href="https://test.org/duck2">Duck description 2</a>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://sub.example.com/duck3">Duck Result 3</a>
		</h2>
		<a class="result__snippet" href="https://sub.example.com/duck3">Duck <b>description</b> 3</a>
	</div>
	</div>
</body>
</html>
`;

/**
 * Test DuckDuckGo HTML parsing
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDuckDuckGoParsing(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    const results = action.parseDuckDuckGoResponse(DUCKDUCKGO_HTML_RESPONSE);

    // Check count
    if (results.length !== 3) {
      throw new Error(`Expected 3 results, got ${results.length}`);
    }

    // Check first result
    const first = results[0];
    if (first.title !== 'Duck Result 1') {
      throw new Error(`Expected title "Duck Result 1", got "${first.title}"`);
    }
    if (first.url !== 'https://example.com/duck1') {
      throw new Error(`Expected url "https://example.com/duck1", got "${first.url}"`);
    }
    if (first.description !== 'Duck description 1') {
      throw new Error(`Expected description "Duck description 1", got "${first.description}"`);
    }

    // Second result: HTML entities in the title must be decoded.
    if (results[1].title !== 'Tom & Jerry <2>') {
      throw new Error(`Expected decoded title "Tom & Jerry <2>", got "${results[1].title}"`);
    }
    if (results[1].url !== 'https://test.org/duck2') {
      throw new Error(`Expected url "https://test.org/duck2", got "${results[1].url}"`);
    }

    // Third result: inline tags in the snippet must be stripped.
    if (results[2].description !== 'Duck description 3') {
      throw new Error(`Expected stripped description "Duck description 3", got "${results[2].description}"`);
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain matching logic
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainMatching(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    // Exact match
    if (!action.matchesDomain('example.com', 'example.com')) {
      throw new Error('Should match exact domain');
    }

    // Subdomain match
    if (!action.matchesDomain('sub.example.com', 'example.com')) {
      throw new Error('Should match subdomain');
    }

    // Deep subdomain match
    if (!action.matchesDomain('deep.sub.example.com', 'example.com')) {
      throw new Error('Should match deep subdomain');
    }

    // Should NOT match
    if (action.matchesDomain('notexample.com', 'example.com')) {
      throw new Error('Should not match different domain');
    }

    // Should NOT match prefix-only
    if (action.matchesDomain('example.com.attacker.com', 'example.com')) {
      throw new Error('Should not match attacker domain with prefix');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain filtering - allowed domains
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainFilteringAllowed(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  const results = [
    { title: 'Result 1', url: 'https://example.com/page1', description: 'desc1' },
    { title: 'Result 2', url: 'https://test.org/page2', description: 'desc2' },
    { title: 'Result 3', url: 'https://sub.example.com/page3', description: 'desc3' }
  ];

  try {
    // Filter to only example.com (should include subdomains)
    const filtered = action.filterResults(results, ['example.com'], []);

    if (filtered.length !== 2) {
      throw new Error(`Expected 2 results, got ${filtered.length}`);
    }

    if (filtered[0].url !== 'https://example.com/page1') {
      throw new Error('Should include example.com');
    }

    if (filtered[1].url !== 'https://sub.example.com/page3') {
      throw new Error('Should include sub.example.com');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain filtering - blocked domains
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainFilteringBlocked(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  const results = [
    { title: 'Result 1', url: 'https://example.com/page1', description: 'desc1' },
    { title: 'Result 2', url: 'https://test.org/page2', description: 'desc2' },
    { title: 'Result 3', url: 'https://sub.example.com/page3', description: 'desc3' }
  ];

  try {
    // Block example.com (should block subdomains too)
    const filtered = action.filterResults(results, [], ['example.com']);

    if (filtered.length !== 1) {
      throw new Error(`Expected 1 result, got ${filtered.length}`);
    }

    if (filtered[0].url !== 'https://test.org/page2') {
      throw new Error('Should only include test.org');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test DuckDuckGo params building
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDuckDuckGoParamsBuilding(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    const params = action.buildDuckDuckGoParams('test query');
    /** @type {any} */
    const anyParams = params;

    if (anyParams.url !== 'https://html.duckduckgo.com/html/') {
      throw new Error(`Expected DDG URL, got ${anyParams.url}`);
    }

    if (anyParams.method !== 'POST') {
      throw new Error(`Expected POST method, got ${anyParams.method}`);
    }

    if (!anyParams.form_data || anyParams.form_data.q !== 'test query') {
      throw new Error('form_data should contain query');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test empty results handling and blocked-vs-genuine classification.
 *
 * `parseDuckDuckGoResponse` no longer throws on an empty parse — it returns an
 * empty array — and `looksLikeNoResults` distinguishes DuckDuckGo's genuine
 * "no results" page (retained as an empty success) from a rate-limit/captcha
 * page (retried, then surfaced as an error by `search`).
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testEmptyResultsHandling(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    // No result blocks -> empty array, not a throw.
    const blocked = action.parseDuckDuckGoResponse('<html><body></body></html>');
    if (!Array.isArray(blocked) || blocked.length !== 0) {
      throw new Error(`Expected empty array for no result blocks, got ${JSON.stringify(blocked)}`);
    }

    // An empty/anomalous page has no "no results" marker -> treated as blocked.
    if (action.looksLikeNoResults('<html><body></body></html>')) {
      throw new Error('Empty body should not be classified as a genuine no-results page');
    }

    // DuckDuckGo's genuine empty result set carries a no-results marker.
    if (!action.looksLikeNoResults('<div class="no-results">No results.</div>')) {
      throw new Error('no-results marker should be classified as a genuine empty result set');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all tests
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  // Initialize registries and create test session/conversation
  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);

  const tests = [
    { name: 'DuckDuckGo HTML parsing', fn: () => testDuckDuckGoParsing(session, conversation) },
    { name: 'Domain matching logic', fn: () => testDomainMatching(session, conversation) },
    { name: 'Domain filtering (allowed)', fn: () => testDomainFilteringAllowed(session, conversation) },
    { name: 'Domain filtering (blocked)', fn: () => testDomainFilteringBlocked(session, conversation) },
    { name: 'DuckDuckGo params building', fn: () => testDuckDuckGoParamsBuilding(session, conversation) },
    { name: 'Empty and blocked results handling', fn: () => testEmptyResultsHandling(session, conversation) }
  ];

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const test of tests) {
    const result = test.fn();
    if (result.passed) {
      passed++;
    } else {
      failed++;
      errors.push(`${test.name}: ${result.error || 'unknown error'}`);
    }
  }

  return { passed, failed, errors };
}
