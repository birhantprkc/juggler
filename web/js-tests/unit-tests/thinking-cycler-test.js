//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ThinkingCycler cycle-order unit tests.
 *
 * The `cycle-thinking` client cycles the CURRENT model's level: Default → the
 * supported levels in canonical order → wrap, applying without recording;
 * commit records the landing pair once. The cycler resolves its target via
 * `document.querySelector('model-selector')`, so each test prepends a real
 * (registered) model-selector element whose network/render side effects are
 * neutered and whose public cycling surface (`currentConfigPair` /
 * `supportedThinkingLevels` / `applyThinkingLevel` / `refreshThinkingDisplay`)
 * is instance-shadowed by recording stubs — the gesture mechanics themselves
 * are covered by hold-to-cycle-test, so these tests drive the cycler's own
 * `_cycle`/`_commit` steps directly rather than re-testing the key plumbing.
 * @module unit-tests/thinking-cycler-test
 */

import { assert } from '../utilities/test-helpers.js';
import { ThinkingCycler, ModelCycler, modelGestureShouldHandle } from '../../js/services/model-cycler.js';
import recentModels from '../../js/services/recent-models.js';
import '../../js/components/model-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Build a model-selector element whose cycling surface is stubbed to a local
 * config, prepend it to <body> (so `getModelSelector`'s document-wide fallback
 * finds it first), and return the element plus the recording state. Callers
 * must `el.remove()` in a finally.
 * @param {string[]} levels - Levels `supportedThinkingLevels()` advertises.
 * @param {{provider: string, model: string, thinking?: string}} config - The
 *   selector's current effective pair.
 * @returns {{el: HTMLElement, state: {config: any, applied: {level: string, record: any}[], refreshes: number}}}
 *   The live element and its recorded interactions.
 */
function makeStubSelector(levels, config) {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  // Neuter connectedCallback's network fetch and DOM render — this element is
  // only a resolution target; its real methods are shadowed below.
  el.fetchProviders = async () => {};
  el.render = () => {};
  const state = { config: { ...config }, applied: /** @type {{level: string, record: any}[]} */ ([]), refreshes: 0 };
  el.currentConfigPair = () => ({ ...state.config });
  el.supportedThinkingLevels = () => levels.slice();
  el.applyThinkingLevel = (/** @type {string} */ level, /** @type {any} */ opts) => {
    state.applied.push({ level, record: opts?.record });
    if (level) state.config.thinking = level;
    else delete state.config.thinking;
    return true;
  };
  el.refreshThinkingDisplay = () => { state.refreshes++; };
  document.body.prepend(el);
  return { el, state };
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

  await run('both model cyclers gate window-wide, not on composer focus', () => {
    // The ⌥⌘M / ⌥⌘T chords must fire from anywhere in the window (bare ⌘M
    // minimises the app otherwise), so both cyclers replace the shared
    // composer-focus gate with the whole-window one. Asserting the wiring here
    // keeps them from silently regressing back to defaultShouldHandle.
    const thinking = /** @type {any} */ (new ThinkingCycler());
    const model = /** @type {any} */ (new ModelCycler());
    assert(thinking._controller._config.shouldHandle === modelGestureShouldHandle,
      'ThinkingCycler must use the window-wide gate');
    assert(model._controller._config.shouldHandle === modelGestureShouldHandle,
      'ModelCycler must use the window-wide gate');
  });

  await run('ModelCycler.init() pre-warms the recents cache for the first gesture', () => {
    // `_startGesture` snapshots recentModels.get() synchronously, so the cache
    // must be warmed before the first ⌥⌘M — otherwise the first gesture cycles
    // over an empty snapshot and only the long-press HUD appears. init() must
    // kick a refresh to close that cold-cache gap.
    const orig = recentModels.refresh;
    let calls = 0;
    recentModels.refresh = /** @type {any} */ (() => { calls++; return Promise.resolve([]); });
    const cycler = /** @type {any} */ (new ModelCycler());
    try {
      cycler.init();
      assert(calls === 1, `init must warm recents exactly once — got ${calls}`);
    } finally {
      cycler.destroy();
      recentModels.refresh = orig;
    }
  });

  await run('cycles Default → supported levels in canonical order → wraps to Default', () => {
    const { el, state } = makeStubSelector(['low', 'medium', 'high'], { provider: 'p', model: 'm' });
    try {
      const cycler = /** @type {any} */ (new ThinkingCycler());
      for (let i = 0; i < 5; i++) cycler._cycle();
      const seq = state.applied.map((a) => a.level).join(',');
      assert(seq === 'low,medium,high,,low',
        `expected low,medium,high,<Default>,low — got "${seq}"`);
      assert(state.applied.every((a) => a.record === false),
        'every cycle hop must apply with record: false');
      assert(state.refreshes === 5, `each hop refreshes the HUD — got ${state.refreshes}`);
    } finally {
      el.remove();
    }
  });

  await run('starts from the current explicit level, not from Default', () => {
    const { el, state } = makeStubSelector(['low', 'medium', 'high'], { provider: 'p', model: 'm', thinking: 'medium' });
    try {
      const cycler = /** @type {any} */ (new ThinkingCycler());
      cycler._cycle();
      cycler._cycle();
      const seq = state.applied.map((a) => a.level).join(',');
      assert(seq === 'high,', `medium → high → Default expected — got "${seq}"`);
      assert(!('thinking' in state.config), 'the wrap to Default deletes the thinking key');
    } finally {
      el.remove();
    }
  });

  await run('non-thinking model: cycling is a silent no-op and canCycle gates the gesture', () => {
    const { el, state } = makeStubSelector([], { provider: 'p', model: 'm' });
    try {
      const cycler = /** @type {any} */ (new ThinkingCycler());
      assert(cycler._controller._config.canCycle() === false,
        'canCycle must be false so the keystroke falls through untouched');
      cycler._cycle();
      assert(state.applied.length === 0 && state.refreshes === 0,
        'no level may be applied on a non-thinking model');
    } finally {
      el.remove();
    }
  });

  await run('canCycle is true for a thinking-capable selected model', () => {
    const { el } = makeStubSelector(['low'], { provider: 'p', model: 'm' });
    try {
      const cycler = /** @type {any} */ (new ThinkingCycler());
      assert(cycler._controller._config.canCycle() === true, 'a thinking model must be cyclable');
    } finally {
      el.remove();
    }
  });

  await run('commit records the landing pair exactly once; a peek without cycling records nothing', () => {
    const { el, state } = makeStubSelector(['low', 'high'], { provider: 'p', model: 'm' });
    const origRecord = recentModels.record;
    /** @type {any[][]} */
    const recorded = [];
    recentModels.record = /** @type {any} */ ((/** @type {any} */ ...args) => {
      recorded.push(args);
      return Promise.resolve();
    });
    try {
      const cycler = /** @type {any} */ (new ThinkingCycler());
      // Pure hold-to-peek: commit with no cycle must not touch recents.
      cycler._commit();
      assert(recorded.length === 0, 'no cycle ⇒ no record');

      cycler._cycle(); // Default → low
      cycler._commit();
      assert(recorded.length === 1, `one commit ⇒ one record, got ${recorded.length}`);
      assert(recorded[0][0] === 'p' && recorded[0][1] === 'm' && recorded[0][2] === 'low',
        `the LANDING pair is recorded — got ${JSON.stringify(recorded[0])}`);
      assert(state.applied.length === 1, 'commit itself must not re-apply a level');

      // The cycled flag was reset: another bare commit records nothing more.
      cycler._commit();
      assert(recorded.length === 1, 'commit must be once-per-gesture');
    } finally {
      recentModels.record = origRecord;
      el.remove();
    }
  });

  return { passed, failed, errors };
}
