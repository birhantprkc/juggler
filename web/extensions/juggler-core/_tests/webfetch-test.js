//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for WebFetch action plugin
 * Tests parameter validation and result formatting in isolation
 */

import WebFetchContextItem from '../context-items/web-fetch-context-item.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * Test valid URLs pass validation
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testValidURLValidation(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  const validURLs = [
    'https://example.com',
    'http://test.org/path',
    'https://sub.domain.com/path?query=value',
    'https://example.com:8080/path'
  ];

  try {
    for (const url of validURLs) {
      const result = await action.validate({ url, prompt: 'test' });
      if (!result.valid) {
        throw new Error(`Valid URL "${url}" failed validation: ${result.error}`);
      }
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test invalid URLs fail validation
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testInvalidURLValidation(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  const invalidURLs = [
    'not-a-url',
    'http://',
    '://missing-protocol',
    'ht tp://bad space.com'
  ];

  try {
    for (const url of invalidURLs) {
      const result = await action.validate({ url, prompt: 'test' });
      if (result.valid) {
        throw new Error(`Invalid URL "${url}" passed validation`);
      }
      if (!result.error) {
        throw new Error(`No error message for invalid URL: ${url}`);
      }
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test missing url parameter fails
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testMissingURLValidation(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    const result = await action.validate({ prompt: 'test' });

    if (result.valid) {
      throw new Error('Missing url should fail validation');
    }
    if (!result.error || !result.error.includes('url')) {
      throw new Error(`Wrong error message: ${result.error}`);
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test prompt is optional — a url alone passes validation (the no-prompt path
 * returns raw content via execute() rather than delegating).
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testOptionalPromptValidation(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    const result = await action.validate({ url: 'https://example.com' });

    if (!result.valid) {
      throw new Error(`url without prompt should pass validation; got error: ${result.error}`);
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test buildSubthreadSpec returns null when there is no prompt (→ execute()
 * runs and returns raw content, no delegation).
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBuildSubthreadSpecNoPrompt(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });
  // No prompt must short-circuit BEFORE any fetch — stub so a stray fetch fails.
  action.fetchRaw = async () => { throw new Error('must not fetch when there is no prompt'); };

  try {
    const spec = await action.buildSubthreadSpec({ url: 'https://example.com' });
    if (spec !== null) {
      throw new Error(`Expected null spec without a prompt, got ${JSON.stringify(spec)}`);
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test buildSubthreadSpec fetches the page and inlines its content into the
 * child's seed prompt (so the child never re-fetches — the recursion fix).
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBuildSubthreadSpecWithPrompt(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });
  // Stub the network: buildSubthreadSpec must fetch via fetchRaw and inline this.
  const PAGE = '# Example Domain\nThe title of this page is Example Domain.';
  action.fetchRaw = async (url) => (
    /** @type {any} */ ({ url, content: PAGE, prompt: '', cached: false, truncated: false })
  );

  try {
    const spec = await action.buildSubthreadSpec({
      url: 'https://example.com',
      goal: 'Find page title',
      prompt: 'what is the title?',
      session: 'example-page'
    });
    if (!spec) {
      throw new Error('Expected a spec when a prompt is present, got null');
    }
    if (spec.goal !== 'Find page title') {
      throw new Error(`spec.goal should be the short caller-supplied label, got ${spec.goal}`);
    }
    if (spec.sessionName !== 'example-page') {
      throw new Error(`spec.sessionName should pass through the public session handle, got ${spec.sessionName}`);
    }
    if (!spec.prompt || !spec.prompt.includes('what is the title?')) {
      throw new Error(`spec.prompt should carry the extraction prompt, got ${spec.prompt}`);
    }
    if (!spec.prompt.includes('Example Domain')) {
      throw new Error('spec.prompt should inline the fetched page content so the child does not re-fetch');
    }
    if (!spec.resultSpec) {
      throw new Error('spec.resultSpec should be set so the child knows the return contract');
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test wrong parameter types fail
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testWrongTypeValidation(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    // url must be string
    let result = await action.validate({ url: 123, prompt: 'test' });
    if (result.valid) {
      throw new Error('Numeric url should fail validation');
    }

    // prompt must be string
    result = await action.validate({ url: 'https://example.com', prompt: 123 });
    if (result.valid) {
      throw new Error('Numeric prompt should fail validation');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test success case formatting
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testSuccessFormatting(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    /** @type {any} */
    const outcome = {
      success: true,
      prepared: { params: { url: 'https://example.com', prompt: 'test' } },
      result: {
        url: 'https://example.com',
        content: 'Test content here',
        prompt: 'test',
        cached: false,
        truncated: false
      }
    };

    const summary = action.getSummary(outcome);

    if (!summary.success) {
      throw new Error('Summary should indicate success');
    }
    if (summary.icon !== '✓') {
      throw new Error(`Expected success icon ✓, got ${summary.icon}`);
    }
    if (!summary.summary.includes('Test content here')) {
      throw new Error('Summary should include content');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test truncated content indicator
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testTruncatedFormatting(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    /** @type {any} */
    const outcome = {
      success: true,
      prepared: { params: { url: 'https://example.com', prompt: 'test' } },
      result: {
        url: 'https://example.com',
        content: 'Content',
        prompt: 'test',
        cached: false,
        truncated: true
      }
    };

    const summary = action.getSummary(outcome);

    if (!summary.summary.includes('truncated')) {
      throw new Error('Summary should include truncation warning');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test cached content indicator
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testCachedFormatting(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    /** @type {any} */
    const outcome = {
      success: true,
      prepared: { params: { url: 'https://example.com', prompt: 'test' } },
      result: {
        url: 'https://example.com',
        content: 'Content',
        prompt: 'test',
        cached: true,
        truncated: false
      }
    };

    const summary = action.getSummary(outcome);

    if (!summary.summary.includes('cache')) {
      throw new Error('Summary should include cache indicator');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test redirect case formatting
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testRedirectFormatting(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    /** @type {any} */
    const outcome = {
      success: true,
      prepared: { params: { url: 'https://example.com', prompt: 'test' } },
      result: {
        url: 'https://example.com',
        content: '',
        prompt: 'test',
        cached: false,
        redirect: true,
        redirect_url: 'https://other.com',
        error: 'Redirects to different host'
      }
    };

    const summary = action.getSummary(outcome);

    if (summary.icon !== '→') {
      throw new Error(`Expected redirect icon →, got ${summary.icon}`);
    }
    if (!summary.summary.includes('https://other.com')) {
      throw new Error('Summary should include redirect URL');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test error case formatting
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testErrorFormatting(session, conversation) {
  const action = new WebFetchContextItem({ id: "web-fetch", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    /** @type {any} */
    const outcome = {
      success: false,
      prepared: { params: { url: 'https://example.com', prompt: 'test' } },
      error: 'Network timeout'
    };

    const summary = action.getSummary(outcome);

    if (summary.success) {
      throw new Error('Summary should indicate failure');
    }
    if (summary.icon !== '✗') {
      throw new Error(`Expected error icon ✗, got ${summary.icon}`);
    }
    if (!summary.summary.includes('Network timeout')) {
      throw new Error('Summary should include error message');
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
    { name: 'Valid URLs pass validation', fn: () => testValidURLValidation(session, conversation) },
    { name: 'Invalid URLs fail validation', fn: () => testInvalidURLValidation(session, conversation) },
    { name: 'Missing url parameter fails', fn: () => testMissingURLValidation(session, conversation) },
    { name: 'Prompt is optional (url alone passes)', fn: () => testOptionalPromptValidation(session, conversation) },
    { name: 'buildSubthreadSpec returns null without a prompt', fn: () => testBuildSubthreadSpecNoPrompt(session, conversation) },
    { name: 'buildSubthreadSpec returns a spec with a prompt', fn: () => testBuildSubthreadSpecWithPrompt(session, conversation) },
    { name: 'Wrong parameter types fail', fn: () => testWrongTypeValidation(session, conversation) },
    { name: 'Success case formatting', fn: () => testSuccessFormatting(session, conversation) },
    { name: 'Truncated content indicator', fn: () => testTruncatedFormatting(session, conversation) },
    { name: 'Cached content indicator', fn: () => testCachedFormatting(session, conversation) },
    { name: 'Redirect case formatting', fn: () => testRedirectFormatting(session, conversation) },
    { name: 'Error case formatting', fn: () => testErrorFormatting(session, conversation) }
  ];

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  for (const test of tests) {
    const result = await test.fn();
    if (result.passed) {
      passed++;
    } else {
      failed++;
      errors.push(`${test.name}: ${result.error || 'unknown error'}`);
    }
  }

  return { passed, failed, errors };
}
