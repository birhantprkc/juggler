//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for popup-surface's presentation lifecycle.
 *
 * The one hard invariant: a `close()` is honoured no matter when it lands. The
 * presentation spans two frames and a re-entrant stretch inside `presentPopup`
 * (which announces the popup, so any other open popup closes right there, and
 * a component reacting to that can close THIS one) — and a close falling in
 * that window used to be dropped, because there was no release to run yet. The
 * teardown it was supposed to do then belonged to nobody: surface and scrim sat
 * on `<body>` with no dismissal path (Escape, Back, scrim-tap and drag all run
 * through a handle the host had already released), and the popup's open-state
 * token leaked, which suppresses Escape app-wide for the rest of the session.
 *
 * Placement (`positionDropdown`, which this presents with) is covered here for
 * the same reason: what it does to the surface has to survive being done on
 * every content change, repeatedly, under the user's hands.
 *
 * `requestAnimationFrame` is shimmed onto macrotasks: the test window is hidden
 * and may never paint.
 * @module unit-tests/popup-surface-test
 */

import { presentInlineMenu } from '../../js/utils/popup-surface.js';
import { positionDropdown } from '../../sdk/lib/dropdown-positioning.js';
import {
  registerOpenPopup,
  isAnyPopupOpen,
  __resetPopupManagerForTests,
} from '../../js/utils/popup-manager.js';

/**
 * Yield to the macrotask queue, letting one shimmed animation frame run.
 * @returns {Promise<void>} Resolves after the next macrotask.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Mount a host carrying the menu and trigger `presentInlineMenu` expects.
 * @returns {HTMLElement} The mounted host element.
 */
function mountHost() {
  const host = document.createElement('section');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  host.innerHTML = '<button class="trigger">open</button>'
    + '<nav class="menu dropdown-menu show"><menu><li>item</li></menu></nav>';
  document.body.appendChild(host);
  return host;
}

/**
 * Mount a menu whose inner list scrolls only because the menu's height is
 * capped — the shape every anchored picker has.
 * @returns {{menu: HTMLElement, list: HTMLElement, button: HTMLElement}} The mounted parts.
 */
function mountScrollingMenu() {
  const button = document.createElement('button');
  button.style.cssText = 'position:fixed;left:10px;top:10px;width:80px;height:20px;';
  document.body.appendChild(button);

  const menu = document.createElement('nav');
  menu.className = 'dropdown-menu show';
  menu.style.cssText = 'display:flex;flex-direction:column;width:12rem;padding:0;';
  const list = document.createElement('div');
  list.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;';
  list.innerHTML = '<div style="height:200rem"></div>';
  menu.appendChild(list);
  document.body.appendChild(menu);
  return { menu, list, button };
}

/**
 * Run the popup-surface test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
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

  /**
   * @param {boolean} cond
   * @param {string} msg
   */
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

  try {
    await run('a close landing mid-presentation still tears the popup down', async () => {
      __resetPopupManagerForTests();
      const host = mountHost();
      try {
        const handle = presentInlineMenu({
          host,
          surfaceSelector: '.menu',
          anchorSelector: '.trigger',
          onClose: () => {},
        });

        // A rival popup that closes ours the instant ours announces itself —
        // which happens INSIDE presentPopup, before it has returned a release.
        // (The mobile actions sheet does exactly this: it closes, and closing
        // re-parents the selector, whose disconnect closes its menu.)
        let closedDuringPresentation = false;
        const releaseRival = registerOpenPopup({
          id: 'rival',
          onClose: () => {
            closedDuringPresentation = true;
            handle.close();
          },
        });

        await tick(); // the deferred presentation runs, and is cancelled within itself
        await tick(); // any placement frame that survived would fire here

        assert(closedDuringPresentation, 'the rival popup must have closed ours during presentation');
        assert(!document.querySelector('.menu[data-section="true"]'),
          'the presented surface must not be left on <body>');
        assert(!document.querySelector('.popup-sheet-scrim'),
          'no scrim may outlive the presentation');
        assert(handle.surface === null, 'the handle must report no live surface');

        releaseRival();
        assert(!isAnyPopupOpen(),
          'the open-popup token must be released (a leak suppresses Escape app-wide)');
      } finally {
        host.remove();
        document.querySelectorAll('.menu[data-section="true"], .popup-sheet-scrim')
          .forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });

    await run('placing a menu leaves a long list where the user left it', () => {
      // Placement measures the menu at its natural height, which means clearing
      // the `max-height` that bounds it — and a scroller inside only has
      // somewhere to scroll BECAUSE of that bound. Repositioning happens on
      // every content change, so losing the offset here means a list that
      // snaps back to the top while the user is reading it.
      const { menu, list, button } = mountScrollingMenu();
      try {
        list.scrollTop = 300;
        assert(list.scrollTop === 300, 'the list must be scrollable for this to mean anything');
        positionDropdown(menu, button, 8);
        assert(list.scrollTop === 300,
          `placement must not scroll the list — landed at ${list.scrollTop}`);
      } finally {
        menu.remove();
        button.remove();
      }
    });

    await run('an ordinary open then close leaves nothing behind', async () => {
      __resetPopupManagerForTests();
      const host = mountHost();
      try {
        const handle = presentInlineMenu({
          host,
          surfaceSelector: '.menu',
          anchorSelector: '.trigger',
          onClose: () => {},
        });
        await tick();

        assert(!!handle.surface, 'the menu is presented');
        assert(handle.surface?.parentElement === document.body, 'the menu is hosted on <body>');
        assert(isAnyPopupOpen(), 'the presented menu counts as an open popup');

        handle.close();
        assert(!document.querySelector('.menu[data-section="true"]'), 'closing removes the surface');
        assert(handle.surface === null, 'closing clears the handle');
        assert(!isAnyPopupOpen(), 'closing releases the open-popup token');
      } finally {
        host.remove();
        document.querySelectorAll('.menu[data-section="true"], .popup-sheet-scrim')
          .forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
  }

  return { passed, failed, errors };
}
