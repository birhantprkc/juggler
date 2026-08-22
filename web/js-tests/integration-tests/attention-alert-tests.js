//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Attention alert (per-window chime + flash).
 *
 * The attention manager ({@link module:utils/attention-manager}) fires one
 * alert when a conversation needs the user — a tool-action enters
 * awaiting-approval, or a turn completes and the conversation comes to rest —
 * AND the user is NOT looking at that conversation. The conversation the user is
 * actively watching never alerts, and an alert that does fire stands until the
 * conversation is viewed.
 *
 * Both edges are deterministic. For awaiting-approval,
 * `response-handler._handleApprovalFlow` sets the tool-action to pending in the
 * doc and THEN calls `_llmState.pause()` synchronously, so the manager's status
 * observer fires with awaiting=true before `waitForApproval` resolves. For
 * turn-end, the worker bumps the durable `completedTurns` counter and publishes
 * idle in the same settle, so the edge has landed by the time
 * `waitForTurnComplete` resolves.
 *
 * Driving the seam from `customAssertions`:
 *  - The headless harness doesn't load app.js, so `initAttention(session)` is
 *    never called for us — we call it ourselves (the production API) after the
 *    conversation exists but BEFORE the turn starts, so its first observation
 *    seeds the baseline (no alert on load) and the later awaiting edge fires.
 *  - `window.__attention.setFocusedForTest(false|true)` forces "not looking" /
 *    "looking"; cleanup restores real detection with `setFocusedForTest(null)`.
 *  - The out-of-app notification is disabled for the duration so the shared
 *    document-title badge isn't mutated; `alertCount` and the always-on tab flash
 *    are unaffected.
 * @module integration-tests/attention-alert-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import {
  initAttention,
  getAttentionPrefs,
  setNotifyEnabled,
  __attention
} from '../../js/utils/attention-manager.js';

const ATTENTION_TOOL_ID = 'call_attention_1';

/**
 * Wire the attention manager to this test's session, suppress the visible flash
 * surface (title badge), force the focus state, and drive ONE awaiting-approval
 * turn through the real UI. Returns the alert delta observed across that turn so
 * each test asserts a relative count (the manager seeds a baseline silently on
 * its first observation).
 * @param {import('../../js/model/conversation.js').default} conversation
 * @param {{harness: any}} ctx
 * @param {boolean} looking - true → user IS watching this conversation (alert
 *   suppressed); false → user is elsewhere (alert should fire).
 * @returns {Promise<{delta: number, lastAlert: any, convId: string}>} Alert
 *   delta, last alert, and conversation id observed across the turn.
 */
async function runAwaitingTurn(conversation, { harness }, looking) {
  const session = harness.innerHarness.session;
  const prevNotify = getAttentionPrefs().notify;

  // Disable the out-of-app signal so the shared document-title badge isn't
  // mutated; alertCount and the (always-on) tab flash are unaffected.
  setNotifyEnabled(false);
  __attention.setFocusedForTest(looking);

  try {
    // Wire the observer while idle so its first status fire (start/preparing,
    // awaiting=false) seeds the per-conversation baseline without alerting.
    initAttention(session);
    const baseline = __attention.alertCount;

    // Trigger a tool_use that requires approval, through the real composer.
    await harness.driver.typeAndSend('Run the attention echo');
    harness.consumeResponse();
    await harness.awaitPendingSend();

    // Awaiting-approval is now reached in the doc; the pause()-driven edge has
    // already run (synchronous, before this resolves).
    await harness.waitForApproval(ATTENTION_TOOL_ID, 3000);

    const result = {
      delta: __attention.alertCount - baseline,
      lastAlert: __attention.lastAlert,
      convId: conversation.id
    };

    // Let the turn finish so teardown is clean (approve → text reply → idle).
    harness.resolveApprovalNoWait(ATTENTION_TOOL_ID, 'approved');
    await harness.waitForTurnComplete();

    return result;
  } finally {
    __attention.setFocusedForTest(null);
    setNotifyEnabled(prevNotify);
  }
}

/**
 * A conversation that reaches awaiting-approval while the user is NOT looking at
 * it (window unfocused) fires exactly one attention alert, tagged with that
 * conversation's id.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionFiresWhenNotLookingTest = {
  name: 'attention-fires-when-not-looking',
  description: 'Awaiting-approval while unfocused fires exactly one alert for that conversation',
  fixture: 'unit-test-fixture',
  // No approval op appears in `operations` (we drive the turn from
  // customAssertions), so force the non-permissive conversation explicitly —
  // otherwise the harness blanket-grants execute and bash never asks.
  approvalFlow: true,

  llmResponses: [
    toolUseResponse(
      ATTENTION_TOOL_ID,
      'bash',
      { command: 'env echo attention-fires' },
      'Running command.'
    ),
    textResponse('Command completed.')
  ],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, ctx) => {
    const { delta, lastAlert, convId } = await runAwaitingTurn(conversation, ctx, false);
    if (delta !== 1) {
      throw new Error(`expected exactly 1 attention alert while not looking, got ${delta}`);
    }
    if (!lastAlert || lastAlert.convId !== convId) {
      throw new Error(`lastAlert.convId should be ${convId}, got ${lastAlert && lastAlert.convId}`);
    }
  }
};

/**
 * The conversation the user is actively watching (window focused AND it is the
 * visible conversation) never alerts, even when it reaches awaiting-approval.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionSuppressedWhenLookingTest = {
  name: 'attention-suppressed-when-looking',
  description: 'Awaiting-approval on the watched conversation fires no alert',
  fixture: 'unit-test-fixture',
  approvalFlow: true,

  llmResponses: [
    toolUseResponse(
      ATTENTION_TOOL_ID,
      'bash',
      { command: 'env echo attention-suppressed' },
      'Running command.'
    ),
    textResponse('Command completed.')
  ],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, ctx) => {
    // The harness's single conversation is session.visibleConversationId, so
    // with focus forced true the manager treats it as "being looked at".
    const { delta } = await runAwaitingTurn(conversation, ctx, true);
    if (delta !== 0) {
      throw new Error(`expected no attention alert while looking, got ${delta}`);
    }
  }
};

/**
 * The other alert edge: a turn that simply FINISHES while the user is elsewhere.
 * Nothing is waiting on them — the conversation has come to rest, which is the
 * whole news — so this is the edge that makes a background tab worth glancing at,
 * and it is driven by the durable `completedTurns` counter the worker bumps at
 * the idle transition rather than by any approval state.
 *
 * The same test pins the alert's lifetime: it holds until the conversation is
 * viewed. Nothing expires it, so a turn that ended while the user was away is
 * still marked whenever they get back — and returning to it (window focus, with
 * that conversation on screen) is what clears it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionFiresOnTurnEndTest = {
  name: 'attention-fires-on-turn-end',
  description: 'A turn completing unwatched alerts once and stays flagged until viewed',
  fixture: 'unit-test-fixture',

  // A plain text reply: one turn, no tools, no approval — so the only edge
  // available is the turn coming to rest.
  llmResponses: [textResponse('All done.')],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, { harness }) => {
    const session = harness.innerHarness.session;
    const convId = conversation.id;
    const prevNotify = getAttentionPrefs().notify;

    setNotifyEnabled(false);
    __attention.setFocusedForTest(false);

    try {
      // Wire while idle so the first observation seeds the baseline silently.
      initAttention(session);
      const baseline = __attention.alertCount;

      await harness.driver.typeAndSend('Say something and stop');
      harness.consumeResponse();
      await harness.awaitPendingSend();
      await harness.waitForTurnComplete();

      const delta = __attention.alertCount - baseline;
      if (delta !== 1) {
        throw new Error(`expected exactly 1 attention alert for the completed turn, got ${delta}`);
      }
      if (__attention.lastAlert?.convId !== convId) {
        throw new Error(`lastAlert.convId should be ${convId}, got ${__attention.lastAlert?.convId}`);
      }
      if (!__attention.isFlagged(convId)) {
        throw new Error('the conversation must stay flagged after the turn-end alert');
      }

      // The user comes back to it: the window regains focus with this
      // conversation on screen, which is the production clear path.
      __attention.setFocusedForTest(true);
      window.dispatchEvent(new Event('focus'));
      if (__attention.isFlagged(convId)) {
        throw new Error('viewing the conversation must clear its standing alert');
      }
    } finally {
      __attention.setFocusedForTest(null);
      setNotifyEnabled(prevNotify);
    }
  }
};

export const tests = [
  attentionFiresWhenNotLookingTest,
  attentionSuppressedWhenLookingTest,
  attentionFiresOnTurnEndTest
];
