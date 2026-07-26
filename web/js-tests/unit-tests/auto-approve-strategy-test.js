//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the `auto-approve` strategy's orchestration (`onToolPending`).
 *
 * The LLM is mocked by overriding the strategy's thin `_complete` seam, so no
 * network call happens. A fake message thread captures `resolveApproval` calls.
 *
 * The contract under test is allow-only + fail-closed:
 *   - verdict `allow` → resolveApproval(toolUseId, 'yes') exactly once;
 *   - verdict `deny` → resolveApproval never called;
 *   - `_complete` throws (429/timeout/network) → never called, no throw escapes;
 *   - malformed/empty text → treated as deny (never called).
 * @module unit-tests/auto-approve-strategy-test
 */

import { assert } from '../utilities/test-helpers.js';
import AutoApproveStrategyType from '../../extensions/juggler-core/strategies/auto-approve-strategy-type.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Construct a strategy with a stubbed LLM and a fake message thread that records
 * every resolveApproval call.
 * @param {(params: any, signal?: any) => Promise<{text: string}>} completeImpl - Stubbed `_complete`
 * @param {{items?: any[], state?: object}} [opts] - Optional thread items / strategy state
 * @returns {{strategy: AutoApproveStrategyType, resolveCalls: any[], completeCalls: any[]}} The strategy and its recorded calls
 */
function makeStrategy(completeImpl, opts = {}) {
  /** @type {any[]} */
  const resolveCalls = [];
  /** @type {any[]} */
  const completeCalls = [];
  const messageThread = /** @type {any} */ ({
    conversation: { session: {} },
    items: opts.items || [],
    resolveApproval: (/** @type {string} */ id, /** @type {string} */ resp) => {
      resolveCalls.push({ id, resp });
    }
  });
  const strategy = new AutoApproveStrategyType({ messageThread });
  strategy._complete = async (/** @type {any} */ params, /** @type {any} */ signal) => {
    completeCalls.push(params);
    return completeImpl(params, signal);
  };
  if (opts.state) strategy.state = opts.state;
  return { strategy, resolveCalls, completeCalls };
}

const PENDING = { toolUseId: 'tid-1', toolName: 'bash', toolInput: { command: 'ls' }, category: 'write' };

/**
 * Run all auto-approve strategy orchestration tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // =========================================================================
  // MANIFEST identity — must NOT inherit Default's id
  // =========================================================================
  await run("MANIFEST reports id 'auto-approve' (not the inherited 'default')", () => {
    const { strategy } = makeStrategy(async () => ({ text: 'deny' }));
    assert(strategy.getManifest().id === 'auto-approve',
      `expected id 'auto-approve', got '${strategy.getManifest().id}'`);
  });

  // =========================================================================
  // allow → approve exactly once
  // =========================================================================
  await run("verdict 'allow' resolves the parked tool with 'yes' exactly once", async () => {
    const { strategy, resolveCalls } = makeStrategy(async () => ({ text: 'allow' }));
    await strategy.onToolPending({ ...PENDING });
    assert(resolveCalls.length === 1, `expected exactly one resolve, got ${resolveCalls.length}`);
    assert(resolveCalls[0].id === 'tid-1' && resolveCalls[0].resp === 'yes',
      `expected resolveApproval('tid-1','yes'), got ${JSON.stringify(resolveCalls[0])}`);
  });

  // =========================================================================
  // deny → never approve
  // =========================================================================
  await run("verdict 'deny' never resolves the tool (stays parked)", async () => {
    const { strategy, resolveCalls } = makeStrategy(async () => ({ text: 'deny' }));
    await strategy.onToolPending({ ...PENDING });
    assert(resolveCalls.length === 0, `deny must not resolve, got ${resolveCalls.length} calls`);
  });

  // =========================================================================
  // _complete throws → fail-closed (never approve, no throw escapes)
  // =========================================================================
  await run('a thrown completion (429/timeout) is fail-closed and does not escape', async () => {
    const { strategy, resolveCalls } = makeStrategy(async () => {
      throw new Error('HTTP 429 — reviewer busy');
    });
    let threw = false;
    try {
      await strategy.onToolPending({ ...PENDING });
    } catch {
      threw = true;
    }
    assert(!threw, 'onToolPending must swallow the error (fail-closed)');
    assert(resolveCalls.length === 0, 'a failed review must not resolve the tool');
  });

  // =========================================================================
  // malformed / empty text → treated as deny
  // =========================================================================
  await run('malformed or empty completion text is treated as deny', async () => {
    for (const text of ['', '   ', 'I think that is fine', 'allowing? no']) {
      const { strategy, resolveCalls } = makeStrategy(async () => ({ text }));
      await strategy.onToolPending({ ...PENDING });
      assert(resolveCalls.length === 0,
        `text ${JSON.stringify(text)} should be deny, but it resolved`);
    }
  });

  // =========================================================================
  // reviewer model plumbing + prompt/system wiring
  // =========================================================================
  await run("defaults to the 'cheap' reviewer model and passes the policy system prompt", async () => {
    const { strategy, completeCalls } = makeStrategy(async () => ({ text: 'deny' }));
    await strategy.onToolPending({ ...PENDING });
    assert(completeCalls.length === 1, 'exactly one completion call expected');
    const params = completeCalls[0];
    assert(params.model === 'cheap', `default model should be 'cheap', got '${params.model}'`);
    assert(typeof params.system === 'string' && params.system.length > 0,
      'a policy system prompt must be passed');
    assert(typeof params.prompt === 'string' && params.prompt.includes('=== ACTION UNDER REVIEW ==='),
      'the prompt must include the action-under-review block');
    assert(params.maxTokens && params.maxTokens <= 512,
      `maxTokens should be small and within the server ceiling, got ${params.maxTokens}`);
  });

  await run('state.reviewerModel overrides the default cheap model', async () => {
    const { strategy, completeCalls } = makeStrategy(async () => ({ text: 'deny' }),
      { state: { reviewerModel: 'default' } });
    await strategy.onToolPending({ ...PENDING });
    assert(completeCalls[0].model === 'default',
      `expected overridden model 'default', got '${completeCalls[0].model}'`);
  });

  return { passed, failed, errors };
}
