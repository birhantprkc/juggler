//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy fallback tests.
 *
 * Juggler must boot and stay usable even when every strategy plugin (all of
 * them ship in the disable-able `@juggler/core` extension) is turned off. The
 * registry guarantees this: createStrategy() never throws — when neither the
 * requested id nor 'default' is registered it returns the framework-owned
 * FallbackStrategy, so session load succeeds and the Extensions settings stay
 * reachable to re-enable plugins.
 * @module unit-tests/strategy-fallback-test
 */

import { assert } from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import FallbackStrategy from '../../js/registries/fallback-strategy.js';
import StrategyType from 'juggler/strategy-type';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

// Minimal stand-in for a MessageThread — only the fields the StrategyType
// constructor dereferences (conversation → session) are needed.
const FAKE_MESSAGE_THREAD = /** @type {any} */ ({ conversation: { session: {} } });

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

  await run('FallbackStrategy is a valid, instantiable StrategyType', () => {
    assert(FallbackStrategy.prototype instanceof StrategyType,
      'FallbackStrategy must extend StrategyType');
    const s = new FallbackStrategy({ messageThread: FAKE_MESSAGE_THREAD });
    assert(s.getManifest().id === 'fallback',
      `expected fallback manifest id 'fallback', got '${s.getManifest().id}'`);
  });

  await run('createStrategy returns the real default when present', () => {
    assert(strategyRegistry.has('default'),
      'precondition: default strategy should be registered in the test build');
    const s = strategyRegistry.createStrategy('default', FAKE_MESSAGE_THREAD);
    assert(s.getManifest().id === 'default',
      `expected 'default' strategy, got '${s.getManifest().id}'`);
  });

  await run('createStrategy falls back to default for an unknown id', () => {
    const s = strategyRegistry.createStrategy('no-such-strategy-xyz', FAKE_MESSAGE_THREAD);
    // 'default' is registered, so an unknown id resolves to it (not the
    // framework fallback) — the pre-existing deleted/renamed-strategy behaviour.
    assert(s.getManifest().id === 'default',
      `expected unknown id to fall back to 'default', got '${s.getManifest().id}'`);
  });

  await run('createStrategy never throws when NO strategy is registered', () => {
    // Simulate the @juggler/core extension being disabled: the registry holds
    // no strategies at all. Snapshot and restore so the shared singleton is
    // untouched for other suites, even if an assertion throws.
    const saved = new Map(strategyRegistry.items);
    strategyRegistry.items.clear();
    try {
      assert(!strategyRegistry.hasAnyStrategy(),
        'hasAnyStrategy() is false when the registry is empty');
      const s = strategyRegistry.createStrategy('default', FAKE_MESSAGE_THREAD);
      assert(s instanceof FallbackStrategy,
        `expected FallbackStrategy when registry is empty, got '${s?.getManifest?.().id}'`);
    } finally {
      strategyRegistry.items.clear();
      for (const [k, v] of saved) strategyRegistry.items.set(k, v);
    }
  });

  await run('hasAnyStrategy() is true when strategies are registered', () => {
    assert(strategyRegistry.hasAnyStrategy(),
      'precondition: the test build registers at least the default strategy');
  });

  await run('the fallback strategy is inert — it drives no turn of its own', () => {
    // With no strategy registered, turns are refused upstream in
    // Conversation.sendMessage (gated on hasAnyStrategy()); the fallback exists
    // only so the registry has something to instantiate. It exposes none of the
    // removed loop primitives, so it cannot drive an LLM turn.
    const s = new FallbackStrategy({ messageThread: FAKE_MESSAGE_THREAD });
    for (const method of ['run', 'runLoop', 'step', 'executeTools', 'validateTools']) {
      assert(typeof (/** @type {any} */ (s)[method]) !== 'function',
        `inert fallback must not expose ${method}()`);
    }
  });

  return { passed, failed, errors };
}
