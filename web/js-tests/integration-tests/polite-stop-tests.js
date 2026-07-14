//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Polite Stop (Pause)
 *
 * Pause is the non-destructive stop: let everything in flight finish and record
 * its real result, then rest at idle before the next LLM turn. Nothing is marked
 * Interrupted or Cancelled; the only thing that does NOT happen is the next turn.
 *
 * These drive the real front-end entry (conversation.requestPoliteStop, via the
 * `pause` operation — the same call the footer Pause button and shift+Escape
 * make) against the real worker, so they exercise the whole path end to end.
 * @module integration-tests/polite-stop-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST 1: Pause lets the current tool finish, then rests before the next turn
// ============================================================================

/**
 * User pauses while a tool sits at its approval prompt, then approves. The tool
 * runs to completion and records a real result — nothing is cancelled — and the
 * worker rests at idle instead of driving the model to react. The second scripted
 * response must NOT be consumed.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const pauseRestsBeforeNextTurnTest = {
  name: 'polite-stop-rests-before-next-turn',
  description: 'Pause lets the in-flight tool finish, then rests at idle before the next LLM turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo "done"' }, 'Running.'),
    // The model must NOT be re-invoked after the tool completes under Pause.
    textResponse('Should not appear after pause.')
  ],

  operations: [
    { type: 'send-message', message: 'Run command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Pause while parked on the approval (the worker is busy → latch is set).
    { type: 'pause' },
    // Approving after the latch is set still runs the tool (D2) to completion.
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Once the tool is terminal the reducer would re-drive → Pause suppresses it.
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run command' },
    { type: 'assistant', content: 'Running.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      // Completed, NOT cancelled: Pause never interrupts in-flight work.
      state: 'completed'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    // Strict: exactly 4 items — the model was not re-invoked (no 5th assistant).
    if (items.length !== 4) {
      throw new Error(
        `Expected exactly 4 items (rested before next turn), got ${items.length}: ` +
          items.map(i => i.type).join(', ')
      );
    }
    // The optimistic pending cue self-clears once the worker reaches idle.
    if (conversation.isPolitePending()) {
      throw new Error('politePending cue should have cleared once the worker rested at idle');
    }
  }
};

// ============================================================================
// TEST 2: A plain Stop while a Pause is pending escalates to a hard cancel
// ============================================================================

/**
 * D7 — escalation. After Pause is pressed on a running tool, a plain Stop
 * (Escape / footer Stop) must still hard-cancel: the tool is interrupted
 * (state=cancelled) and the LLM loop stops. Pause does not block escalation, and
 * the hard cancel supersedes the pending latch.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const pauseThenHardCancelEscalatesTest = {
  name: 'polite-stop-then-hard-cancel-escalates',
  description: 'A plain Stop while a Pause is pending escalates to a full hard cancel (D7)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo "running"; sleep 10' }, 'Starting.'),
    // Must never be consumed — the hard cancel stops the loop.
    textResponse('Should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run and escalate' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // Pause first (latch set while the tool is genuinely running)...
    { type: 'pause' },
    // ...then escalate with a plain Stop — this must hard-cancel the tool.
    { type: 'cancel' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run and escalate' },
    { type: 'assistant', content: 'Starting.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'cancelled'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    if (items.length !== 4) {
      throw new Error(
        `Expected exactly 4 items (hard cancel stopped the loop), got ${items.length}`
      );
    }
  }
};

// ============================================================================
// TEST 3: Un-pausing a pending Pause lets the next turn run (button toggle-off)
// ============================================================================

/**
 * The Pause button is a toggle: a second click while a Pause is still pending
 * cancels it. Here the user pauses on the approval prompt, then un-pauses before
 * approving. Because the latch was dropped, the tool completes AND the reducer
 * re-drives the model — the second scripted response IS consumed, unlike TEST 1.
 * Exercises cancelPoliteStop → the worker's `unpause` message end to end.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const unpauseResumesNextTurnTest = {
  name: 'polite-stop-unpause-resumes-next-turn',
  description: 'Un-pausing a pending Pause lets the tool finish and the next LLM turn run',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo "done"' }, 'Running.'),
    // With the pause cancelled, the model IS re-invoked after the tool completes.
    textResponse('Resumed after un-pause.')
  ],

  operations: [
    { type: 'send-message', message: 'Run command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Pause while parked on the approval (the worker is busy → latch is set)...
    { type: 'pause' },
    // ...then toggle Pause back off before approving → latch is dropped.
    { type: 'cancel-pause' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // The tool completes and the reducer re-drives the model to its next turn.
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run command' },
    { type: 'assistant', content: 'Running.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
    },
    // The next turn ran: the second scripted response was consumed.
    { type: 'assistant', content: 'Resumed after un-pause.' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    // Strict: exactly 5 items — the model WAS re-invoked (5th assistant present).
    if (items.length !== 5) {
      throw new Error(
        `Expected exactly 5 items (turn resumed after un-pause), got ${items.length}: ` +
          items.map(i => i.type).join(', ')
      );
    }
    // The pending cue is cleared: cancelPoliteStop drops it eagerly.
    if (conversation.isPolitePending()) {
      throw new Error('politePending cue should be clear after un-pause');
    }
  }
};

// ============================================================================
// TEST 4: A pending Pause is server-authoritative — it survives a page reload
// ============================================================================

/**
 * The pause-pending cue must not be optimistic-local-only state (which a reload
 * resets to false). The worker publishes `processingState.politePending` into the
 * synced doc while the latch is set on a busy frame, so a reloading client — which
 * reconstructs its conversation from that same doc — restores the "Pausing…" cue.
 *
 * The pivotal step is `wait-for-state { politePending: true }`: it reads the synced
 * `processingState`, not the local `_politePending` field, so it only passes if the
 * flag genuinely reached the doc — which is exactly what a reloaded client reads
 * back (`isPolitePending()` consults `processingState.politePending`, so a reset
 * local cue no longer hides the pending state). Once the tool completes and the
 * worker rests at idle, the published flag must clear so a later turn never
 * inherits a stale cue.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const pausePendingSurvivesReloadTest = {
  name: 'polite-stop-pending-survives-reload',
  description: 'A pending Pause is published to the synced processingState so it survives a page reload',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo "done"' }, 'Running.'),
    // As in TEST 1, the model must NOT be re-invoked while the pause is pending.
    textResponse('Should not appear after pause.')
  ],

  operations: [
    { type: 'send-message', message: 'Run command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Pause while parked on the approval (the worker is busy → latch is set).
    { type: 'pause' },
    // The pending cue reached the SYNCED doc — a purely-local field never would.
    // This is the reload-survival guarantee: the value lives in processingState.
    { type: 'wait-for-state', condition: { politePending: true } },
    // Let the tool finish and the worker rest at idle (nothing is cancelled).
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run command' },
    { type: 'assistant', content: 'Running.' },
    { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'bash', state: 'completed' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    // Rested before the next turn (as TEST 1): exactly 4 items, no 5th assistant.
    if (items.length !== 4) {
      throw new Error(
        `Expected exactly 4 items (rested before next turn), got ${items.length}: ` +
          items.map(i => i.type).join(', ')
      );
    }
    // Once the worker rests at idle the published cue must clear — a pending pause
    // is meaningless on an idle worker, and a stale flag would wrongly show
    // "Pausing…" after reload on a settled conversation.
    if (conversation.processingState?.politePending) {
      throw new Error('processingState.politePending should be cleared once the worker rested at idle');
    }
    if (conversation.isPolitePending()) {
      throw new Error('isPolitePending() should be false once the worker rested at idle');
    }
  }
};

// Export all tests
export const tests = [
  pauseRestsBeforeNextTurnTest,
  pauseThenHardCancelEscalatesTest,
  unpauseResumesNextTurnTest,
  pausePendingSurvivesReloadTest
];
