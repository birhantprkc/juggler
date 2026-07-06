//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Nested-approval status propagation.
 *
 * A tool-action awaiting approval anywhere in the thread tree must light up the
 * whole route from the conversation tab down to the action:
 *   1. `hasPendingApprovalInTree` (the shared predicate) detects a pending
 *      tool-action at any nesting depth, over a Y.Array or a plain JS array.
 *   2. The conversation-bar tab gains `.is-awaiting` when a DEEPLY nested
 *      sub-thread is parked on approval — not just when the root thread is.
 *
 * Test 4 drives `_refreshTabStatus` directly with a stubbed conversation/tab —
 * no session.load(), worker spawn, or /api/providers fetch. Those heavyweight
 * paths are load-sensitive (O(n²) session.load, per-mount network) and would
 * make this assertion flaky under the full iframe pool; the behaviour under
 * test is purely "does _refreshTabStatus run the recursive predicate over the
 * whole tree", which needs none of them.
 *
 * The matching tile-level propagation (ancestor `data-kind="paused"` tiles) is
 * covered end-to-end by the `thread-nested-approval-bubbles-to-ancestor-tile`
 * integration test.
 * @module unit-tests/nested-approval-status-test
 */

import { assert } from '../utilities/test-helpers.js';
import { hasPendingApprovalInTree, isThreadClosed } from '../../js/model/thread-navigation.js';
import { getThreadStatus } from '../../js/utils/thread-display.js';
import '../../js/components/conversation-bar.js';
import '../../js/components/conversation-area.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} state
   * @returns {any} a Y.Map shaped like a tool-action item
   */
  const toolAction = (state) => {
    const m = new Y.Map();
    m.set('type', 'tool-action');
    m.set('toolUseId', `tu_${state}`);
    m.set('state', state);
    return m;
  };
  /**
   * @param {string} itemId
   * @param {any[]} children
   * @returns {any} a Y.Map shaped like a thread item
   */
  const thread = (itemId, children) => {
    const m = new Y.Map();
    m.set('type', 'thread');
    m.set('itemId', itemId);
    const arr = new Y.Array();
    m.set('items', arr);
    if (children && children.length) arr.insert(0, children);
    return m;
  };
  /**
   * @param {any[]} topLevel
   * @returns {any} Root Y.Array living in a fresh doc
   */
  const buildRoot = (topLevel) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    doc.transact(() => { root.insert(0, topLevel); });
    return root;
  };

  // --- 1: deeply nested pending detected (Y.Array input) ---
  try {
    const root = buildRoot([thread('L1', [thread('L2', [toolAction('pending')])])]);
    assert(hasPendingApprovalInTree(root) === true,
      'two-level-nested pending tool-action must be detected via Y.Array');
    assert(hasPendingApprovalInTree(root.toArray()) === true,
      'same, when passed a plain JS array (MessageThread.items)');
    passed++;
  } catch (e) { failed++; errors.push(`nested pending: ${msg(e)}`); }

  // --- 2: direct pending + awaiting_approval state ---
  try {
    const direct = buildRoot([toolAction('pending')]);
    assert(hasPendingApprovalInTree(direct) === true, 'direct pending detected');
    const awaiting = buildRoot([thread('L1', [toolAction('awaiting_approval')])]);
    assert(hasPendingApprovalInTree(awaiting) === true, 'awaiting_approval state detected');
    passed++;
  } catch (e) { failed++; errors.push(`direct/awaiting: ${msg(e)}`); }

  // --- 3: no pending anywhere → false (closed/other states, empty, null) ---
  try {
    const none = buildRoot([thread('L1', [thread('L2', [toolAction('completed')])])]);
    assert(hasPendingApprovalInTree(none) === false,
      'tree with only completed tool-actions must not report pending');
    assert(hasPendingApprovalInTree([]) === false, 'empty array → false');
    assert(hasPendingApprovalInTree(null) === false, 'null → false');
    assert(hasPendingApprovalInTree(undefined) === false, 'undefined → false');
    passed++;
  } catch (e) { failed++; errors.push(`no pending: ${msg(e)}`); }

  // --- 4: conversation-bar tab gains/loses .is-awaiting via _refreshTabStatus ---
  // Stub a conversation + tab and drive _refreshTabStatus directly. The bar is
  // created detached (no connectedCallback → no session/tabs-container lookup),
  // so this exercises only the awaiting-detection logic, not the mount path.
  try {
    const convId = 'conv_test_nested_approval';
    const tab = document.createElement('li');

    // rootMessageThread.items returns the root thread's current JS array of
    // Y.Maps. Back it with a swappable `currentItems` so each phase points the
    // getter at a fresh doc-integrated tree (detached Y types don't expose
    // nested children via toArray()).
    /** @type {any[]} */
    let currentItems = [];
    const conv = {
      _llmState: { isConversationProcessing: () => false },
      rootMessageThread: { get items() { return currentItems; } }
    };

    const bar = /** @type {any} */ (document.createElement('conversation-bar'));
    bar._session = { conversations: new Map([[convId, conv]]) };
    bar._cachedElements = new Map([[convId, tab]]);

    // Baseline: empty tree → not awaiting, not running.
    bar._refreshTabStatus(convId);
    assert(!tab.classList.contains('is-awaiting'),
      'empty conversation must not be marked awaiting');

    // Pending approval two sub-threads deep → tab must light up.
    currentItems = buildRoot([thread('L1', [thread('L2', [toolAction('pending')])])]).toArray();
    bar._refreshTabStatus(convId);
    assert(tab.classList.contains('is-awaiting'),
      'tab must gain .is-awaiting when a deeply-nested sub-thread awaits approval. ' +
			`Classes: "${tab.className}"`);

    // Resolve the nested approval → tab must clear .is-awaiting again, proving
    // the toggle is derived live from the tree, not latched.
    currentItems = buildRoot([thread('L1', [thread('L2', [toolAction('completed')])])]).toArray();
    bar._refreshTabStatus(convId);
    assert(!tab.classList.contains('is-awaiting'),
      'tab must clear .is-awaiting once the nested approval is resolved. ' +
			`Classes: "${tab.className}"`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`tab nested awaiting: ${msg(e)}`);
  }

  // --- 5: getThreadStatus — awaiting trumps the live "running" status ---
  // The tile a thread is parked on has live.threadId === its own itemId and a
  // streaming message, but a pending approval in its subtree must still win so
  // the tile turns orange (paused), not green (running). Regression: the live
  // branch ran before the pending check and masked the orange highlight on the
  // very tile the user is waiting on.
  try {
    const directWaiting = buildRoot([thread('T1', [toolAction('pending')])]).get(0);
    const live = { message: 'Streaming • 10 tokens', threadId: 'T1' };
    const s = getThreadStatus(directWaiting, live);
    assert(s.kind === 'paused',
      `a thread directly awaiting approval must be 'paused' even with a live ` +
			`running status for the same thread; got '${s.kind}'`);

    // And a nested pending (live targets the parent) keeps the parent paused.
    const parentWaiting = buildRoot([thread('P1', [thread('C1', [toolAction('pending')])])]).get(0);
    const sParent = getThreadStatus(parentWaiting, { message: 'Working…', threadId: 'P1' });
    assert(sParent.kind === 'paused',
      `a thread whose descendant awaits approval must be 'paused' even with a ` +
			`live running status; got '${sParent.kind}'`);

    // No pending → the live running status still wins (no false paused).
    const running = buildRoot([thread('T2', [toolAction('completed')])]).get(0);
    const sRun = getThreadStatus(running, { message: 'Streaming…', threadId: 'T2' });
    assert(sRun.kind === 'running',
      `a thread with no pending approval must still report 'running' from its ` +
			`live status; got '${sRun.kind}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`getThreadStatus awaiting-trumps-running: ${msg(e)}`);
  }

  // --- 5b: getThreadStatus — a sibling waiting its turn is 'queued', not 'idle' ---
  // Threads launched together run one at a time. While a sibling is the live
  // thread, the not-yet-run ones are incomplete with no result. A non-null
  // `live` snapshot means the conversation is still processing, so those
  // siblings are waiting their turn ('queued') — only when the conversation
  // goes idle (live === null) does an unfinished thread become 'idle'.
  try {
    const waitingSibling = buildRoot([thread('S1', [])]).get(0);
    const liveOnOther = { message: 'Streaming • 12 tokens', threadId: 'S2' };
    const sQueued = getThreadStatus(waitingSibling, liveOnOther);
    assert(sQueued.kind === 'queued',
      `an incomplete sibling thread must be 'queued' while another thread is ` +
			`live (conversation still processing); got '${sQueued.kind}'`);
    assert(!sQueued.spinner,
      `a queued thread has no active work, so it must not show a spinner`);

    // Conversation idle (no live snapshot) → genuinely 'idle'.
    const sIdle = getThreadStatus(waitingSibling, null);
    assert(sIdle.kind === 'idle',
      `the same incomplete thread must be 'idle' once the conversation is ` +
			`idle (live === null); got '${sIdle.kind}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`getThreadStatus queued-vs-idle: ${msg(e)}`);
  }

  // --- 6: getThreadStatus — awaiting trumps a non-empty `result` ---
  // On reload, a crashed thread gets result="Thread was interrupted". If that
  // thread (or a descendant) is actually parked on a pending approval, the
  // pending signal — a pure function of the live tree — must beat the stale
  // result so the tile renders orange (paused), NOT closed. We never write the
  // "has a pending child" property into the data model; it is always derived.
  try {
    const interruptedButWaiting = buildRoot([thread('I1', [toolAction('pending')])]).get(0);
    interruptedButWaiting.set('result', 'Thread was interrupted');
    const sI = getThreadStatus(interruptedButWaiting, null);
    assert(sI.kind === 'paused',
      `a thread with a stale 'interrupted' result but a live pending approval ` +
			`must be 'paused', not 'closed'; got '${sI.kind}'`);

    // Same when the pending approval is in a nested sub-thread and only the
    // ancestor carries the result (the ancestor must still light up).
    const ancestorClosed = buildRoot([thread('A1', [thread('B1', [toolAction('pending')])])]).get(0);
    ancestorClosed.set('result', 'Thread was interrupted');
    const sA = getThreadStatus(ancestorClosed, null);
    assert(sA.kind === 'paused',
      `an ancestor with a result but a descendant awaiting approval must be ` +
			`'paused' so the orange route stays unbroken; got '${sA.kind}'`);

    // Genuinely closed (result set, nothing pending) still reports 'closed'.
    const reallyClosed = buildRoot([thread('C2', [toolAction('completed')])]).get(0);
    reallyClosed.set('result', 'All done');
    const sC = getThreadStatus(reallyClosed, null);
    assert(sC.kind === 'closed',
      `a thread with a result and no pending approval must report 'closed'; ` +
			`got '${sC.kind}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`getThreadStatus awaiting-trumps-result: ${msg(e)}`);
  }

  // --- 7: isThreadClosed — the one canonical "is this thread finished" seam ---
  // Shared by the tile colour, input-box placement, AND the footer's
  // Reopen/Continue, so they can never disagree. "Closed" = non-empty result
  // AND no live (non-terminal) tool anywhere inside. Crucially this covers
  // RUNNING, not just pending: a stale 'interrupted' result on a thread whose
  // tool is mid-execution must still read open — that is the bounce fix (the
  // input box was hopping parent↔child as the tool cycled pending→running
  // because the running phase fell through to the stale result).
  try {
    for (const liveState of ['pending', 'approved', 'running']) {
      const waiting = buildRoot([thread(`W_${liveState}`, [toolAction(liveState)])]).get(0);
      waiting.set('result', 'Thread was interrupted');
      assert(isThreadClosed(waiting) === false,
        `a thread with a stale result but a ${liveState} tool must NOT be closed`);

      const nested = buildRoot([thread(`N_${liveState}`, [thread('inner', [toolAction(liveState)])])]).get(0);
      nested.set('result', 'Thread was interrupted');
      assert(isThreadClosed(nested) === false,
        `a thread whose descendant has a ${liveState} tool must NOT be closed, even with a result`);
    }

    const finished = buildRoot([thread('F1', [toolAction('completed')])]).get(0);
    finished.set('result', 'All done');
    assert(isThreadClosed(finished) === true,
      'a thread with a result and only terminal tools must be closed');

    const cancelledClosed = buildRoot([thread('F2', [toolAction('cancelled')])]).get(0);
    cancelledClosed.set('result', 'Stopped');
    assert(isThreadClosed(cancelledClosed) === true,
      'cancelled tools are terminal → a thread with a result is closed');

    const noResult = buildRoot([thread('R1', [toolAction('completed')])]).get(0);
    assert(isThreadClosed(noResult) === false,
      'a thread with no result is not closed');

    assert(isThreadClosed(null) === false, 'null thread → not closed');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`isThreadClosed seam: ${msg(e)}`);
  }

  // --- 8: conversation-area._updateThreadHeaderStatus — the third reader ---
  // The column's own header observer must ALSO treat a pending-approval thread
  // as not-finished, so it doesn't force the input box hidden via inline style.
  // Regression: it read raw `result` and set inline display:none on a waiting
  // sub-thread that still carried a stale "interrupted" result from a reload —
  // while the tab's data-hide-input walk wanted to SHOW it — so NEITHER the
  // parent (hidden by the tab) nor the sub-thread (hidden inline) showed a box.
  // The active branch must clear the inline style ('' → defer to CSS), never
  // force-show, so the tab stays the single authority on which column wins.
  try {
    const el = /** @type {any} */ (document.createElement('conversation-area'));
    document.body.appendChild(el); // connectedCallback → render() builds input-box + header
    // Footer needs a _messageThread we don't have here; stub it — this case
    // tests header-status visibility logic, not the footer.
    el.updateFooter = () => {};
    const inputBox = el.querySelector('input-box');
    const cancelBtn = el.querySelector('.thread-cancel-btn');
    assert(!!inputBox && !!cancelBtn, 'conversation-area must render input-box + cancel button');

    try {
      // Waiting sub-thread carrying a stale interrupted result: NOT finished
      // → cancel shown, input deferred to CSS (inline display cleared).
      const waiting = buildRoot([thread('H1', [toolAction('pending')])]).get(0);
      waiting.set('result', 'Thread was interrupted');
      el._updateThreadHeaderStatus(waiting);
      assert(inputBox.style.display !== 'none',
        `waiting thread with stale result must NOT force input-box hidden; ` +
				`inline display was "${inputBox.style.display}"`);
      assert(cancelBtn.style.display !== 'none',
        'waiting thread must keep its Cancel button visible');

      // Genuinely finished thread (result, nothing pending): force hidden.
      const done = buildRoot([thread('H2', [toolAction('completed')])]).get(0);
      done.set('result', 'All done');
      el._updateThreadHeaderStatus(done);
      assert(inputBox.style.display === 'none',
        `a genuinely finished thread must hide its input box; ` +
				`inline display was "${inputBox.style.display}"`);
      assert(cancelBtn.style.display === 'none',
        'a finished thread must hide its Cancel button');

      passed++;
    } finally {
      el.remove();
    }
  } catch (e) {
    failed++;
    errors.push(`_updateThreadHeaderStatus third reader: ${msg(e)}`);
  }

  return { passed, failed, errors };
}
