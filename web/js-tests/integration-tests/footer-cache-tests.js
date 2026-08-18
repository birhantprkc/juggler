//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests for the conversation-footer token display.
 *
 * The display reads the most recent transaction blob in the thread:
 *
 *  1. Every successful LLM turn stamps a `transactionId` onto the
 *     items it produced, and the worker persists an input/output
 *     blob keyed by that id (carrying authoritative inputTokens /
 *     cachedTokens from the provider).
 *  2. `<conversation-footer>` walks its thread's items backward to
 *     find the most recent transactionId, asks the worker for the
 *     blob, and renders the result.
 *  3. With no anchor in the thread (brand-new conversation, or every
 *     LLM-produced item rewound past) the element hides entirely —
 *     a bar against a budget with no count is information-free noise.
 *
 * Text assertions are substring matches so the formatter rules in
 * token-display.js can evolve without breaking the tests.
 * @module integration-tests/footer-cache-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * Poll for a predicate to become true. The footer fetches the
 * transaction blob asynchronously and re-renders when it lands —
 * poll until satisfied or time out.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @param {string} [label]
 */
async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/**
 * Locate the `<token-display>` element rendered for this conversation.
 * Returns null in headless mode (no tab element) so tests can early-out.
 * @param {import('../../model/conversation.js').default} conversation
 * @returns {HTMLElement|null} The token-display element, or null in headless mode.
 */
function findTokenDisplay(conversation) {
  const tab = /** @type {any} */ (conversation).getTabElement?.();
  if (!tab) return null;
  return /** @type {HTMLElement|null} */ (tab.querySelector('conversation-footer token-display'));
}

/**
 * The integration test fixture short-circuits /api/providers, so
 * conversation.contextWindow stays null and the footer's bar collapses
 * to budget=0 (empty render). Force a known budget so the rest of the
 * test can assert real numbers, and notify the session so the footer
 * re-runs `_updateTokenDisplay` against the new budget.
 * @param {import('../../model/conversation.js').default} conversation
 * @param {number} budget
 */
function forceContextWindow(conversation, budget) {
  /** @type {any} */ (conversation).contextWindow = budget;
  const root = conversation.rootMessageThread;
  if (root) root.contextWindow = budget;
  const session = /** @type {any} */ (conversation)._session;
  if (session?.notifyConversationChange) {
    session.notifyConversationChange('conversation:context-window-updated', conversation);
  }
}

// ============================================================================
// TEST 1: After a successful turn, the footer renders the blob's inputTokens.
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const footerShowsBlobTokensTest = {
  name: 'footer-shows-blob-tokens',
  description: 'After a successful turn, the footer fetches the assistant item\'s transaction blob and renders inputTokens.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 3000, outputTokens: 50, cachedTokens: 2000 })
  ],

  operations: [
    { type: 'send-message', message: 'hello' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hello' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  customAssertions: async (conversation) => {
    // The assistant item must carry a transactionId stamped by the
    // worker — that's the only persisted handle to per-turn tokens.
    // The footer fetches the blob from disk on demand keyed by it.
    const items = conversation.rootMessageThread.items;
    const assistant = items.find((/** @type {any} */ it) => it.get('type') === 'assistant');
    if (!assistant) throw new Error('No assistant item found');
    const txnId = assistant.get('transactionId');
    if (!txnId) throw new Error('Assistant item has no transactionId — worker must stamp one');

    // DOM: the footer's async fetch must resolve and render
    // "Nk cached" reflecting the provider-reported numbers
    // (inputTokens=3000, cachedTokens=2000 from the mock).
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\bcached\b/.test(td.textContent || ''), 3000,
      'token-display renders cached count from blob');
  }
};

// ============================================================================
// TEST 2: Deleting the assistant item hides the footer entirely.
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const footerHidesAfterRewindTest = {
  name: 'footer-hides-after-rewind',
  description: 'Rewinding past every LLM-produced item leaves no transactionId in the thread, so the footer hides entirely.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 1000, cachedTokens: 800 })
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\bcached\b/.test(td.textContent || ''), 3000,
      'footer renders cached count initially');

    // Delete the user message — range-delete cleans up the trailing
    // assistant too, leaving no item with a transactionId.
    const root = conversation.rootMessageThread;
    const items = root.items;
    const firstUserIdx = items.findIndex((/** @type {any} */ it) => it.get('type') === 'user');
    if (firstUserIdx < 0) throw new Error('No user message to delete');
    conversation.deleteRangeWithCleanup(root, firstUserIdx);

    // No anchor → element collapses to empty innerHTML.
    await waitFor(() => (td.textContent || '').trim() === '', 2000,
      'token-display hides entirely once no anchor remains');
  }
};

// ============================================================================
// TEST 3: cache-warn class fires when uncached delta crosses the threshold.
// ============================================================================

/**
 * Drives the warning state directly via `setUsage` — same surface
 * the footer uses — so the test is fast and deterministic.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const footerCacheWarnTest = {
  name: 'footer-cache-warn',
  description: 'token-display gains the cache-warn class when the uncached delta exceeds the warn threshold.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // total > cached so the cached span renders and warn is computed.
    // 20000 - 5000 cached = 15000 uncached (well above the 5000 warn).
    /** @type {any} */ (td).setUsage({
      total: 20000,
      cached: 5000,
      budget: 200000,
    });
    if (!td.classList.contains('cache-warn')) {
      throw new Error(`Expected .cache-warn class with total=20000/cached=5000; classes were: ${td.className}`);
    }
    if (!/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`Expected "Pk new" segment in warning state; got ${JSON.stringify(td.textContent)}`);
    }

    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 1000,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Expected .cache-warn class to clear when uncached==0; classes were: ${td.className}`);
    }
  }
};

// ============================================================================
// TEST 4: While a turn is processing, the footer must not display "cached".
// ============================================================================

/**
 * The anchor was captured at the *previous* turn's end. While a new
 * turn is streaming, the live items list and the persisted blob may
 * transiently describe different prompts — so we suppress the cached
 * portion to avoid implying a hit we don't know we'll get.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const footerCacheHiddenWhileProcessingTest = {
  name: 'footer-cache-hidden-while-processing',
  description: 'token-display suppresses the "cached" portion while the conversation is processing.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 1000 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // Idle baseline.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: false,
    });
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Idle: expected "cached" in text; got ${JSON.stringify(td.textContent)}`);
    }

    // Processing — cached must disappear from the line.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: true,
    });
    if (/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Processing: "cached" must NOT appear; got ${JSON.stringify(td.textContent)}`);
    }
    const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
    if (!cachedSeg || cachedSeg.style.width !== '0%') {
      throw new Error(`Processing: cached bar segment must be 0%; got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
    }
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Processing: cache-warn class must not be set; classes were ${td.className}`);
    }

    // Returning to idle restores cached.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: false,
    });
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Idle after processing: expected "cached" to return; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

// ============================================================================
// TEST 5: an unreported cached count is unknown, and unknown warns about nothing.
// ============================================================================

/**
 * A provider that reports no cache usage for a call leaves `cachedTokens` out
 * of the blob, and the footer passes that absence on as null. Unknown is not a
 * miss: it draws no warning, no `+Nk new`, and no cached slice of the bar. A
 * reported 0 is a measured miss and keeps warning.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const footerCacheUnknownTest = {
  name: 'footer-cache-unknown',
  description: 'token-display treats a null cached count as unknown — no cache-warn, no "+Nk new", no cached bar segment — while a reported 0 still warns.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // 130000 tokens the provider said nothing about. The uncached delta the
    // warning is built on cannot be computed, so none of it may be drawn.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      cached: null,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Unknown cache must not warn; classes were: ${td.className}`);
    }
    if (/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`Unknown cache must render no "+Nk new" segment; got ${JSON.stringify(td.textContent)}`);
    }
    if (/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Unknown cache must render no cached count; got ${JSON.stringify(td.textContent)}`);
    }
    const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
    if (!cachedSeg || cachedSeg.style.width !== '0%') {
      throw new Error(`Unknown cache must leave the cached bar segment at 0%; got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
    }

    // Omitting the field says the same thing as passing null.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`An absent cached count must not warn; classes were: ${td.className}`);
    }
    if (/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`An absent cached count must render no "+Nk new" segment; got ${JSON.stringify(td.textContent)}`);
    }

    // A reported 0 is a miss the provider measured, and reads as one.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      cached: 0,
      budget: 200000,
    });
    if (!td.classList.contains('cache-warn')) {
      throw new Error(`A reported 0 with 130k input must warn; classes were: ${td.className}`);
    }

    // And a reported hit stays quiet, with its count on the line.
    /** @type {any} */ (td).setUsage({
      total: 129916,
      cached: 128425,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`A 98% hit must not warn; classes were: ${td.className}`);
    }
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`A reported hit must render its cached count; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

export const tests = [
  footerShowsBlobTokensTest,
  footerHidesAfterRewindTest,
  footerCacheWarnTest,
  footerCacheHiddenWhileProcessingTest,
  footerCacheUnknownTest
];
