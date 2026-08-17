//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Hidden strategy tests.
 *
 * A strategy with `hidden: true` in its manifest is not enumerable and not
 * usable-by-accident, but it IS resolvable: a sub-agent context item owns such a
 * strategy and pins it by id on the delegated thread it spawns, so the registry
 * must still hand back the class.
 *
 * The whole mechanism is one filter inside `getAllManifests()`, which is why
 * these tests check both halves of it:
 *   1. absent from the enumeration every user-facing list reads (selector,
 *      Shift+Tab ring, default picker, command editor);
 *   2. still resolved by `get()` / `createStrategy()`;
 *   3. never chosen by either first-available fallback — ordering is by
 *      `manifest.order` then load order, so an unfiltered hidden strategy that
 *      sorted first could silently become a user's conversation default.
 * @module unit-tests/strategy-hidden-test
 */

import { assert, initializeRegistries } from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
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

/** A hidden strategy that would sort FIRST if it were ever enumerated. */
class HiddenProbeStrategy extends StrategyType {
  static MANIFEST = {
    id: 'hidden-probe',
    name: 'Hidden Probe',
    version: '1.0.0',
    description: 'Test-only hidden strategy',
    hidden: true,
    // Deliberately ahead of every built-in: if the filter were missing, this is
    // the id both first-available fallbacks would land on.
    order: -1000
  };
}

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

  // Registers the item-owned strategies too, so the last case below is testing
  // the real shipped sub-agents rather than an empty registry.
  await initializeRegistries();

  // Register the probe on the shared singleton, and always take it back out.
  const registration = strategyRegistry.registerClass(HiddenProbeStrategy, { extensionId: null, modulePath: '' });
  try {
    await run('a hidden strategy registers like any other', () => {
      assert(registration.registered, `registerClass refused the probe: ${registration.reason}`);
      assert(strategyRegistry.has('hidden-probe'), 'has() must see a registered hidden strategy');
    });

    await run('a hidden strategy is absent from the enumeration', () => {
      const ids = strategyRegistry.getAllManifests().map(m => m.id);
      assert(!ids.includes('hidden-probe'),
        `getAllManifests() must exclude hidden strategies; got [${ids.join(', ')}]`);
    });

    await run('a hidden strategy is still resolvable by id', () => {
      assert(strategyRegistry.get('hidden-probe') === HiddenProbeStrategy,
        'get() must still resolve a hidden id — a sub-agent pins one by id');
      const s = strategyRegistry.createStrategy('hidden-probe', FAKE_MESSAGE_THREAD);
      assert(s.getManifest().id === 'hidden-probe',
        `createStrategy() must instantiate the hidden class, got '${s.getManifest().id}'`);
    });

    await run('a hidden strategy is never the unknown-id fallback', () => {
      // With 'default' removed, createStrategy() falls back to the first
      // available strategy. The probe sorts ahead of everything, so this is the
      // test that the filter — not the call site — is what closes the hole.
      const saved = new Map(strategyRegistry.items);
      strategyRegistry.items.delete('default');
      try {
        const s = strategyRegistry.createStrategy('no-such-strategy-xyz', FAKE_MESSAGE_THREAD);
        assert(s.getManifest().id !== 'hidden-probe',
          'a hidden strategy must never be chosen as the first-available fallback');
      } finally {
        strategyRegistry.items.clear();
        for (const [k, v] of saved) strategyRegistry.items.set(k, v);
      }
    });

    await run('the shipped sub-agent strategies are registered but hidden', () => {
      // The two sub-agents ship in @juggler/core, registered through their
      // items' getStrategies() hook. They must resolve (their tools pin them by
      // id) and must never reach the list — an enumerable one would show up in
      // the Shift+Tab ring as a user-selectable mode, which is what it is not.
      const ids = strategyRegistry.getAllManifests().map(m => m.id);
      for (const id of ['subagent-explore', 'subagent-research']) {
        assert(strategyRegistry.has(id), `${id} must be registered for its tool to pin it`);
        assert(!ids.includes(id), `${id} must not appear in the strategy list`);
      }
    });
  } finally {
    strategyRegistry.items.delete('hidden-probe');
    strategyRegistry.modulePaths.delete('hidden-probe');
    strategyRegistry.itemExtensions.delete('hidden-probe');
  }

  return { passed, failed, errors };
}
