//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

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

import { assert } from '../utilities/test-helpers.js';
import {
  POLICY_PROMPT,
  buildReviewerPrompt,
  parseVerdict
} from '../../extensions/juggler-core/strategies/auto-approve-reviewer.js';

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

  return { passed, failed, errors };
}
