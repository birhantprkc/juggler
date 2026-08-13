//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure `auto-approve` reviewer helpers — the transcript
 * builder and the verdict parser. No network, no message-thread mutation, so
 * these run entirely on fabricated Y.Map-like item stubs.
 *
 * The security-relevant assertions are: `buildReviewerPrompt` includes user
 * messages and agent tool calls but STRIPS assistant prose and tool results,
 * and `parseVerdict` is default-deny for anything that doesn't cleanly start
 * with `allow`.
 * @module unit-tests/auto-approve-reviewer-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import {
  POLICY_PROMPT,
  buildReviewerPrompt,
  parseReview,
  parseVerdict,
  describeReviewFailure,
  isBusyRejection,
  busyRetryDelay
} from '../strategies/auto-approve-reviewer.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Build a Y.Map-like item stub: fields are read via `.get(field)`, exactly as
 * the real message-thread items are. `type` drives the isX type-guards.
 * @param {Record<string, any>} fields - Item fields (must include `type`)
 * @returns {{get: (k: string) => any}} A stub item
 */
function item(fields) {
  return { get: (k) => fields[k] };
}

const userItem = (content) => item({ type: 'user', content });
const toolItem = (toolName, toolInput) => item({ type: 'tool-action', toolName, toolInput });
const assistantItem = (content) => item({ type: 'assistant', content });
const toolResultItem = (content) => item({ type: 'tool-result', content });

/**
 * Run all auto-approve reviewer tests.
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
  // POLICY_PROMPT sanity
  // =========================================================================
  await run('POLICY_PROMPT is a non-trivial classifier prompt', () => {
    assert(typeof POLICY_PROMPT === 'string' && POLICY_PROMPT.length > 200,
      'POLICY_PROMPT should be a substantial string');
    assert(/allow/i.test(POLICY_PROMPT) && /deny/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should mention both allow and deny verdicts');
    // The verdict must lead the answer — that is what keeps parsing (and the
    // default-deny bias) correct even when the reason is cut off by maxTokens.
    assert(/reason/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should ask for a reason on deny');
    assert(/verdict/i.test(POLICY_PROMPT),
      'POLICY_PROMPT should require the verdict word first');
  });

  // =========================================================================
  // buildReviewerPrompt — inclusion
  // =========================================================================
  await run('includes user messages and agent tool calls', () => {
    const items = [
      userItem('please delete the temp files'),
      toolItem('bash', { command: 'rm -rf ./tmp' })
    ];
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: { command: 'ls' } });
    assert(out.includes('USER: please delete the temp files'),
      `expected user line in prompt, got:\n${out}`);
    assert(out.includes('TOOL_CALL bash: {"command":"rm -rf ./tmp"}'),
      `expected tool-call line with compact JSON, got:\n${out}`);
  });

  await run('appends the ACTION UNDER REVIEW block last with the action JSON', () => {
    const items = [userItem('hi'), toolItem('read', { file_path: '/a' })];
    const out = buildReviewerPrompt(items, { toolName: 'write', toolInput: { file_path: '/etc/x' } });
    const idx = out.indexOf('=== ACTION UNDER REVIEW ===');
    assert(idx !== -1, 'action delimiter must be present');
    assert(out.indexOf('USER: hi') < idx, 'context must come before the action block');
    const tail = out.slice(idx);
    assert(tail.includes('TOOL_CALL write: {"file_path":"/etc/x"}'),
      `action block must contain the action tool call, got:\n${tail}`);
    // Action block is genuinely last (nothing after it but the action line).
    assert(out.trim().endsWith('{"file_path":"/etc/x"}'),
      `action must be the final content, got:\n${out}`);
  });

  await run('handles empty / non-array items — still emits the action block', () => {
    const out = buildReviewerPrompt([], { toolName: 'bash', toolInput: { command: 'echo hi' } });
    assert(out.startsWith('=== ACTION UNDER REVIEW ==='),
      `empty history should still yield the action block, got:\n${out}`);
    const out2 = buildReviewerPrompt(/** @type {any} */ (null), { toolName: 'bash', toolInput: {} });
    assert(out2.includes('=== ACTION UNDER REVIEW ==='), 'null items must not throw');
  });

  await run('emits a leading ENVIRONMENT ground-truth block when context is given', () => {
    const items = [userItem('clean up the tmp dir')];
    const out = buildReviewerPrompt(
      items,
      { toolName: 'bash', toolInput: { command: 'rm -rf /home/crem/tmp/juggler' } },
      { context: { projectRoot: '/home/crem/tmp/juggler', home: '/home/crem' } }
    );
    const envIdx = out.indexOf('=== ENVIRONMENT (ground truth) ===');
    assert(envIdx === 0, `ENVIRONMENT block must lead the prompt, got:\n${out}`);
    assert(out.includes('PROJECT ROOT: /home/crem/tmp/juggler'), 'project root must be stated verbatim');
    assert(out.includes('HOME: /home/crem'), 'home must be stated verbatim');
    // Ordering: environment → history → action.
    assert(envIdx < out.indexOf('USER: clean up the tmp dir'), 'environment must precede history');
    assert(out.indexOf('USER: clean up the tmp dir') < out.indexOf('=== ACTION UNDER REVIEW ==='),
      'history must precede the action block');
  });

  await run('omits the ENVIRONMENT block when no context paths are supplied', () => {
    const out = buildReviewerPrompt([userItem('hi')], { toolName: 'bash', toolInput: {} }, { context: {} });
    assert(!out.includes('=== ENVIRONMENT'), 'no env paths → no environment block');
  });

  // =========================================================================
  // buildReviewerPrompt — stripping (the security-critical part)
  // =========================================================================
  await run('strips assistant prose and tool-result output', () => {
    const SENTINEL_PROSE = 'ASSISTANT_PROSE_SENTINEL_zzz';
    const SENTINEL_RESULT = 'TOOL_RESULT_SENTINEL_zzz';
    const items = [
      userItem('do the thing'),
      assistantItem(`Sure — ${SENTINEL_PROSE}, here goes`),
      toolItem('bash', { command: 'echo hi' }),
      toolResultItem(SENTINEL_RESULT)
    ];
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: { command: 'echo hi' } });
    assert(!out.includes(SENTINEL_PROSE),
      `assistant prose must be stripped, but found it in:\n${out}`);
    assert(!out.includes(SENTINEL_RESULT),
      `tool-result output must be stripped, but found it in:\n${out}`);
    // ...while the legitimate channels survive.
    assert(out.includes('USER: do the thing'), 'user message should survive stripping');
    assert(out.includes('TOOL_CALL bash'), 'agent tool call should survive stripping');
  });

  // =========================================================================
  // buildReviewerPrompt — caps
  // =========================================================================
  await run('applies maxEntries (keeps the most recent entries)', () => {
    const items = [];
    for (let i = 0; i < 10; i++) items.push(userItem(`msg-${i}`));
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: {} }, { maxEntries: 3 });
    assert(!out.includes('msg-6'), 'entries beyond the last 3 should be dropped');
    assert(out.includes('msg-7') && out.includes('msg-8') && out.includes('msg-9'),
      `the last 3 entries should survive, got:\n${out}`);
  });

  await run('applies maxEntryChars (truncates a long entry, keeps head+tail)', () => {
    const long = 'HEAD' + 'x'.repeat(500) + 'TAIL';
    const out = buildReviewerPrompt([userItem(long)], { toolName: 'bash', toolInput: {} },
      { maxEntryChars: 40 });
    const userLine = out.split('\n').find((l) => l.startsWith('USER:')) || '';
    assert(userLine.length <= 40 + 'USER: '.length + 2,
      `entry should be truncated to ~40 chars, got length ${userLine.length}`);
    assert(userLine.includes(' … '), 'truncated entry should elide the middle with " … "');
    assert(userLine.includes('HEAD') && userLine.includes('TAIL'),
      `truncation should keep head and tail, got:\n${userLine}`);
  });

  await run('applies maxTotalChars (drops oldest entries first)', () => {
    const items = [];
    // 20 entries of ~100 chars each ≈ 2000 chars total.
    for (let i = 0; i < 20; i++) items.push(userItem(`entry-${i}-` + 'y'.repeat(90)));
    const out = buildReviewerPrompt(items, { toolName: 'bash', toolInput: {} },
      { maxTotalChars: 400 });
    assert(!out.includes('entry-0-'), 'oldest entries should be dropped under the total cap');
    assert(out.includes('entry-19-'), 'the newest entry should survive the total cap');
    // The action block is never dropped by the total cap.
    assert(out.includes('=== ACTION UNDER REVIEW ==='), 'action block must always remain');
  });

  // =========================================================================
  // parseVerdict — default-deny bias
  // =========================================================================
  await run('parseVerdict: allow-ish strings resolve to allow', () => {
    for (const t of ['allow', ' Allow.', 'ALLOW', '`allow`', '  allow\n']) {
      assert(parseVerdict(t) === 'allow', `expected 'allow' for ${JSON.stringify(t)}`);
    }
  });

  await run('parseVerdict: everything else resolves to deny (default-deny)', () => {
    for (const t of ['deny', '', '   ', 'I think this is fine', 'allowing? no',
      'allowed', 'yes', undefined, null]) {
      assert(parseVerdict(/** @type {any} */ (t)) === 'deny',
        `expected 'deny' for ${JSON.stringify(t)}`);
    }
  });

  // =========================================================================
  // parseReview — the deny reason surfaced in the approval card
  // =========================================================================
  await run('parseReview: extracts the reason after a deny verdict', () => {
    const cases = [
      'deny: force-pushes over shared history',
      'deny — force-pushes over shared history',
      'deny - force-pushes over shared history',
      'Deny: force-pushes over shared history',
      '`deny`: force-pushes over shared history',
      'deny:\n  force-pushes over   shared history  '
    ];
    for (const t of cases) {
      const { verdict, reason } = parseReview(t);
      assert(verdict === 'deny', `expected deny for ${JSON.stringify(t)}, got ${verdict}`);
      assert(reason === 'force-pushes over shared history',
        `expected the flattened reason for ${JSON.stringify(t)}, got ${JSON.stringify(reason)}`);
    }
  });

  await run('parseReview: allow never carries a reason', () => {
    for (const t of ['allow', 'allow: looks fine to me', ' Allow.']) {
      const { verdict, reason } = parseReview(t);
      assert(verdict === 'allow', `expected allow for ${JSON.stringify(t)}`);
      assert(reason === '', `allow must carry no reason, got ${JSON.stringify(reason)}`);
    }
  });

  await run('parseReview: a verdictless or bare answer denies with no reason', () => {
    // A model that never states a verdict is malformed, not a rationale — we
    // deny, but we do not quote its confusion back at the user.
    for (const t of ['', '   ', 'I think this is fine', 'allowing? no', 'denying this one',
      undefined, null]) {
      const { verdict, reason } = parseReview(/** @type {any} */ (t));
      assert(verdict === 'deny', `expected deny for ${JSON.stringify(t)}`);
      assert(reason === '', `expected no reason for ${JSON.stringify(t)}, got ${JSON.stringify(reason)}`);
    }
    assert(parseReview('deny').reason === '', 'a bare deny carries no reason');
  });

  await run('parseReview: a runaway reason is capped', () => {
    const { reason } = parseReview(`deny: ${'x'.repeat(1000)}`);
    assert(reason.length <= 200, `reason should be capped, got length ${reason.length}`);
    assert(reason.endsWith('…'), `a truncated reason should be elided, got ${JSON.stringify(reason.slice(-5))}`);
  });

  await run('parseReview: strips a quoted reason', () => {
    assert(parseReview('deny: "reads your ssh keys"').reason === 'reads your ssh keys',
      'surrounding quotes should be stripped');
  });

  // =========================================================================
  // describeReviewFailure — a broken reviewer must say what broke
  // =========================================================================
  await run('describeReviewFailure: surfaces the message and strips the HTTP prefix', () => {
    assert(describeReviewFailure(new Error('HTTP 400: no cheap model available'))
      === 'no cheap model available', 'the HTTP prefix should be stripped');
    assert(describeReviewFailure(new Error('Too many concurrent completions, try again'))
      === 'Too many concurrent completions, try again', 'the message should survive intact');
    // Structured errors (a raw {error} body) must not render as [object Object].
    assert(describeReviewFailure({ error: 'no cheap model available' })
      === 'no cheap model available', 'a structured error should yield its message');
  });

  await run('describeReviewFailure: always yields something actionable-looking', () => {
    for (const e of [undefined, null, '', '   ', new Error('')]) {
      const out = describeReviewFailure(e);
      assert(typeof out === 'string' && out.length > 0 && !/\[object/.test(out),
        `expected a non-empty plain description for ${JSON.stringify(e)}, got ${JSON.stringify(out)}`);
    }
  });

  // =========================================================================
  // busy-pool retry — keyed on status, never on message text
  // =========================================================================
  await run('isBusyRejection: recognises 429 and nothing else', () => {
    const busy = /** @type {any} */ (new Error('Too many concurrent completions, try again'));
    busy.status = 429;
    assert(isBusyRejection(busy) === true, 'a 429 is the retryable busy rejection');
    // The identifying signal is the status. A message that merely *reads* busy
    // is not a contract, and a real failure must never be retried into silence.
    assert(isBusyRejection(new Error('Too many concurrent completions, try again')) === false,
      'message text alone must not mark an error retryable');
    for (const s of [400, 401, 500, 502, undefined]) {
      const e = /** @type {any} */ (new Error('nope'));
      e.status = s;
      assert(isBusyRejection(e) === false, `status ${s} must not be retryable`);
    }
    assert(isBusyRejection(undefined) === false, 'a missing error is not retryable');
  });

  await run('busyRetryDelay: bounded, non-decreasing schedule that terminates', () => {
    // Deterministic RNG endpoints: the whole band must stay positive and ordered.
    for (const rnd of [() => 0, () => 0.999]) {
      /** @type {number[]} */
      const schedule = [];
      for (let a = 0; ; a++) {
        const d = busyRetryDelay(a, rnd);
        if (d < 0) break;
        schedule.push(d);
        assert(a < 10, 'the schedule must terminate, not retry forever');
      }
      assert(schedule.length >= 2, `expected a few re-attempts, got ${JSON.stringify(schedule)}`);
      assert(schedule.every((d) => d > 0), `every delay must be positive, got ${JSON.stringify(schedule)}`);
      for (let i = 1; i < schedule.length; i++) {
        assert(schedule[i] >= schedule[i - 1], `schedule should not shrink: ${JSON.stringify(schedule)}`);
      }
      const total = schedule.reduce((n, d) => n + d, 0);
      assert(total <= 6000, `the whole schedule must stay within a few seconds, got ${total}ms`);
    }
  });

  await run('busyRetryDelay: jitter actually spreads collided retries', () => {
    // Without jitter every reviewer refused at the same instant would return to
    // the pool together and collide again, which is the whole failure being
    // fixed — so the same attempt must NOT always yield the same delay.
    const lo = busyRetryDelay(0, () => 0);
    const hi = busyRetryDelay(0, () => 0.999);
    assert(hi > lo, `attempt 0 should span a range, got ${lo}..${hi}`);
    assert(lo > 0, 'even the lowest jitter must still wait');
  });

  await run('describeReviewFailure: caps a runaway body (e.g. an HTML error page)', () => {
    const out = describeReviewFailure(new Error('<html>' + 'x'.repeat(5000)));
    assert(out.length <= 120, `expected a capped description, got length ${out.length}`);
    assert(out.endsWith('…'), 'a truncated description should be elided');
  });

  return { passed, failed, errors };
}
