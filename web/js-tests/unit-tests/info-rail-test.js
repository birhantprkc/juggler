//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two ways the sidebar's cards-win layout fails without anyone noticing.
 * Deliberately not a full description of the layout: dead space and a card that
 * doesn't appear are on screen the moment the app opens, and a test that repeats
 * what the first glance tells you is upkeep with no cover. These two are not
 * visible from a normal-sized window:
 *
 *   1. The rail never takes more than the share CSS caps it at, however many
 *      cards want in — the surplus is dropped from the tail. Left unguarded,
 *      cards eat a short column and the conversation list goes with it.
 *   2. Room that comes back is used: a card dropped in a short column returns
 *      when the column grows. The rail cannot get this right by measuring
 *      itself — its own height is its content, so it would only ever re-confirm
 *      the cards already up, and a card dropped once would stay dropped for the
 *      rest of the session.
 *
 * Reconciles are driven by calling `_reconcile()` directly, never by waiting on
 * the component's ResizeObserver: the hidden test page defers the "update the
 * rendering" step indefinitely under load (the same thing that put code-lines.js
 * on a timer chain), so an observer-driven assertion would be flaky by
 * construction on CI rather than by accident.
 * @module unit-tests/info-rail-test
 */

import InfoCardType from 'juggler/info-card-type';
import { assert } from '../utilities/test-helpers.js';
import infoCardRegistry from '../../js/registries/info-card-registry.js';
import { __allowInfoRailInTests } from '../../js/components/info-rail.js';
import '../../js/components/conversation-bar.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Height of each stub card's content region, so every card is the same size. */
const CARD_CONTENT_PX = 36;

/**
 * A stand-in info card of a fixed height. Ids are namespaced so they can never
 * collide with a real card, or with a hidden-set entry another suite persisted to
 * the localStorage key this origin shares between lanes.
 * @param {number} n - Which stub, highest priority first.
 * @returns {typeof InfoCardType} A registrable card class.
 */
function stubCard(n) {
  return class TestCard extends InfoCardType {
    static MANIFEST = {
      id: `test-rail-card-${n}`,
      name: `Test card ${n}`,
      version: '1.0.0',
      description: 'Stand-in card of a fixed height.',
      eyebrow: `STUB ${n}`,
      priority: 100 - n,
    };

    /**
     * @param {HTMLElement} contentEl - The content region to fill.
     * @returns {() => void} Teardown.
     */
    mount(contentEl) {
      contentEl.style.height = `${CARD_CONTENT_PX}px`;
      return () => {};
    }
  };
}

/**
 * Put `count` stub cards in the registry, replacing whatever it holds. Reset
 * first as well as after: a lane shares one realm across the suites it runs, so
 * the registry may arrive with another suite's cards (or the real ones) in it.
 * @param {number} count - How many stubs to register.
 * @returns {void}
 */
function registerStubs(count) {
  infoCardRegistry.reset();
  for (let n = 1; n <= count; n++) infoCardRegistry.registerClass(stubCard(n));
}

/**
 * Mount a sidebar column: the real element names and classes, so the real
 * stylesheet applies, sized by the host rather than by the 15rem the sheet gives
 * a live sidebar.
 *
 * Off-screen but genuinely laid out — every assertion here is a measurement.
 * @param {{height: number, tabs: number}} opts - Column height in px, and how many tabs to fill it with.
 * @returns {{nav: HTMLElement, tabs: HTMLElement, rail: any, bin: HTMLElement, cards: () => HTMLElement[], resize: (h: number) => void, teardown: () => void}} The mounted column.
 */
function mountColumn({ height, tabs }) {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-9999px;top:0;width:240px;height:${height}px;`;
  document.body.appendChild(host);

  const bar = document.createElement('conversation-bar');
  bar.style.cssText = 'position:absolute;inset:0;width:240px;height:100%;';
  host.appendChild(bar);

  const tabMarkup = Array.from({ length: tabs }, (_, i) => `
    <li class="conversation-tab" data-conversation-id="c${i}">
      <button class="conversation-tab-button"><span class="conversation-tab-name">Tab ${i}</span></button>
    </li>`).join('');

  // Stands in for conversation-bar.render()'s output: the column, the scrolling
  // tab list, the rail, and the Bin that pins the bottom.
  bar.innerHTML = `
    <nav class="conversation-bar">
      <menu class="conversation-tabs">${tabMarkup}</menu>
      <info-rail></info-rail>
      <button class="conversation-bin" style="height:28px;flex:0 0 auto;">Bin</button>
    </nav>`;

  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (bar.querySelector(sel));
  const rail = /** @type {any} */ (q('info-rail'));
  return {
    nav: q('nav.conversation-bar'),
    tabs: q('menu.conversation-tabs'),
    rail,
    bin: q('.conversation-bin'),
    cards: () => /** @type {HTMLElement[]} */ (Array.from(rail.querySelectorAll('.info-card'))),
    resize: (h) => { host.style.height = `${h}px`; rail._reconcile(); },
    teardown: () => host.remove(),
  };
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

  __allowInfoRailInTests(true);
  try {
    await run('a short column keeps its share for the tabs and drops cards from the tail', () => {
      registerStubs(3);
      const col = mountColumn({ height: 220, tabs: 12 });
      try {
        col.rail._reconcile();
        const ids = col.cards().map((c) => c.dataset.cardId);
        assert(ids.length < 3, `a 220px column cannot hold all three, got ${ids.length}`);
        assert(ids.every((id, i) => id === `test-rail-card-${i + 1}`),
          `what is kept is the top of the stack, got ${ids.join(', ') || '(none)'}`);
        assert(col.rail.offsetHeight <= col.nav.clientHeight / 2 + 1,
          `the rail never takes more than half (${col.nav.clientHeight / 2}px), got ${col.rail.offsetHeight}px`);
        assert(col.tabs.clientHeight >= col.nav.clientHeight / 2 - col.bin.offsetHeight - 1,
          `so the list keeps the rest, got ${col.tabs.clientHeight}px`);
      } finally {
        col.teardown();
      }
    });

    await run('room that comes back is used', () => {
      registerStubs(3);
      const col = mountColumn({ height: 220, tabs: 12 });
      try {
        col.rail._reconcile();
        const cramped = col.cards().length;
        assert(cramped < 3, `starts cramped, got ${cramped} cards`);

        col.resize(900);
        assert(col.cards().length === 3,
          `a taller column takes the dropped cards back, got ${col.cards().length}`);

        col.resize(220);
        assert(col.cards().length === cramped,
          `and gives them up again, got ${col.cards().length}`);
      } finally {
        col.teardown();
      }
    });
  } finally {
    // Realm-global, both of them: leave the rail switched off and the registry as
    // this suite found it, or the next suite in this lane inherits stub cards.
    __allowInfoRailInTests(false);
    infoCardRegistry.reset();
  }

  return { passed, failed, errors };
}
