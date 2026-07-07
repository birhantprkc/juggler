//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Regression tests for the tool-action row's convergence guard: a tool-action
 * carrying a settled `result` is terminal regardless of `state`.
 *
 * Bug: cancelling a bash tool in the brief APPROVED→RUNNING window let the JS
 * engine's claimRunning() win the Yjs last-write-wins on `state` against the
 * worker's concurrent `state='cancelled'`, while the worker's `result` write
 * (an uncontested key) persisted. The item converged to state='running' +
 * result={cancelled:true,…} — a terminal result under a non-terminal state —
 * so the footer spinner and transcript row stuck on "Running …" forever.
 *
 * These isolate the decision by overriding `_getItem` with a fake and (for
 * render) spying on the `_render*` methods, so no conversation/DOM plumbing is
 * needed.
 * @module unit-tests/tool-action-render
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import '../../js/components/tool-action-message.js'; // registers the custom element

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Minimal Y.Map-ish item; nested result supports .get() like a Y.Map.
 * @param {object} fields - Field values keyed by name (e.g. state, toolName, result).
 * @returns {{get: (k: string) => any}} A Y.Map-like item exposing `.get(key)`.
 */
function fakeItem(fields) {
  const m = new Map(Object.entries(fields));
  if (fields.result && typeof fields.result === 'object') {
    const rm = new Map(Object.entries(fields.result));
    m.set('result', { get: (k) => rm.get(k) });
  }
  return { get: (k) => m.get(k) };
}

/**
 * Run all tool-action render tests.
 * @returns {Promise<TestResult>} Pass/fail counts and error messages.
 */
export async function runTests() {
  let passed = 0, failed = 0; const errors = [];
  const el = /** @type {any} */ (document.createElement('tool-action-message'));

  // A — footer/spinner must go quiet once a result is present, even at state=running.
  try {
    el._getItem = () => fakeItem({
      state: TOOL_STATES.RUNNING, toolName: 'bash',
      result: { content: 'Interrupted', cancelled: true, isError: false },
    });
    const busy = el.getBusyState();
    if (busy !== null) throw new Error(`expected null (terminal), got ${JSON.stringify(busy)}`);
    passed++;
  } catch (e) { failed++; errors.push(`getBusyState terminal-result: ${e.message}`); }

  // B — transcript body must render the cancelled row, not the running row.
  try {
    const calls = [];
    el._renderRunning   = () => calls.push('running');
    el._renderCancelled = () => calls.push('cancelled');
    el._renderResult    = () => calls.push('result');
    el._getItem = () => fakeItem({
      state: TOOL_STATES.RUNNING, toolName: 'bash',
      result: { content: 'Interrupted', cancelled: true, isError: false },
    });
    el.render();
    if (calls.join(',') !== 'cancelled')
      throw new Error(`expected ['cancelled'], got [${calls}]`);
    passed++;
  } catch (e) { failed++; errors.push(`render terminal-result routing: ${e.message}`); }

  return { passed, failed, errors };
}
