//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Input-box controls during an active turn
 *
 * The input box exposes controls (New Thread button, slash-commands menu,
 * Close-thread button) that remain clickable while an LLM turn is in flight.
 * These tests pin the worker mid-turn with a paused mock and exercise each
 * control, asserting the active-turn behaviour:
 *
 *   - /thread (new-thread button + slash menu): rejects the request without
 *     cancelling the live turn and asks the user to wait.
 *   - Close thread: previously a non-slash summary message that hit the
 *     `if (isProcessing) return` guard in conversation.sendMessage and was
 *     silently DROPPED mid-turn. Now MessageThread.close() preempts the live
 *     turn (worker-truth cancel) and delivers the summary prompt.
 * @module integration-tests/input-box-turn-guard-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

/**
 * Return the single thread item in root, asserting there is exactly one.
 * @param {any} conversation
 * @param {string} testName
 * @returns {any} The thread Y.Map.
 */
function soleThread(conversation, testName) {
  const threads = conversation.rootMessageThread.items.filter(
    (/** @type {any} */ it) => it.get?.('type') === 'thread'
  );
  if (threads.length !== 1) {
    throw new Error(`${testName}: expected exactly 1 thread, got ${threads.length}`);
  }
  return threads[0];
}

/**
 * Assert a freshly-created user thread is OPEN and EMPTY — no result and no
 * items of its own. An inherited-context thread seeds nothing, and the user
 * has not sent a message, so any item (a user seed or, the bug, an assistant
 * reply) means an LLM turn was dispatched when it should have waited.
 * @param {any} thread
 * @param {string} testName
 */
function assertThreadOpenAndEmpty(thread, testName) {
  const result = thread.get?.('result');
  if (result !== null && result !== undefined && result !== '') {
    throw new Error(`${testName}: new thread should be open (no result), got result=${JSON.stringify(result)}`);
  }
  const items = thread.get?.('items');
  const len = items && typeof items.length === 'number' ? items.length : 0;
  // A sub-thread is born empty (no SYSTEM_1 of its own). "Empty" here means no
  // conversational content: no user/assistant/tool/error items. (The
  // system-prompt skip below is retained so legacy docs that still carry one
  // don't trip this guard.)
  const contentTypes = [];
  for (let i = 0; i < len; i++) {
    const t = items.get(i)?.get?.('type');
    if (t === 'system-prompt') continue;
    contentTypes.push(t);
  }
  if (contentTypes.length !== 0) {
    throw new Error(`${testName}: new thread should be empty (waiting for the user to send), but has content item(s): ${JSON.stringify(contentTypes)}`);
  }
}

/**
 * @param {string} result
 * @returns {import('../utilities/integration-test-runner.js').MockResponse} A return_result tool response.
 */
function returnResultResponse(result) {
  return toolUseResponse('tu-summary', 'return_result', { result }, undefined);
}

/**
 * Recursively assert no item anywhere (parent or nested thread) is left in
 * state='running' — the signature of a turn that was mutated out from under
 * itself instead of being cancelled-and-settled first.
 * @param {any} conversation
 * @param {string} testName
 */
function assertNoOrphanedRunning(conversation, testName) {
  /**
   * @param {any[]} items
   * @param {string} path
   */
  const walk = (items, path) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.get?.('state') === 'running') {
        throw new Error(
          `${testName}: item ${path}[${i}] (type=${it.get?.('type')}) left in ` +
					`state='running' — the live turn was not cancelled before the control acted`
        );
      }
      if (it.get?.('type') === 'thread') {
        const sub = it.get?.('items');
        if (sub && typeof sub.toArray === 'function') {
          walk(sub.toArray(), `${path}[${i}].items`);
        }
      }
    }
  };
  walk(conversation.rootMessageThread.items, 'root');
}

// ============================================================================
// TEST 1: /thread fired mid-turn is rejected without cancelling the live turn
// ============================================================================

/**
 * A root turn is streaming (paused at the mock barrier, exactly as a real
 * long-running turn would leave the worker busy). The user fires /thread (the
 * new-thread button dispatches this command). Expected:
 *   1. The command is rejected and no thread is created.
 *   2. A visible "Wait for the current turn" notice is shown.
 *   3. Releasing the mock lets the original turn complete normally.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadMidTurnCancelsAndNotifiesTest = {
  name: 'thread-mid-turn-cancels-and-notifies',
  description: '/thread mid-turn is rejected without cancelling the active turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Streams partial text then pauses — a live in-flight turn at the moment
    // /thread is fired.
    textResponse('Partial response cut short by new thread.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'Message 1' },
    { type: 'wait-for-mock-paused' },
    // Fire /thread while the worker is paused mid-turn (new-thread button path).
    { type: 'send-message-no-wait', message: '/thread' },
    { type: 'assert-input-warning', textContains: 'Wait for the current turn' },
    { type: 'release-mock' },
    { type: 'wait-for-idle' }
  ],

  customAssertions: (conversation) => {
    const threads = conversation.rootMessageThread.items.filter(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (threads.length !== 0) {
      throw new Error(`Expected /thread to be rejected, got ${threads.length} thread(s)`);
    }
    const status = conversation.processingState?.status;
    if (status && status !== 'idle') {
      throw new Error(`Original active turn did not settle after /thread was rejected: ${status}`);
    }
  }
};

// ============================================================================
// TEST 2: Closing a thread mid-turn preempts the live turn (no silent drop)
// ============================================================================

/**
 * A user-created thread is processing (paused mid-stream). The user clicks
 * "Close thread" which (today) dispatches a plain summary message — that hits
 * `if (isProcessing) return` in conversation.sendMessage and is SILENTLY
 * DROPPED, leaving the thread open forever. The fix routes close through
 * MessageThread.close(), which preempts the live turn (worker-truth cancel)
 * and then delivers the summary prompt so the thread closes with a result.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const closeThreadMidTurnPreemptsTest = {
  name: 'close-thread-mid-turn-preempts',
  description: 'Closing a thread mid-turn cancels the live turn and delivers the summary prompt',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // The thread turn: streams partial text then pauses (live in-flight).
    textResponse('Partial thread work cut short by close.', { pauseBeforeReturn: true }),
    // The close summary turn: the thread answers with return_result.
    returnResultResponse('Summary after mid-turn close.')
  ],

  operations: [
    // Create an empty user thread (pure Yjs mutation, no LLM turn).
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    // Send a message into the thread; it pauses mid-stream.
    { type: 'send-thread-message-no-wait', message: 'Work on it' },
    { type: 'wait-for-mock-paused' },
    // Close the thread mid-turn. Without the fix this summary is silently
    // dropped and the thread never gets a result (wait-for-state times out).
    { type: 'close-thread', message: 'wrap up' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', result: 'Summary after mid-turn close.' }
    ]
  },

  customAssertions: (conversation) => {
    assertNoOrphanedRunning(conversation, 'close-thread-mid-turn-preempts');
  }
};

// ============================================================================
// TEST 3: New-thread button with draft text does NOT auto-run the thread
// ============================================================================

/**
 * Repro for "the new thread immediately starts running": the input-box
 * "New Thread" button dispatches `/thread --draft-message <text>` when the box
 * has text. That must create an OPEN, EMPTY thread with the text seeded only as
 * an unsent DRAFT — it must NOT start an LLM turn. The thread should wait for
 * the user to actually press Send.
 *
 * The conversation already has one completed root turn (the realistic case: you
 * are mid-conversation when you branch), so an inherited-context thread has real
 * parent history to (wrongly) run on if the bug fires.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const newThreadWithDraftDoesNotRunTest = {
  name: 'new-thread-with-draft-does-not-run',
  description: 'New-thread button with draft text creates an open empty thread without starting a turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Root turn 1.
    textResponse('Root reply.'),
    // If the new thread wrongly auto-runs, it would consume this.
    textResponse('THREAD SHOULD NOT HAVE RUN.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello root' },
    // Mimic the New Thread button with text typed in the box.
    { type: 'run-command', command: 'thread', args: '--draft-message Draft for the new thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    // Settle window: if the worker were going to dispatch the thread, it
    // would have by now.
    { type: 'wait-ms', ms: 600 }
  ],

  customAssertions: (conversation) => {
    const thread = soleThread(conversation, 'new-thread-with-draft-does-not-run');
    assertThreadOpenAndEmpty(thread, 'new-thread-with-draft-does-not-run');
    // The draft must be carried on the thread Y.Map for the input box to restore.
    const draft = thread.get?.('draft');
    const draftText = draft && typeof draft.get === 'function' ? draft.get('text') : draft?.text;
    if (!draftText || !String(draftText).includes('Draft for the new thread')) {
      throw new Error(`Expected the typed text to be seeded as the thread draft, got ${JSON.stringify(draftText)}`);
    }
  }
};

// ============================================================================
// TEST 4: New thread while a tool awaits approval does NOT auto-run
// ============================================================================

/**
 * The real-world repro of "the new thread immediately starts running": the
 * parent conversation is parked at `activity=awaiting_llm` because a tool is
 * waiting for the user's approval. New Thread is rejected because the turn is
 * still active, even though the worker is parked at the approval boundary.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const newThreadWhileToolPendingDoesNotRunTest = {
  name: 'new-thread-while-tool-pending-does-not-run',
  description: 'New Thread is rejected while a tool awaits approval',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Parent turn: proposes a bash tool that requires approval. The worker
    // parks at activity=awaiting_llm (idle, tool pending).
    toolUseResponse('call_1', 'bash', { command: 'env echo pending' }, 'Running a command.'),
    // If the new thread wrongly auto-runs, it consumes this response.
    textResponse('THREAD SHOULD NOT HAVE AUTO-RUN.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'Run a command' },
    // Worker reaches the approval gate → parked at awaiting_llm, state idle.
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Press "New Thread" (the button dispatches /thread).
    { type: 'send-message-no-wait', message: '/thread' },
    { type: 'assert-input-warning', textContains: 'Wait for the current turn' },
    { type: 'wait-ms', ms: 200 }
  ],

  customAssertions: (conversation) => {
    const threads = conversation.rootMessageThread.items.filter(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (threads.length !== 0) {
      throw new Error(`Expected /thread to be rejected while approval is pending, got ${threads.length} thread(s)`);
    }
  }
};

// Export all tests
export const tests = [
  threadMidTurnCancelsAndNotifiesTest,
  closeThreadMidTurnPreemptsTest,
  newThreadWithDraftDoesNotRunTest,
  newThreadWhileToolPendingDoesNotRunTest
];
