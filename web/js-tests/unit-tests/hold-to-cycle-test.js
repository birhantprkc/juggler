//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * HoldToCycleController phase-machine unit tests.
 *
 * Drives the shared hold-to-cycle gesture (idle → press-started → menu-open)
 * with synthetic KeyboardEvents dispatched on document — the controller's own
 * capture-phase listeners receive them — and records every config callback in
 * an ordered log. The trigger is the real `strategy-switch` binding
 * (Shift+Tab, modifier-less so the same synthetic events match on every
 * platform) with `shouldHandle: () => true` to bypass the composer-focus gate,
 * which is asserted separately via the exported {@link defaultShouldHandle}.
 * The 500ms long-press timer is captured deterministically by stubbing
 * `window.setTimeout` around the initial keydown (same pattern as
 * reconnect-policy-test), so no test ever waits on the wall clock. app.js is
 * not loaded in the harness page, so no production controller instance is
 * listening — every reaction to these events is the instance under test.
 * @module unit-tests/hold-to-cycle-test
 */

import { assert } from '../utilities/test-helpers.js';
import HoldToCycleController, { defaultShouldHandle } from '../../js/services/hold-to-cycle.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Create a controller wired so every config callback appends its name to a
 * shared ordered log, and attach its document listeners. Uses the
 * `strategy-switch` shortcut (Shift+Tab) as the trigger with
 * `modifierKeys: ['Shift']` — callers must destroy() the controller.
 * @param {object} [overrides] - HoldToCycleConfig overrides (e.g. canCycle).
 * @returns {{controller: HoldToCycleController, calls: string[]}} The live
 *   controller and its ordered callback log.
 */
function makeHarness(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  const controller = new HoldToCycleController({
    shortcutId: 'strategy-switch',
    modifierKeys: ['Shift'],
    shouldHandle: () => true,
    onGestureStart: () => calls.push('start'),
    onCycle: () => calls.push('cycle'),
    onOpenMenu: () => calls.push('open'),
    onCloseMenu: () => calls.push('close'),
    onCommit: () => calls.push('commit'),
    ...overrides,
  });
  controller.init();
  return { controller, calls };
}

/**
 * Capture the long-press timeout callback scheduled during `fn` (which runs
 * synchronously), without letting a real timer start — the returned handle
 * fires it on demand. `window.setTimeout` is restored before returning, so the
 * stub can never leak into other (async) code; the fake -1 timer id makes a
 * later real `clearTimeout(-1)` a harmless no-op.
 * @param {() => void} fn - Code expected to schedule the long-press setTimeout.
 * @returns {{fire: () => void}} Handle invoking the captured callback (no-op
 *   when nothing was scheduled).
 */
function trapLongPress(fn) {
  const orig = window.setTimeout;
  /** @type {(() => void)|null} */
  let cb = null;
  window.setTimeout = /** @type {any} */ ((/** @type {() => void} */ f) => { cb = f; return -1; });
  try {
    fn();
  } finally {
    window.setTimeout = orig;
  }
  return { fire: () => { if (cb) cb(); } };
}

/**
 * Dispatch the trigger keydown (Shift+Tab) on document.
 * @returns {boolean} True when the controller consumed it (preventDefault).
 */
function pressTrigger() {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  return !document.dispatchEvent(e);
}

/**
 * Dispatch an Escape keydown on document (Shift still held, as mid-gesture).
 * @returns {void}
 */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true, cancelable: true }));
}

/**
 * Dispatch a keyup for the given key on document.
 * @param {string} key - `KeyboardEvent.key` value, e.g. 'Shift'.
 * @returns {void}
 */
function releaseKey(key) {
  document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('trigger keydown cycles immediately and is consumed', () => {
    const { controller, calls } = makeHarness();
    try {
      let prevented = false;
      trapLongPress(() => { prevented = pressTrigger(); });
      assert(prevented, 'the starting keydown must be preventDefault-ed');
      assert(calls.join(',') === 'start,cycle', `expected start,cycle — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('re-pressing the trigger cycles again without restarting the gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      trapLongPress(() => pressTrigger());
      assert(pressTrigger(), 're-press must be consumed too');
      assert(pressTrigger(), 'third press must be consumed too');
      assert(calls.join(',') === 'start,cycle,cycle,cycle',
        `onGestureStart must fire once per gesture — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('long-press opens the menu; re-press still cycles; release closes then commits', () => {
    const { controller, calls } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      timer.fire();
      assert(calls.join(',') === 'start,cycle,open', `long-press should open the menu — got ${calls.join(',')}`);
      assert(pressTrigger(), 'trigger must keep cycling in menu-open');
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,open,cycle,close,commit',
        `release from menu-open must close BEFORE committing — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('opening the menu flags the pointer idle; pointer motion clears it', () => {
    const { controller } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'the pointer must not be flagged idle before the menu opens');
      timer.fire();
      assert(document.body.classList.contains('hud-pointer-idle'),
        'opening the HUD must flag the pointer idle so its hover is suppressed');
      document.dispatchEvent(new Event('pointermove', { bubbles: true }));
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'the first real pointer motion must clear the idle flag');
    } finally {
      controller.destroy();
    }
  });

  await run('committing on modifier release clears the pointer-idle flag', () => {
    const { controller } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      timer.fire();
      assert(document.body.classList.contains('hud-pointer-idle'), 'sanity: HUD open flags idle');
      releaseKey('Shift');
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'ending the gesture must clear the idle flag');
    } finally {
      controller.destroy();
    }
  });

  await run('Escape from menu-open clears the pointer-idle flag', () => {
    const { controller } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      timer.fire();
      pressEscape();
      assert(!document.body.classList.contains('hud-pointer-idle'),
        'Escape must clear the idle flag along with closing the menu');
    } finally {
      controller.destroy();
    }
  });

  await run('modifier release before the long-press commits without any menu', () => {
    const { controller, calls } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,commit',
        `press-started release is commit-only — got ${calls.join(',')}`);
      // The long-press timer was cleared: firing its captured callback now
      // must not open a menu (the controller is idle again).
      timer.fire();
      assert(!calls.includes('open'), 'a cleared long-press timer must never open the menu');
    } finally {
      controller.destroy();
    }
  });

  await run('Escape cancels from menu-open: closes, never commits', () => {
    const { controller, calls } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      timer.fire();
      pressEscape();
      assert(calls.join(',') === 'start,cycle,open,close',
        `Escape must close without committing — got ${calls.join(',')}`);
      // The gesture is over: the (still-held) modifier's release does nothing.
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,open,close',
        `post-Escape modifier release must be inert — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('Escape cancels from press-started and re-arms the controller', () => {
    const { controller, calls } = makeHarness();
    try {
      const timer = trapLongPress(() => pressTrigger());
      pressEscape();
      assert(calls.join(',') === 'start,cycle,close',
        `Escape in press-started closes (idempotent hook) without commit — got ${calls.join(',')}`);
      timer.fire();
      assert(!calls.includes('open'), 'Escape must clear the pending long-press timer');
      // A fresh gesture starts cleanly afterwards.
      trapLongPress(() => pressTrigger());
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,close,start,cycle,commit',
        `the next gesture must run a full start/cycle/commit — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('canCycle() === false lets the trigger fall through untouched', () => {
    const { controller, calls } = makeHarness({ canCycle: () => false });
    try {
      let prevented = true;
      trapLongPress(() => { prevented = pressTrigger(); });
      assert(!prevented, 'an inapplicable trigger must NOT be preventDefault-ed');
      assert(calls.length === 0, `no callback may fire — got ${calls.join(',')}`);
      releaseKey('Shift');
      assert(calls.length === 0, 'no gesture started, so keyup must be inert');
    } finally {
      controller.destroy();
    }
  });

  await run('shouldHandle false leaves the event alone', () => {
    const { controller, calls } = makeHarness({ shouldHandle: () => false });
    try {
      let prevented = true;
      trapLongPress(() => { prevented = pressTrigger(); });
      assert(!prevented && calls.length === 0, 'gated trigger must fall through with no callbacks');
    } finally {
      controller.destroy();
    }
  });

  await run('releasing a non-configured key does not end the gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      trapLongPress(() => pressTrigger());
      releaseKey('Alt'); // not in modifierKeys — must be ignored
      assert(!calls.includes('commit'), 'a non-modifier keyup must not commit');
      assert(pressTrigger(), 'the gesture must still be live and cycling');
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,cycle,commit',
        `only the configured modifier ends the gesture — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('onGestureStart fires again for each new gesture', () => {
    const { controller, calls } = makeHarness();
    try {
      trapLongPress(() => pressTrigger());
      releaseKey('Shift');
      trapLongPress(() => pressTrigger());
      releaseKey('Shift');
      assert(calls.join(',') === 'start,cycle,commit,start,cycle,commit',
        `two taps are two full gestures — got ${calls.join(',')}`);
    } finally {
      controller.destroy();
    }
  });

  await run('defaultShouldHandle gates on a composer textarea with no modal open', () => {
    const box = document.createElement('input-box');
    const textarea = document.createElement('textarea');
    box.appendChild(textarea);
    const bare = document.createElement('textarea');
    const div = document.createElement('div');
    box.appendChild(div);
    assert(defaultShouldHandle(/** @type {any} */ ({ target: textarea })) === true,
      'textarea inside input-box should be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: bare })) === false,
      'a textarea outside input-box should not be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: div })) === false,
      'a non-textarea inside input-box should not be handled');
    assert(defaultShouldHandle(/** @type {any} */ ({ target: null })) === false,
      'a non-element target should not be handled');
  });

  return { passed, failed, errors };
}
