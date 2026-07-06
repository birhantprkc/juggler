//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Recents tab ordering (manual order + auto-recents).
 *
 * The tab list bumps a conversation toward the top when the user sends in it —
 * the bump is driven from the send action site (Conversation.sendMessage), not
 * from observing replicated state, so loading or refreshing a window never
 * reorders anyone's tabs. User-entered messages go to the absolute top. For
 * LLM-driven recency bumps, a bumped tab never moves up past the leading run of
 * busy tabs: it tucks in just beneath them.
 * @module integration-tests/recents-order-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * Return the live session order (top→bottom) restricted to THIS test's own
 * conversations, so sibling lanes in the multi-iframe pool can't perturb it.
 * @param {any} harness
 * @returns {{ own: string[], live: string[] }} The test's own conversation IDs and their live session order.
 */
function ownOrder(harness) {
  const own = harness.conversationIds();
  const session = harness.innerHarness.session;
  const live = Array.from(session.conversations.keys()).filter((/** @type {string} */ id) => own.includes(id));
  return { own, live };
}

/**
 * @param {string[]} a The actual order.
 * @param {string[]} b The expected order.
 * @param {string} msg Message prefixed to the failure detail.
 */
function assertSeq(a, b, msg) {
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw new Error(`${msg}\n  expected: [${b.join(', ')}]\n  actual:   [${a.join(', ')}]`);
  }
}

/**
 * The most-recently-active tab rises to the top; older ones sink in
 * activity order. No tab is ever busy here, so there is no barrier in play.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const recentsBumpMostRecentOnTopTest = {
  name: 'recents-bump-most-recent-on-top',
  description: 'Sending in a conversation bumps it to the top; activity order wins',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('reply A'),
    textResponse('reply B'),
    textResponse('reply C')
  ],

  // A is the initial conversation ($CONV_0); B, C, D are created here.
  operations: [
    { type: 'create-conversation', name: 'Recents B' },
    { type: 'create-conversation', name: 'Recents C' },
    { type: 'create-conversation', name: 'Recents D' },
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'send-message', message: 'ping A' },
    { type: 'switch-conversation', conversationId: '$CONV_1' },
    { type: 'send-message', message: 'ping B' },
    { type: 'switch-conversation', conversationId: '$CONV_2' },
    { type: 'send-message', message: 'ping C' }
  ],

  /**
   * @param {any} _conversation The conversation the assertion runs against.
   * @param {{harness: any}} root0 The destructured context object carrying the test harness.
   */
  customAssertions: (_conversation, { harness }) => {
    const { own, live } = ownOrder(harness);
    const [A, B, C, D] = own;
    // Activity order was A, then B, then C; D never active. Newest on top,
    // D (untouched) sinks to the bottom.
    assertSeq(live, [C, B, A, D], 'recents order should be newest-active first, untouched last');
  }
};

/**
 * User-entered messages always rise to the top, even when other tabs are busy.
 * LLM-driven recency bumps still never move up past the leading run of busy tabs,
 * so the busy band at the top stays put for non-user changes.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const recentsUserSendBeatsBusyBarrierTest = {
  name: 'recents-user-send-beats-busy-barrier',
  description: 'A user-entered message jumps to the top even past busy tabs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('A stays busy', { pauseBeforeReturn: true }),
    textResponse('D stays busy', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'create-conversation', name: 'Barrier B' },
    { type: 'create-conversation', name: 'Barrier C' },
    { type: 'create-conversation', name: 'Barrier D' },
    // A goes busy and (on user send) rises to the absolute top, where it
    // stays paused.
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'send-message-no-wait', message: 'work A' },
    { type: 'wait-for-mock-paused' },
    // D starts a turn too. User-entered messages now jump to the absolute
    // top even when other tabs are busy.
    { type: 'switch-conversation', conversationId: '$CONV_3' },
    { type: 'send-message-no-wait', message: 'work D' }
  ],

  /**
   * @param {any} _conversation The conversation the assertion runs against.
   * @param {{harness: any}} root0 The destructured context object carrying the test harness.
   */
  customAssertions: async (_conversation, { harness }) => {
    const { own, live } = ownOrder(harness);
    const [A, B, C, D] = own;
    const pos = (/** @type {string} */ id) => live.indexOf(id);
    // User-entered D should jump above already-busy A.
    if (!(pos(D) < pos(A))) {
      throw new Error(`user send in D must jump above busy A — order [${live.join(', ')}]`);
    }
    // D still rose above the never-active tabs B and C.
    if (!(pos(D) < pos(B) && pos(D) < pos(C))) {
      throw new Error(`active D must rise above idle B/C — order [${live.join(', ')}]`);
    }

    // Release both paused turns so teardown is clean.
    harness.innerHarness.switchConversation(D);
    harness.innerHarness.releaseMock();
    await harness.waitForTurnComplete();
    harness.innerHarness.switchConversation(A);
    harness.innerHarness.releaseMock();
    await harness.waitForTurnComplete();
  }
};

export const llmRecentsBusyBarrierTest = {
  name: 'recents-llm-busy-barrier',
  description: 'An LLM-driven recency bump still tucks beneath leading busy tabs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('A stays busy', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'create-conversation', name: 'LLM Barrier B' },
    { type: 'create-conversation', name: 'LLM Barrier C' },
    { type: 'create-conversation', name: 'LLM Barrier D' },
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'send-message-no-wait', message: 'work A' },
    { type: 'wait-for-mock-paused' }
  ],

  /**
   * @param {any} _conversation The conversation the assertion runs against.
   * @param {{harness: any}} root0 The destructured context object carrying the test harness.
   */
  customAssertions: async (_conversation, { harness }) => {
    const { own } = ownOrder(harness);
    const [A, B, C, D] = own;
    const session = harness.innerHarness.session;

    // Simulate a non-user/LLM-side modification of D: caller intentionally uses
    // the default busy-barrier behaviour rather than forceTop.
    session.bumpConversation(D);

    const live = Array.from(session.conversations.keys()).filter((/** @type {string} */ id) => own.includes(id));
    const pos = (/** @type {string} */ id) => live.indexOf(id);
    if (!(pos(A) < pos(D))) {
      throw new Error(`LLM bump in D must stay below busy A — order [${live.join(', ')}]`);
    }
    if (!(pos(D) < pos(B) && pos(D) < pos(C))) {
      throw new Error(`LLM-bumped D must rise above idle B/C — order [${live.join(', ')}]`);
    }

    harness.innerHarness.switchConversation(A);
    harness.innerHarness.releaseMock();
    await harness.waitForTurnComplete();
  }
};

export const llmInsertionBumpsWithBusyBarrierTest = {
  name: 'recents-llm-insertion-bumps-with-busy-barrier',
  description: 'A real LLM response insertion bumps the tab, but not above busy tabs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('D finishes later', { pauseBeforeReturn: true }),
    textResponse('A stays busy', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'create-conversation', name: 'LLM Insert B' },
    { type: 'create-conversation', name: 'LLM Insert C' },
    { type: 'create-conversation', name: 'LLM Insert D' },
    { type: 'switch-conversation', conversationId: '$CONV_3' },
    { type: 'send-message-no-wait', message: 'work D' },
    { type: 'wait-for-mock-paused' },
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'send-message-no-wait', message: 'work A' },
    { type: 'wait-for-mock-paused' }
  ],

  /**
   * @param {any} _conversation The conversation the assertion runs against.
   * @param {{harness: any}} root0 The destructured context object carrying the test harness.
   */
  customAssertions: async (_conversation, { harness }) => {
    const { own } = ownOrder(harness);
    const [A, B, C, D] = own;

    // Release D first while A remains marked busy. Prevent A's tab from being the
    // visible conversation so the switch itself doesn't affect the order being
    // asserted.
    const convA = harness.innerHarness.session.getConversation(A);
    convA.setMetadata('processingState', { status: 'mock-paused' });
    harness.innerHarness.switchConversation(D);
    harness.innerHarness.releaseMock();
    await harness.waitForTurnComplete();

    const live = ownOrder(harness).live;
    const pos = (/** @type {string} */ id) => live.indexOf(id);
    if (!(pos(A) < pos(D))) {
      throw new Error(`LLM insertion in D must stay below busy A — order [${live.join(', ')}]`);
    }
    if (!(pos(D) < pos(B) && pos(D) < pos(C))) {
      throw new Error(`LLM insertion in D must rise above idle B/C — order [${live.join(', ')}]`);
    }

    // Release A so teardown is clean.
    convA.setMetadata('processingState', { status: 'idle' });
    harness.innerHarness.switchConversation(A);
    harness.innerHarness.releaseMock();
    await harness.waitForTurnComplete();
  }
};

export const tests = [
  recentsBumpMostRecentOnTopTest,
  recentsUserSendBeatsBusyBarrierTest,
  llmRecentsBusyBarrierTest,
  llmInsertionBumpsWithBusyBarrierTest
];
