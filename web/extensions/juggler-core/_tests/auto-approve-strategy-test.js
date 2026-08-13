//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

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
 *
 * Plus the reporting half: every outcome that leaves the call parked returns a
 * `{note}` for the approval card (carrying the reviewer's reason when it gave
 * one), while an approval returns nothing.
 * @module unit-tests/auto-approve-strategy-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import AutoApproveStrategyType from '../strategies/auto-approve-strategy-type.js';

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
  /** @type {number[]} */
  const waits = [];
  // The parked call's state, as _stillParked reads it. Tests flip this to
  // simulate the human resolving the call mid-retry.
  const toolState = { state: 'pending' };
  const messageThread = /** @type {any} */ ({
    conversation: { session: { projectPath: '/home/crem/tmp/juggler', home: '/home/crem', platform: 'linux' } },
    items: opts.items || [],
    getToolAction: () => ({ get: (/** @type {string} */ k) => (k === 'state' ? toolState.state : undefined) }),
    resolveApproval: (/** @type {string} */ id, /** @type {string} */ resp) => {
      resolveCalls.push({ id, resp });
    }
  });
  const strategy = new AutoApproveStrategyType({ messageThread });
  strategy._complete = async (/** @type {any} */ params, /** @type {any} */ signal) => {
    completeCalls.push(params);
    return completeImpl(params, signal);
  };
  // Record the backoff instead of sleeping — the schedule is asserted, no test
  // spends real seconds waiting for it.
  strategy._wait = async (/** @type {number} */ ms) => { waits.push(ms); };
  if (opts.state) strategy.state = opts.state;
  return { strategy, resolveCalls, completeCalls, waits, toolState };
}

/**
 * A rejection shaped like the server's "pool saturated" response: OpsError
 * carries HTTP 429, which is what marks it retryable.
 * @returns {Error & {status: number}} The busy rejection
 */
function busyError() {
  const err = /** @type {any} */ (new Error('Too many concurrent completions, try again'));
  err.name = 'OpsError';
  err.status = 429;
  return err;
}

const PENDING = { toolUseId: 'tid-1', toolName: 'bash', toolInput: { command: 'ls' }, category: 'write', permissionKey: 'bash' };

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
    const result = await strategy.onToolPending({ ...PENDING });
    assert(resolveCalls.length === 1, `expected exactly one resolve, got ${resolveCalls.length}`);
    assert(resolveCalls[0].id === 'tid-1' && resolveCalls[0].resp === 'yes',
      `expected resolveApproval('tid-1','yes'), got ${JSON.stringify(resolveCalls[0])}`);
    // An approved call has no approval card left to annotate.
    assert(result === undefined, `an allow must return no note, got ${JSON.stringify(result)}`);
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
  // the deny note — what the approval card is left showing
  // =========================================================================
  await run("a deny returns a note carrying the reviewer's own reason", async () => {
    const { strategy, resolveCalls } = makeStrategy(
      async () => ({ text: 'deny: force-pushes over shared history' }));
    const note = (await strategy.onToolPending({ ...PENDING }))?.note ?? '';
    assert(resolveCalls.length === 0, 'a deny must still resolve nothing');
    assert(note.includes('force-pushes over shared history'),
      `the note must carry the reviewer's reason, got ${JSON.stringify(note)}`);
  });

  await run('a reasonless deny still returns a note', async () => {
    const { strategy } = makeStrategy(async () => ({ text: 'deny' }));
    const note = (await strategy.onToolPending({ ...PENDING }))?.note ?? '';
    assert(note.length > 0, 'expected a note even without a reason');
  });

  await run('a failed review names the actual cause, not just "unavailable"', async () => {
    // The causes need entirely different fixes (configure a cheap model / wait /
    // re-auth), so collapsing them into one apology leaves the user stuck. The
    // HTTP prefix is noise and is stripped.
    for (const [thrown, expected] of [
      ['HTTP 400: no cheap model available', 'no cheap model available'],
      ['Too many concurrent completions, try again', 'Too many concurrent completions, try again'],
      ['provider "openaicodex" unavailable: no credential', 'no credential']
    ]) {
      const { strategy } = makeStrategy(async () => { throw new Error(thrown); });
      const note = (await strategy.onToolPending({ ...PENDING }))?.note ?? '';
      assert(note.includes(expected),
        `the note must carry the cause ${JSON.stringify(expected)}, got ${JSON.stringify(note)}`);
      assert(!/HTTP \d/.test(note), `the HTTP prefix should be stripped, got ${JSON.stringify(note)}`);
    }
  });

  // =========================================================================
  // a saturated completion pool is retried, not treated as a failure — this is
  // the ordinary condition of a turn that parks several calls at once
  // =========================================================================
  await run('a busy pool is retried and the verdict still lands', async () => {
    let calls = 0;
    const { strategy, resolveCalls, completeCalls, waits } = makeStrategy(async () => {
      calls++;
      if (calls < 3) throw busyError();
      return { text: 'allow' };
    });
    await strategy.onToolPending({ ...PENDING });
    assert(completeCalls.length === 3, `expected 2 refusals then a verdict, got ${completeCalls.length} calls`);
    assert(resolveCalls.length === 1, `the review should still approve, got ${resolveCalls.length} resolves`);
    assert(waits.length === 2, `expected a backoff before each re-attempt, got ${JSON.stringify(waits)}`);
    assert(waits.every((w) => w > 0), `backoffs must be non-zero, got ${JSON.stringify(waits)}`);
    // Non-decreasing schedule. Not strictly increasing: the jitter bands are
    // allowed to touch at their edges, and asserting `>` would be a rare flake
    // rather than a real contract.
    assert(waits[1] >= waits[0], `backoff should not shrink, got ${JSON.stringify(waits)}`);
  });

  await run('the prompt is built once and reused across re-attempts', async () => {
    let calls = 0;
    const { strategy, completeCalls } = makeStrategy(async () => {
      calls++;
      if (calls < 3) throw busyError();
      return { text: 'deny' };
    });
    await strategy.onToolPending({ ...PENDING });
    assert(completeCalls.length === 3, 'expected three attempts');
    assert(completeCalls[0].prompt === completeCalls[2].prompt,
      'a re-attempt must re-send the same prompt, not rebuild a drifted one');
  });

  await run('an unrelentingly busy pool gives up and says so', async () => {
    const { strategy, resolveCalls, completeCalls, waits } = makeStrategy(async () => { throw busyError(); });
    const note = (await strategy.onToolPending({ ...PENDING }))?.note ?? '';
    assert(resolveCalls.length === 0, 'an exhausted review must leave the call parked');
    // Bounded: the schedule must not retry forever behind the user's back.
    assert(completeCalls.length >= 2 && completeCalls.length <= 6,
      `retries should be bounded and non-trivial, got ${completeCalls.length} attempts`);
    assert(waits.length === completeCalls.length - 1, 'one backoff between each attempt');
    assert(/too many reviews/i.test(note),
      `the note should explain the queue, not quote the server, got ${JSON.stringify(note)}`);
  });

  await run('a re-attempt is abandoned once the human resolves the call', async () => {
    const { strategy, completeCalls, toolState } = makeStrategy(async () => {
      // The user approves it themselves while the first attempt is being refused.
      toolState.state = 'approved';
      throw busyError();
    });
    const note = (await strategy.onToolPending({ ...PENDING }))?.note ?? '';
    assert(completeCalls.length === 1,
      `a settled call must not be re-reviewed, got ${completeCalls.length} attempts`);
    assert(note.length > 0, 'the outcome is still reported');
  });

  await run('a non-busy failure is never retried', async () => {
    const { strategy, completeCalls } = makeStrategy(async () => {
      throw new Error('HTTP 400: no cheap model available');
    });
    await strategy.onToolPending({ ...PENDING });
    assert(completeCalls.length === 1,
      `a fatal error must not be retried, got ${completeCalls.length} attempts`);
  });

  await run('a cancelled turn reports nothing (the user knows they stopped it)', async () => {
    const { strategy, resolveCalls } = makeStrategy(async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    });
    const result = await strategy.onToolPending({ ...PENDING });
    assert(result === undefined,
      `an aborted review must leave no note, got ${JSON.stringify(result)}`);
    assert(resolveCalls.length === 0, 'an aborted review must not resolve the tool');
  });

  await run('a call the reviewer never sees returns no note at all', async () => {
    // Edits and non-auto-approvable calls bail before any review, so there is
    // nothing to report — the card must not claim the reviewer weighed in.
    const { strategy } = makeStrategy(async () => ({ text: 'allow' }));
    const edit = await strategy.onToolPending({
      toolUseId: 'tid-edit', toolName: 'edit', toolInput: { path: 'src/a.js' },
      category: 'write', permissionKey: 'write-file'
    });
    assert(edit === undefined, `an edit must return no note, got ${JSON.stringify(edit)}`);
    const plan = await strategy.onToolPending({
      toolUseId: 'tid-plan', toolName: 'plan', toolInput: { action: 'submit' },
      category: 'meta', permissionKey: 'plan', autoApprovable: false
    });
    assert(plan === undefined, `a plan submit must return no note, got ${JSON.stringify(plan)}`);
  });

  // =========================================================================
  // file edits are out of the reviewer's remit — never reviewed, never resolved
  // =========================================================================
  await run("an edit-family tool (permissionKey 'write-file') is never reviewed, even on 'allow'", async () => {
    const { strategy, resolveCalls, completeCalls } = makeStrategy(async () => ({ text: 'allow' }));
    await strategy.onToolPending({
      toolUseId: 'tid-edit', toolName: 'edit',
      toolInput: { path: 'src/a.js', old_str: 'a', new_str: 'b' },
      category: 'write', permissionKey: 'write-file'
    });
    assert(completeCalls.length === 0,
      `edits must never reach the reviewer, but _complete ran ${completeCalls.length} time(s)`);
    assert(resolveCalls.length === 0,
      `edits must stay parked for the human, but resolveApproval ran ${resolveCalls.length} time(s)`);
  });

  // =========================================================================
  // non-auto-approvable calls (plan submit, catastrophic delete) are never
  // reviewed — the reviewer honours the autoApprovable seam and stays out
  // =========================================================================
  await run("a plan submit (autoApprovable:false) is never reviewed, even on 'allow'", async () => {
    const { strategy, resolveCalls, completeCalls } = makeStrategy(async () => ({ text: 'allow' }));
    await strategy.onToolPending({
      toolUseId: 'tid-plan', toolName: 'plan',
      toolInput: { action: 'submit', title: 'Do it', items: [{ content: 'step' }] },
      category: 'meta', permissionKey: 'plan', autoApprovable: false
    });
    assert(completeCalls.length === 0,
      `a plan submit must never reach the reviewer, but _complete ran ${completeCalls.length} time(s)`);
    assert(resolveCalls.length === 0,
      `a plan submit must stay parked for the human, but resolveApproval ran ${resolveCalls.length} time(s)`);
  });

  await run("a catastrophic delete (autoApprovable:false) is never reviewed, even on 'allow'", async () => {
    const { strategy, resolveCalls, completeCalls } = makeStrategy(async () => ({ text: 'allow' }));
    await strategy.onToolPending({
      toolUseId: 'tid-rm', toolName: 'bash',
      toolInput: { command: 'rm -rf /home/crem/tmp/juggler' },
      category: 'write', permissionKey: 'execute', autoApprovable: false
    });
    assert(completeCalls.length === 0,
      `a catastrophic delete must never reach the reviewer, but _complete ran ${completeCalls.length} time(s)`);
    assert(resolveCalls.length === 0,
      `a catastrophic delete must stay parked for the human, but resolveApproval ran ${resolveCalls.length} time(s)`);
  });

  // Note: the guarantee that an elicitation (AskUserQuestion) is never handed to
  // the reviewer lives at the dispatch level — see tool-pending-hook-test's
  // "elicitation skips the hook". onToolPending is gate-only by contract, so the
  // strategy carries no per-call guard to unit-test here.

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
