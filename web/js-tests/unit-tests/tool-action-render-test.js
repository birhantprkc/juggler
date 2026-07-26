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
 *
 * Also covers the auto-approve review indicator's in-place update: a
 * reviewStatus-only change is churn (`_isReviewStatusChurn` → true) so the live
 * approval buttons are never rebuilt, and a first paint with `reviewStatus.busy`
 * renders the `.approval-review-status` row above the buttons.
 * @module unit-tests/tool-action-render
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import '../../js/components/tool-action-message.js'; // registers the custom element
import '../../js/components/action-confirmation.js'; // registers <action-confirmation>

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

  // C — a reviewStatus-only change on a mounted approval widget is in-place
  // churn: _isReviewStatusChurn must return true (so the observer skips the
  // destructive render() that would rebuild the buttons under the cursor), and
  // false when no action-confirmation is mounted.
  try {
    const base = {
      state: TOOL_STATES.PENDING, hasResult: false, resultIsError: false,
      hasApprovalOptions: true, displayDataJson: '{"cmd":"echo"}', reviewStatusJson: '',
    };
    const next = { ...base, reviewStatusJson: '{"busy":true,"label":"Auto-approve reviewing…"}' };

    const mounted = /** @type {any} */ (document.createElement('tool-action-message'));
    mounted.appendChild(document.createElement('action-confirmation'));
    if (mounted._isReviewStatusChurn(base, next) !== true)
      throw new Error('expected churn=true when only reviewStatus changes with buttons mounted');

    const bare = /** @type {any} */ (document.createElement('tool-action-message'));
    if (bare._isReviewStatusChurn(base, next) !== false)
      throw new Error('expected churn=false when no action-confirmation is mounted');

    // A displayData change alongside reviewStatus is NOT review-status churn.
    const both = { ...next, displayDataJson: '{"cmd":"ls"}' };
    if (mounted._isReviewStatusChurn(base, both) !== false)
      throw new Error('expected churn=false when displayData also changed');
    passed++;
  } catch (e) { failed++; errors.push(`reviewStatus churn guard: ${e.message}`); }

  // D — first paint with reviewStatus.busy renders the .approval-review-status
  // row above the approval buttons.
  try {
    const paintEl = /** @type {any} */ (document.createElement('tool-action-message'));
    const container = document.createElement('div');
    container.className = 'action-approval-container';
    paintEl._appendApprovalButtons(container, fakeItem({
      toolUseId: 't-review', toolName: 'bash',
      approvalOptions: { options: [{ label: 'Approve', value: 'yes' }] },
      reviewStatus: { busy: true, label: 'Auto-approve reviewing…' },
    }));
    const row = container.querySelector('.approval-review-status');
    const buttons = container.querySelector('action-confirmation');
    if (!row) throw new Error('expected a .approval-review-status row on first paint');
    const labelEl = row.querySelector('.approval-review-status-label');
    if (!labelEl || labelEl.textContent !== 'Auto-approve reviewing…')
      throw new Error(`expected the manifest label, got ${labelEl && labelEl.textContent}`);
    if (!buttons) throw new Error('expected action-confirmation buttons present');
    // Row must precede the buttons in document order.
    const rowBeforeButtons = !!(row.compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!rowBeforeButtons) throw new Error('review-status row must be above the buttons');
    passed++;
  } catch (e) { failed++; errors.push(`review-status first paint: ${e.message}`); }

  return { passed, failed, errors };
}
