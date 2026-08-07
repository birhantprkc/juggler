//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy-menu live-refresh test.
 *
 * The strategy selector caches the registry's strategy list at mount. When the
 * Extensions catalog enables/disables a strategy (or a plugin hot-reloads), the
 * registries are rebuilt and `REGISTRIES_RELOADED` is dispatched on `document`.
 * The selector must reload from the registry and re-render so its dropdown
 * reflects the new set — it must not show a stale list.
 *
 * Verified without touching server config (which the iframe pool shares): we
 * mutate the per-iframe strategy registry's in-memory `items` map directly and
 * restore it synchronously in a finally block.
 * @module unit-tests/strategy-menu-refresh-test
 */

import { assert } from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import { REGISTRIES_RELOADED } from '../../js/registries/reload-registries.js';
import '../../js/components/strategy-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

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

  await run('open dropdown survives a re-render (thread change) without recreating its anchor button', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

    const manifests = strategyRegistry.getAllManifests();
    assert(manifests.length > 0, 'registry has at least one strategy');
    const idA = manifests[0].id;
    const idB = manifests[manifests.length > 1 ? 1 : 0].id;

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);

    try {
      // Bind to thread A and render the open state. toggleDropdown's rAF would
      // relocate the menu to <body>, mark it, and record it as this instance's
      // live dropdown; rAF is unreliable in the hidden test window, so reproduce
      // that end-state deterministically: open → render the inner <nav> → move
      // it to <body> with the marker attribute → record it in `_liveDropdown`,
      // exactly as the production rAF does.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idA }));
      selector._dropdownOpen = true;
      selector.render();
      const innerNav = selector.querySelector('.strategy-dropdown');
      assert(!!innerNav, 'inner <nav> is rendered when opening');
      innerNav.setAttribute('data-strategy-selector', 'true');
      document.body.appendChild(innerNav);
      selector._liveDropdown = innerNav;

      const buttonBefore = selector.querySelector('.strategy-selector-button');
      assert(!!buttonBefore, 'selector has an anchor button while open');

      // Conversation change: composer-box re-binds the selector to a new thread,
      // which re-renders WHILE the dropdown is open. This must NOT destroy the
      // anchor button — recreating it detaches the menu's positioning target,
      // sending the next reposition to the top-left corner (the "jumps to the
      // corner" symptom) and flashing the button — nor remove the menu.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idB }));

      const dropdownAfter = document.querySelector('.strategy-dropdown[data-strategy-selector="true"]');
      assert(!!dropdownAfter, 'menu is still present after the re-render (did not disappear)');
      assert(dropdownAfter === innerNav, 'the same menu element is preserved (not torn down and rebuilt)');

      const buttonAfter = selector.querySelector('.strategy-selector-button');
      assert(buttonAfter === buttonBefore,
        'the anchor button is the SAME element after the re-render (not recreated/flashed) so the menu stays anchored');

      assert(document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"]').length === 1,
        'exactly one menu surface exists (no duplicate inner <nav>)');

      // The in-place button update still reflects the new thread's strategy.
      const nameEl = buttonAfter.querySelector('.strategy-name');
      const expectedName = manifests.find(m => m.id === idB)?.manifest.name;
      assert(nameEl && nameEl.textContent === expectedName,
        `button label updated in place to "${expectedName}", got "${nameEl?.textContent}"`);
    } finally {
      // Remove the relocated menu (it lives on <body>, not under the selector)
      // then the selector itself.
      document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"]').forEach(el => el.remove());
      selector.remove();
    }
  });

  await run('strategy selector reloads its menu on REGISTRIES_RELOADED', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector); // connectedCallback → loadStrategies + listener

    // Snapshot the registry so we can restore it no matter what.
    const snapshot = new Map(strategyRegistry.items);
    try {
      const initialCount = selector._strategies.length;
      assert(initialCount > 0, 'selector loaded at least one strategy at mount');

      // Disable a strategy at the registry level (what a catalog toggle does).
      const removedId = [...strategyRegistry.items.keys()][0];
      strategyRegistry.items.delete(removedId);

      // Stale until notified.
      assert(selector._strategies.length === initialCount,
        'selector keeps its cached list until the reload event fires');

      document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));

      assert(selector._strategies.length === initialCount - 1,
        'selector reloaded its menu after REGISTRIES_RELOADED');
      assert(!selector._strategies.some((/** @type {any} */ s) => s.id === removedId),
        'the disabled strategy is gone from the reloaded menu');
    } finally {
      strategyRegistry.items.clear();
      for (const [k, v] of snapshot) strategyRegistry.items.set(k, v);
      selector.remove(); // disconnectedCallback → removes the listener
    }
  });

  return { passed, failed, errors };
}
