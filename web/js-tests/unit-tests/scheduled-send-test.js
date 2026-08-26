//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Scheduled send: keeping the timer, the draft and the tab clock in agreement.
 *
 * A scheduled send lives on the thread's draft; the composer keeps a copy in
 * memory to paint the clock button from. Everything here is about the two
 * disagreeing, which is how the feature went wrong in the field:
 *
 *   1. A timer over an empty box. The box disables the clock button when it is
 *      empty, so an armed timer left behind by a cleared box was unreachable —
 *      lit on the tab, cancellable from nowhere. Emptying the box now disarms.
 *   2. A timer that has already fired. Another window (or this window's own
 *      off-screen fire path) sends and clears the draft; the composer that is
 *      still on screen hears nothing. The stale copy is not just cosmetic — the
 *      next draft save writes it back, re-arming an instant whose fire has
 *      already been claimed, so no sweep will ever fire it again.
 *   3. Firing into a turn that has not ended. A `turn-end` wait reads the
 *      conversation's processingState, which is one status for the whole
 *      conversation and can read idle while a sub-thread's run is still open.
 *      The document is asked too.
 * @module unit-tests/scheduled-send-test
 */

import { initializeRegistries, assert } from '../utilities/test-helpers.js';
import scheduledSendService from '../../js/services/scheduled-send-service.js';
import '../../js/components/composer.js';

/**
 * A stand-in for MessageThread's draft record that keeps the one property the
 * real setter has and these tests depend on: an absent schedule reads back as
 * absent, so "cleared elsewhere" is indistinguishable from "never armed".
 * @returns {any} A stub message thread with a normalising `draft` accessor.
 */
function makeStubThread() {
  /** @type {any} */
  let record = { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
  /** @type {any} */
  const thread = {
    conversationId: 'conv-1',
    threadItemId: null,
    getContextItems: () => [],
    hasBusyItems: () => false,
    executeContextItem: async () => {},
    executeContextItemIntoPending: async () => {},
    get draft() {
      return record;
    },
    set draft(value) {
      if (!value) {
        record = { text: '', attachments: [], textFiles: [], pasteBlobs: [] };
        return;
      }
      const when = value.scheduledSendAt;
      /** @type {any} */
      const next = {
        text: value.text || '',
        attachments: value.attachments || [],
        textFiles: value.textFiles || [],
        pasteBlobs: value.pasteBlobs || [],
      };
      // Mirrors message-thread.js: the schedule rides along only while armed.
      if (typeof when === 'number' && Number.isFinite(when)) {
        next.scheduledSendAt = when;
        if (value.scheduledSendMode === 'turn-end') next.scheduledSendMode = 'turn-end';
      }
      record = next;
    },
  };
  return thread;
}

/**
 * Mount a <composer-box> bound to a stub thread.
 *
 * render() runs synchronously in connectedCallback but DEFERS setupListeners()
 * to requestAnimationFrame, and the test-pool window never paints, so rAF may
 * never pump. Bind directly and neutralise the pending call, as
 * composer-send-latch-test does.
 * @returns {{box: any, textarea: HTMLTextAreaElement, container: HTMLElement, thread: any, scheduleBtn: HTMLButtonElement}} The mounted box and its parts.
 */
function mountComposer() {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:600px;height:600px;';
  const box = document.createElement('composer-box');
  container.appendChild(box);
  document.body.appendChild(container);

  /** @type {any} */ (box).setupListeners();
  /** @type {any} */ (box).setupListeners = () => {};

  const thread = makeStubThread();
  /** @type {any} */ (box)._messageThread = thread;

  const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));
  assert(!!textarea, 'composer-box must render a textarea');
  const scheduleBtn = /** @type {HTMLButtonElement} */ (box.querySelector('.schedule-send-btn'));
  assert(!!scheduleBtn, 'composer-box must render a schedule-send button');

  return { box, textarea, container, thread, scheduleBtn };
}

/**
 * Put text in the box and arm a delayed send on it, the way the picker does.
 * @param {any} box
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 * @returns {number} The armed instant.
 */
function armWithText(box, textarea, text) {
  textarea.value = text;
  const target = Date.now() + 3600000;
  box._scheduledSendAt = target;
  box._scheduledSendMode = 'delay';
  box._persistDraft(undefined, { scheduleIsAuthoritative: true });
  // What armScheduledSend does last: paint the button from the new state.
  box._updateSendButtonState();
  return target;
}

/**
 * Run the scheduled-send test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  const errors = [];

  // ── Test 1: emptying the box disarms the timer everywhere ─────────────────
  {
    const { box, textarea, container, thread, scheduleBtn } = mountComposer();
    try {
      const target = armWithText(box, textarea, 'run the thing');
      assert(thread.draft.scheduledSendAt === target,
        'arming must persist the target onto the draft');
      assert(scheduleBtn.classList.contains('armed'),
        'the clock button must show as armed over a non-empty box');

      // The user selects all and deletes; the debounced save carries the empty
      // text. That save is the moment the draft has nothing left to send.
      textarea.value = '';
      box._persistDraft('');

      assert(box._scheduledSendAt === null,
        `emptying the box must drop the in-memory target, got ${box._scheduledSendAt}`);
      assert(thread.draft.scheduledSendAt === undefined,
        `emptying the box must clear the persisted schedule, got ${JSON.stringify(thread.draft.scheduledSendAt)}`);
      assert(!scheduleBtn.classList.contains('armed'),
        'the clock button must not read armed once the timer is gone');
      assert(scheduleBtn.disabled === true,
        'an empty box must still disable the clock button');
      assert(scheduleBtn.getAttribute('title') === 'Send later',
        `a disarmed button must offer to arm, got ${JSON.stringify(scheduleBtn.getAttribute('title'))}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('empty-box-disarms: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 2: a schedule cleared elsewhere drops out of the composer ────────
  {
    const { box, textarea, container, thread, scheduleBtn } = mountComposer();
    try {
      armWithText(box, textarea, 'scheduled text');

      // Another window wins the claim, fires the send and clears the draft.
      // Nothing tells this composer; its in-memory copy is now a ghost.
      thread.draft = { text: '', attachments: [], textFiles: [], scheduledSendAt: null };
      assert(box._scheduledSendAt !== null,
        'precondition: the composer still holds the fired target');

      // The sweep offers every on-screen box the chance to notice.
      box.reconcileScheduledSend();

      assert(box._scheduledSendAt === null,
        `a schedule cleared elsewhere must drop out of the composer, got ${box._scheduledSendAt}`);
      assert(!scheduleBtn.classList.contains('armed'),
        'the clock button must stop showing a timer that has already fired');
      passed++;
    } catch (e) {
      failed++;
      errors.push('remote-clear-drops-stale-state: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 3: a draft save cannot resurrect a schedule cleared elsewhere ────
  {
    const { box, textarea, container, thread } = mountComposer();
    try {
      armWithText(box, textarea, 'scheduled text');
      // Cleared elsewhere, exactly as above — but this time the user types
      // before any sweep has run, so the save is what reaches the draft first.
      thread.draft = { text: 'scheduled text', attachments: [], textFiles: [], scheduledSendAt: null };

      textarea.value = 'scheduled text and more';
      box._persistDraft('scheduled text and more');

      assert(thread.draft.scheduledSendAt === undefined,
        `a draft save must not re-arm a schedule that was cleared elsewhere, got ${JSON.stringify(thread.draft.scheduledSendAt)}`);
      assert(box._scheduledSendAt === null,
        `the composer must adopt the cleared schedule, got ${box._scheduledSendAt}`);
      assert(thread.draft.text === 'scheduled text and more',
        'the save must still persist the text the user typed');
      passed++;
    } catch (e) {
      failed++;
      errors.push('save-does-not-resurrect-schedule: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      container.remove();
    }
  }

  // ── Test 4: a turn-end wait is not due while a sub-thread run is open ─────
  {
    const savedSession = /** @type {any} */ (scheduledSendService)._session;
    const savedFire = /** @type {any} */ (scheduledSendService)._fire;
    /** @type {any[]} */
    const fired = [];
    try {
      let busy = true;
      /** @type {any} */
      const thread = {
        conversationId: 'conv-turn-end',
        threadItemId: null,
        draft: { text: 'queued prompt', attachments: [], textFiles: [], scheduledSendAt: Date.now(), scheduledSendMode: 'turn-end' },
        hasBusyItems: () => busy,
      };
      /** @type {any} */
      const conversation = {
        id: 'conv-turn-end',
        getAllMessageThreads: () => [thread],
        // The worker has published a resting idle — the lie this guards against.
        isTurnActive: () => false,
      };
      thread.conversation = conversation;
      /** @type {any} */ (scheduledSendService)._session = {
        conversations: new Map([['conv-turn-end', conversation]]),
      };
      /** @type {any} */ (scheduledSendService)._fire = async (/** @type {any} */ t) => {
        fired.push(t);
      };

      /** @type {any} */ (scheduledSendService)._scan(true);
      assert(fired.length === 0,
        `a turn-end send must not fire while a sub-thread run is open, fired ${fired.length} time(s)`);

      // The sub-thread settles: now the turn really has ended.
      busy = false;
      /** @type {any} */ (scheduledSendService)._scan(true);
      assert(fired.length === 1,
        `a turn-end send must fire once nothing is outstanding, fired ${fired.length} time(s)`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('turn-end-waits-for-open-runs: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      /** @type {any} */ (scheduledSendService)._session = savedSession;
      /** @type {any} */ (scheduledSendService)._fire = savedFire;
    }
  }

  return { passed, failed, errors };
}
