//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Thread Cancellation & Auto-Resume
 *
 * Tests that cancellation propagates correctly through nested threads:
 * - Escape/cancel during a thread stops all loops (no auto-resume)
 * - Tool denial in a thread stops everything (denial = user said "no")
 * - Escape during pending approval stops all loops (no auto-resume)
 * - Cancelled threads can be manually resumed, triggering auto-resume of parents
 * - Denial in thread does NOT auto-resume parent with fabricated result
 * @module integration-tests/thread-cancellation-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST 1: Cancel during thread stops all loops
// ============================================================================

/**
 * Root creates thread → thread runs bash → user hits Escape while focused IN the
 * sub-thread → the worker turn is interrupted but the thread stays OPEN (no
 * result). Interrupting from the thread's own vantage never closes it, so the
 * composer stays in the child column and the user can keep interacting with it.
 * No further LLM responses are consumed (the worker is idle; nothing re-drives).
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be interrupted)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelDuringThreadTest = {
  name: 'interrupt-during-thread-keeps-open',
  description: 'Escape inside a sub-thread interrupts it but leaves it open (no result)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'cancel' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      // Sub-thread interrupted but still OPEN — no result stamped.
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('interrupt-during-thread-keeps-open: thread item missing');
    // Open: the interrupted thread carries no result.
    const result = thread.get('result');
    if (typeof result === 'string' && result.length > 0) {
      throw new Error(
        `interrupt-during-thread-keeps-open: thread was closed (result='${result}') — ` +
				'an own-vantage interrupt must leave the thread open'
      );
    }
    // The running tool was cancelled (worker-truth interrupt).
    const sub = thread.get('items');
    const arr = sub && typeof sub.toArray === 'function' ? sub.toArray() : [];
    const tool = arr.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action');
    if (!tool) throw new Error('interrupt-during-thread-keeps-open: tool-action missing in thread');
    if (tool.get('state') !== 'cancelled') {
      throw new Error(
        `interrupt-during-thread-keeps-open: expected tool state 'cancelled', got '${tool.get('state')}'`
      );
    }
    // Because the sub-thread is still open, the root remains "busy" — so the
    // composer stays in the child column (the user keeps interacting with it),
    // which is the whole point of interrupt-not-close.
    if (!conversation.rootMessageThread.hasBusyItems()) {
      throw new Error(
        'interrupt-during-thread-keeps-open: root is not busy — the open sub-thread ' +
				'should keep the composer in the child column'
      );
    }
  }
};

// ============================================================================
// TEST 2: Deny tool in thread stops everything
// ============================================================================

/**
 * Root creates thread → thread requests bash → user denies → EVERYTHING stops.
 * Denial = the user explicitly said "no". The thread should NOT get a fabricated
 * result, and the parent should NOT continue or auto-resume.
 *
 * This is the critical fix: previously, denial would fabricate a thread result
 * from the last assistant text and the parent would continue with that result,
 * consuming the next LLM response. Now denial propagates as cancellation.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (will be denied)
 *   3. Root: should NOT be consumed (denial stops everything)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const denyToolInThreadTest = {
  name: 'deny-tool-in-thread-stops-all',
  description: 'Deny tool in thread stops thread AND parent (no auto-resume)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "do something"' },
      'About to run command.'
    ),
    // This response should NOT be consumed — denial stops everything
    textResponse('This should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'deny-thread-tool', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      // Thread has NO result — denial does not fabricate a result
      { type: 'thread', itemId: '$ITEM_3' }
      // No assistant message — parent did NOT continue
    ]
  }
};

// ============================================================================
// TEST 3: Cancel during thread pending approval
// ============================================================================

/**
 * Thread has pending bash approval → user hits Escape while focused in the
 * sub-thread → the pending approval is cancelled and the worker stops, but the
 * sub-thread stays OPEN (no result), so the user can keep interacting with it.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (pending approval, will be cancelled)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelDuringThreadApprovalTest = {
  name: 'interrupt-during-thread-approval-keeps-open',
  description: 'Escape while a sub-thread awaits approval interrupts it but leaves it open',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "hello"' },
      'Need to run this.'
    ),
    textResponse('Should not appear.'),
    textResponse('Root should not appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    // Cancel while approval is pending (simulates Escape inside the sub-thread)
    { type: 'cancel' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      // Sub-thread interrupted but still OPEN — no result stamped.
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('interrupt-during-thread-approval-keeps-open: thread item missing');
    const result = thread.get('result');
    if (typeof result === 'string' && result.length > 0) {
      throw new Error(
        `interrupt-during-thread-approval-keeps-open: thread was closed (result='${result}') — ` +
				'an own-vantage interrupt must leave the thread open'
      );
    }
  }
};

// ============================================================================
// TEST 4: Thread auto-resume parent (manual resume after cancel)
// ============================================================================

/**
 * Root creates thread → thread is interrupted (Escape inside it leaves it OPEN)
 * → user continues it directly (no reopen needed, because interrupt never closes
 * the thread) → thread completes → parent auto-resumes and continues. This is
 * the improved UX: interrupting a sub-thread leaves you in it, ready to type the
 * next message.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread (first run): bash tool (will be interrupted)
 *   3. Thread (resumed): return_result "Task done"
 *   4. Root (auto-resumed): text "All finished."
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadAutoResumeParentTest = {
  name: 'thread-auto-resume-parent',
  description: 'Continuing an interrupted (still-open) thread completes it and auto-resumes parent',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Run it' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running.'
    ),
    // After interrupt + continue, thread gets this:
    toolUseResponse('call_3', 'return_result', { result: 'Task done' }),
    // Parent auto-resumes and gets this:
    textResponse('All finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    // Interrupt during thread execution — leaves the thread OPEN.
    { type: 'cancel' },
    // Continue the still-open thread directly (no reopen needed).
    { type: 'send-thread-message', message: 'Continue please' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'All finished.' }
    ]
  }
};

// ============================================================================
// TEST 4b: Root-vantage stop closes the sub-thread
// ============================================================================

/**
 * Same setup as the interrupt test, but the user stops from the ROOT/parent
 * vantage (Escape while focused on the root, or the root footer Stop). From the
 * parent's vantage the running sub-thread is "below" and is CLOSED: the worker
 * turn is preempted, the tool is cancelled, and the sub-thread settles with
 * result='Cancelled' so the composer returns to the root column.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be cancelled)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelFromRootClosesThreadTest = {
  name: 'root-vantage-stop-closes-subthread',
  description: 'Stopping from the root vantage closes the running sub-thread (Cancelled)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'cancel-from-root' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      // Closed from the root vantage.
      { type: 'thread', itemId: '$ITEM_3', result: 'Cancelled' }
    ]
  },

  customAssertions: (conversation) => {
    // Closed thread → root no longer busy → composer returns to root column.
    if (conversation.rootMessageThread.hasBusyItems()) {
      throw new Error(
        'root-vantage-stop-closes-subthread: root still busy after root-vantage stop — ' +
				'the sub-thread did not close'
      );
    }
  }
};

// ============================================================================
// TEST 5: Deny in thread does NOT auto-resume parent
// ============================================================================

/**
 * Root creates thread → thread calls two tools → first succeeds, second denied
 * → thread stops → parent does NOT auto-resume (no fabricated result).
 *
 * This tests the specific edge case where the thread had prior assistant text
 * that could be misused as a fabricated "result". The parent must NOT continue.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (auto-approved, succeeds)
 *   3. Thread: bash tool (requires approval, will be denied)
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const denyInThreadNoAutoResumeTest = {
  name: 'deny-in-thread-no-auto-resume',
  description: 'Tool denial in thread does not auto-resume parent with fabricated result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Multi-step task', prompt: 'Do steps' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "dangerous thing"' },
      'First I need to run this dangerous command.'
    ),
    // This response should NOT be consumed — denial stops everything
    textResponse('Parent should NOT see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Do multi-step' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    // Deny the tool
    { type: 'deny-thread-tool', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Do multi-step' },
      // Thread has NO result — even though there was prior assistant text
      { type: 'thread', itemId: '$ITEM_3' }
      // No assistant message — parent did NOT auto-resume
    ]
  }
};

// ============================================================================
// TEST 6: Explicit cancel-thread settles the thread closed (worker-truth)
// ============================================================================

/**
 * The user creates a thread, sends a message that runs a long bash tool, then
 * hits the thread's stop affordance (conversation.cancelThread). Expected:
 *   1. The in-flight worker turn is cancelled and the worker goes idle —
 *      cancelThread is worker-truth, not a bare result write.
 *   2. The running tool settles to state='cancelled' (no orphaned running).
 *   3. The thread settles CLOSED with result='Cancelled' so the parent's input
 *      box returns (isThreadClosed becomes true).
 *
 * RED before the fix: the old cancelThread only wrote result='Cancelled by user'
 * and never stopped the worker, so the sleep-10 bash kept running and the
 * processing status never reached 'idle' within the test window.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelThreadSettlesClosedTest = {
  name: 'cancel-thread-settles-closed',
  description: 'Explicit cancelThread stops the worker and settles the thread closed with a Cancelled summary',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running long command.'
    ),
    // Must NOT be consumed — cancel stops the loop.
    textResponse('Should not appear.')
  ],

  operations: [
    // User-created (empty) thread, then a message that runs the long tool.
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message-no-wait', message: 'Run long command' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // Explicit per-thread stop. Post-fix this cancels the worker turn and
    // settles the thread.
    { type: 'cancel-thread' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', result: 'Cancelled' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('cancel-thread-settles-closed: thread item missing');
    const sub = thread.get('items');
    const arr = sub && typeof sub.toArray === 'function' ? sub.toArray() : [];
    const tool = arr.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action');
    if (!tool) throw new Error('cancel-thread-settles-closed: tool-action missing in thread');
    const state = tool.get('state');
    if (state !== 'cancelled') {
      throw new Error(
        `cancel-thread-settles-closed: expected tool state 'cancelled', got '${state}' ` +
				'(worker turn was not cancelled)'
      );
    }
  }
};

// ============================================================================
// TEST 7: Stop affordance on the parent thread tile
// ============================================================================

/**
 * While a sub-thread is running, its PARENT tile (in the root column) must
 * expose a stop button — not only the drilled-in column header. Clicking it
 * routes to the unified cancel (cancel-thread-requested → conversation.cancelThread),
 * settling the thread closed with result='Cancelled'.
 *
 * RED before the fix: no `.thread-stop-btn` is rendered on the tile.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadTileStopButtonTest = {
  name: 'thread-tile-stop-button',
  description: 'The parent thread tile exposes a stop button that settles the running thread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    // The running tile must show a stop button (scoped to the root column).
    { type: 'assert-dom', selector: 'thread-message .thread-stop-btn' },
    // Clicking it settles the thread via the unified cancel.
    { type: 'click-dom', selector: 'thread-message .thread-stop-btn' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Cancelled' }
    ]
  }
};

// Export all tests
export const tests = [
  cancelDuringThreadTest,
  denyToolInThreadTest,
  cancelDuringThreadApprovalTest,
  threadAutoResumeParentTest,
  cancelFromRootClosesThreadTest,
  denyInThreadNoAutoResumeTest,
  cancelThreadSettlesClosedTest,
  threadTileStopButtonTest
];
