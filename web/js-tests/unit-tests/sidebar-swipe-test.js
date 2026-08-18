//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Swipe-to-dismiss for the phone sidebar drawer (`_setupSidebarSwipe` in
 * ui-event-manager.js). The invariants:
 *
 *   1. A leftward drag past the threshold closes the drawer (`sidebar-open`
 *      comes off <body>) and leaves no inline transform behind.
 *   2. A short drag snaps back: still open, transform cleared.
 *   3. A vertical drag is the tab list scrolling — it never moves the drawer
 *      and never closes it, even if the finger drifts left afterwards.
 *   4. The click a swipe leaves behind is swallowed, so swiping off a tab does
 *      not also switch conversation. Later clicks get through.
 *   5. A mouse drag is not a swipe (inside the bar it means tab reorder).
 *   6. A swipe in flight cancels touchmove, so no browser scroll can start from
 *      it and steal the pointer — and if one is stolen anyway, a gesture already
 *      past the threshold still dismisses instead of springing back.
 *
 * Driven through the real handler against a stand-in drawer: the ids and the
 * `position: absolute` drawer-mode check are all it reads, and the media query
 * that produces that position headless can't be driven.
 * @module unit-tests/sidebar-swipe-test
 */

import { assert } from '../utilities/test-helpers.js';
import UIEventManager from '../../js/services/ui-event-manager.js';

/**
 * Build the drawer DOM the handler expects, open, with one tab in it.
 * @returns {{manager: any, sidebar: HTMLElement, tab: HTMLElement, teardown: () => void}} The wired manager, its drawer and tab, and a teardown.
 */
function mountDrawer() {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:360px;height:600px;';
  host.innerHTML = `
    <button id="sidebar-toggle-button" aria-expanded="true"></button>
    <div id="sidebar-backdrop"></div>
    <div id="conversation-bar" style="position:absolute;inset:0 auto 0 0;width:240px;">
      <div class="conversation-tab active"><span class="tab-title">A tab</span></div>
    </div>`;
  document.body.appendChild(host);

  const manager = /** @type {any} */ (
    new UIEventManager({ onSendMessage: () => {}, onContextItemAction: async () => {} })
  );
  manager._setupSidebarToggle();
  document.body.classList.add('sidebar-open');

  const sidebar = /** @type {HTMLElement} */ (host.querySelector('#conversation-bar'));
  const tab = /** @type {HTMLElement} */ (host.querySelector('.conversation-tab'));
  return {
    manager,
    sidebar,
    tab,
    teardown: () => {
      manager.destroy();
      document.body.classList.remove('sidebar-open');
      host.remove();
    },
  };
}

/**
 * @param {HTMLElement} target - Element to dispatch on.
 * @param {string} type - Pointer event type.
 * @param {{x: number, y: number, pointerType?: string}} at - Position and pointer kind.
 */
function pointer(target, type, { x, y, pointerType = 'touch' }) {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}

/**
 * Drag from (100, 300) by the given deltas, one move per step, then release.
 * @param {HTMLElement} target - Element the drag starts on.
 * @param {Array<[number, number]>} steps - Cumulative [dx, dy] offsets to move through.
 * @param {{pointerType?: string}} [opts] - Pointer kind for the whole drag.
 */
function drag(target, steps, opts = {}) {
  const startX = 100;
  const startY = 300;
  pointer(target, 'pointerdown', { x: startX, y: startY, ...opts });
  for (const [dx, dy] of steps) {
    pointer(target, 'pointermove', { x: startX + dx, y: startY + dy, ...opts });
  }
  const [lastX, lastY] = steps[steps.length - 1] ?? [0, 0];
  pointer(target, 'pointerup', { x: startX + lastX, y: startY + lastY, ...opts });
}

/** @returns {boolean} Whether the drawer is open. */
function isOpen() {
  return document.body.classList.contains('sidebar-open');
}

/**
 * Dispatch a cancelable touchmove, as the browser does alongside the pointer
 * events, and report whether the swipe blocked it. A bare Event stands in for a
 * TouchEvent: the handler reads nothing off it, and the constructor is missing
 * on the desktop WebKit the suite runs in.
 * @param {HTMLElement} target - Element the touch is on.
 * @returns {boolean} Whether the swipe called preventDefault (blocking a scroll).
 */
function touchMove(target) {
  const event = new Event('touchmove', { cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Run the sidebar swipe-to-dismiss suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {(ctx: {sidebar: HTMLElement, tab: HTMLElement}) => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    const { sidebar, tab, teardown } = mountDrawer();
    try {
      await fn({ sidebar, tab });
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      teardown();
    }
  };

  await run('a long leftward swipe dismisses the drawer', ({ sidebar, tab }) => {
    drag(tab, [[-20, 0], [-50, 2], [-90, 4]]);
    assert(!isOpen(), 'a swipe past the threshold must close the drawer');
    assert(sidebar.style.transform === '', 'the inline transform must be handed back to CSS on release');
    assert(sidebar.style.transition === '', 'the inline transition must be handed back to CSS on release');
  });

  await run('a short swipe snaps back', ({ sidebar, tab }) => {
    drag(tab, [[-20, 0], [-35, 0]]);
    assert(isOpen(), 'a swipe short of the threshold must leave the drawer open');
    assert(sidebar.style.transform === '', 'the snap-back must clear the inline transform');
  });

  await run('the drawer tracks the finger mid-swipe', ({ sidebar, tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 60, y: 302 });
    assert(sidebar.style.transform === 'translateX(-40px)',
      `the drawer must follow the finger 1:1, got ${JSON.stringify(sidebar.style.transform)}`);
    assert(sidebar.style.transition === 'none', 'the transition must be pinned off while dragging');
    // A rightward move past the start doesn't drag the drawer off its hinge.
    pointer(tab, 'pointermove', { x: 160, y: 302 });
    assert(sidebar.style.transform === 'translateX(0px)', 'the drawer must not travel right of open');
    pointer(tab, 'pointerup', { x: 160, y: 302 });
    assert(isOpen(), 'a swipe that returns to the start must leave the drawer open');
  });

  await run('a vertical drag scrolls instead of swiping', ({ sidebar, tab }) => {
    // Vertical first, then a long drift left: the axis is already lost.
    drag(tab, [[-2, 30], [-80, 60], [-140, 70]]);
    assert(isOpen(), 'a vertical drag must never close the drawer');
    assert(sidebar.style.transform === '', 'a vertical drag must never move the drawer');
  });

  await run('the click a swipe leaves behind is swallowed', async ({ tab }) => {
    let clicks = 0;
    tab.addEventListener('click', () => clicks++);
    drag(tab, [[-20, 0], [-100, 0]]);
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(clicks === 0, `the click after a swipe must not reach the tab, got ${clicks}`);

    // Only that one: the guard lapses, it doesn't deafen the drawer.
    await new Promise((resolve) => setTimeout(resolve, 150));
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(clicks === 1, `a later click must reach the tab, got ${clicks}`);
  });

  await run('a mouse drag is not a swipe', ({ sidebar, tab }) => {
    drag(tab, [[-40, 0], [-120, 0]], { pointerType: 'mouse' });
    assert(isOpen(), 'a mouse drag must not close the drawer');
    assert(sidebar.style.transform === '', 'a mouse drag must not move the drawer');
  });

  await run('a swipe in flight blocks the scroll that would steal it', ({ tab }) => {
    assert(!touchMove(tab), 'an untouched drawer must leave touchmove alone, so the tab list scrolls');
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 70, y: 305 });
    assert(touchMove(tab),
      'a swipe in flight must cancel touchmove, or the browser scrolls and cancels the pointer');
    pointer(tab, 'pointerup', { x: 70, y: 305 });
    assert(!touchMove(tab), 'the block must lift with the finger');
  });

  await run('a stolen gesture past the threshold still dismisses', ({ sidebar, tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 60, y: 300 });
    pointer(tab, 'pointermove', { x: 10, y: 306 });
    pointer(tab, 'pointercancel', { x: 10, y: 306 });
    assert(!isOpen(), 'a cancel past the threshold must honour the swipe, not spring back');
    assert(sidebar.style.transform === '', 'the cancel must clear the inline transform');
  });

  await run('a stolen gesture short of the threshold snaps back', ({ tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 75, y: 300 });
    pointer(tab, 'pointercancel', { x: 75, y: 300 });
    assert(isOpen(), 'a cancel short of the threshold must leave the drawer open');
  });

  await run('the resize grip keeps its own drag', ({ sidebar }) => {
    const grip = document.createElement('col-resize-handle');
    sidebar.appendChild(grip);
    drag(/** @type {HTMLElement} */ (grip), [[-40, 0], [-120, 0]]);
    assert(isOpen(), 'dragging the resize grip must not close the drawer');
    assert(sidebar.style.transform === '', 'dragging the resize grip must not move the drawer');
  });

  return { passed, failed, errors };
}
