//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Attention alert (per-window chime + flash).
 *
 * The attention manager ({@link module:utils/attention-manager}) fires one
 * alert when a conversation needs the user — a tool-action enters
 * awaiting-approval — AND the user is NOT looking at that conversation. The
 * conversation the user is actively watching never alerts.
 *
 * These tests exercise the awaiting-approval edge, which is deterministic:
 * `response-handler._handleApprovalFlow` sets the tool-action to pending in the
 * doc and THEN calls `_llmState.pause()` synchronously, so the manager's status
 * observer fires with awaiting=true before `waitForApproval` resolves.
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

    // Trigger a tool_use that requires approval, through the real input box.
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
 * A standing visual alert auto-dismisses after the timeout even if the user
 * never returns to the conversation: once flagged, the conversation clears its
 * own marker after `alertTimeoutMs` with no view.
 *
 * Driven through the `flashForTest` seam rather than a real awaiting turn on
 * purpose: the flash surface is gated on the `flash` pref, which lives in
 * localStorage and is therefore SHARED across the whole parallel iframe pool —
 * sibling attention tests toggling it would race a turn-driven flash. The seam
 * arms the real production flash + auto-dismiss timer directly, so this asserts
 * the new timeout behaviour deterministically. (The awaiting-edge → alert wiring
 * is covered by {@link attentionFiresWhenNotLookingTest}.)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const attentionAutoDismissTest = {
  name: 'attention-auto-dismisses',
  description: 'A standing alert clears itself after the timeout without being viewed',
  fixture: 'unit-test-fixture',

  // Unused: this test drives the flash seam directly rather than running a turn,
  // but the runner expects a responses array.
  llmResponses: [textResponse('noop')],

  operations: [],

  /**
   * @param {any} conversation
   * @param {{harness: any}} ctx
   */
  customAssertions: async (conversation, ctx) => {
    const session = ctx.harness.innerHarness.session;
    const convId = conversation.id;

    /**
     * Await a deterministic condition (no fixed sleep), matching the codebase's
     * poll-until-state convention.
     * @param {() => boolean} pred
     * @param {string} label
     */
    const pollUntil = async (pred, label) => {
      const start = Date.now();
      while (Date.now() - start < 3000) {
        if (pred()) return;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error(`Timeout waiting for ${label}`);
    };

    // A short auto-dismiss window keeps the test fast; "not looking" so a clear
    // only comes from the timeout, never from a focus reconcile.
    __attention.setAlertTimeoutForTest(150);
    __attention.setFocusedForTest(false);

    try {
      initAttention(session);

      // Raise the standing flash directly (production path, minus the pref gate).
      __attention.flashForTest(convId);
      if (!__attention.isFlagged(convId)) {
        throw new Error('expected flashForTest to flag the conversation immediately');
      }

      // With no view, the standing alert clears itself once the timeout elapses.
      await pollUntil(() => !__attention.isFlagged(convId), 'auto-dismiss of standing alert');
    } finally {
      __attention.setFocusedForTest(null);
      __attention.setAlertTimeoutForTest(20000);
    }
  }
};

export const tests = [
  attentionFiresWhenNotLookingTest,
  attentionSuppressedWhenLookingTest,
  attentionAutoDismissTest
];
