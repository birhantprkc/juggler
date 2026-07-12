//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for popup-manager's Back-button / unified-dismissal wiring.
 *
 * Covers:
 *  - opening an overlay pushes ONE sentinel history entry carrying the marker;
 *  - a second, stacked overlay shares that single entry (one Back press clears
 *    the whole layer);
 *  - closing programmatically drops the sentinel via history.back(), but only
 *    once the LAST overlay is gone;
 *  - a `popstate` (the Back press) dismisses open overlays without a redundant
 *    history.back();
 *  - Escape routes through the same registered-handler dismissal;
 *  - closeAllPopups() closes most-recently-opened first (LIFO), and also
 *    dismisses dropdowns wired through the POPUP_CLOSE_ALL event.
 *
 * The History API is stubbed for the whole run so the test never actually
 * navigates the iframe — a real history.back() at the base entry would unload
 * the test page. We assert only that popup-manager drives push/back correctly.
 * @module unit-tests/popup-back-button-test
 */

import {
  markPopupOpen,
  isAnyPopupOpen,
  closeAllPopups,
  registerOpenPopup,
  __resetPopupManagerForTests,
} from '../../js/utils/popup-manager.js';

const OVERLAY_MARKER = 'jugglerOverlay';

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Let queued microtasks (deferred sentinel removal) and tasks settle.
 * @returns {Promise<void>} Resolves after a zero-delay timeout.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Run the popup back-button test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /** @param {number} r */
  const tally = (r) => { if (r) passed += r; else failed += 1; };

  // Stub History so no real navigation occurs; count the calls popup-manager
  // makes and capture the most recent pushed state for assertions.
  const realPush = window.history.pushState;
  const realBack = window.history.back;
  let pushCount = 0;
  let backCount = 0;
  /** @type {any} */
  let lastPushState = null;
  window.history.pushState = function (state) { pushCount++; lastPushState = state; };
  window.history.back = function () { backCount++; };

  try {
    // The multi-iframe pool reuses ONE JS realm for the whole sequence of tests
    // a lane runs, so a prior test that leaked an open-popup registration would
    // poison this module singleton and break the 0→1 sentinel baseline every
    // check below depends on (the sentinel push is gated on openPopups.size===1).
    // Force a clean baseline rather than asserting one — a sibling test's leak is
    // not this test's failure, and this test releases everything it opens. Then
    // confirm the reset actually took.
    __resetPopupManagerForTests();
    tally(check(!isAnyPopupOpen(), 'precondition: popup registry clean after reset', errors));

    // === push-on-open: first overlay pushes one marked sentinel ===
    const pBeforeOpen = pushCount;
    const relA = markPopupOpen(() => {});
    tally(check(isAnyPopupOpen(), 'open: isAnyPopupOpen() true after markPopupOpen', errors));
    tally(check(pushCount === pBeforeOpen + 1,
      `open: exactly one history entry pushed (got ${pushCount - pBeforeOpen})`, errors));
    tally(check(!!lastPushState && lastPushState[OVERLAY_MARKER] === true,
      'open: pushed state carries the overlay marker', errors));

    // === single sentinel when stacked: a 2nd overlay pushes nothing more ===
    const pBeforeStack = pushCount;
    const relB = markPopupOpen(() => {});
    tally(check(pushCount === pBeforeStack, 'stacked: second overlay pushes no extra entry', errors));
    tally(check(isAnyPopupOpen(), 'stacked: still open with two overlays', errors));

    // === programmatic close: history.back() only when the LAST overlay closes ===
    const bBeforeClose = backCount;
    relB();
    await tick();
    tally(check(isAnyPopupOpen(), 'close-one: still open after closing one of two', errors));
    tally(check(backCount === bBeforeClose,
      'close-one: no history.back() while an overlay remains', errors));
    relA();
    await tick();
    tally(check(!isAnyPopupOpen(), 'close-last: nothing open after closing both', errors));
    tally(check(backCount === bBeforeClose + 1,
      `close-last: one history.back() drops the sentinel (got ${backCount - bBeforeClose})`, errors));

    // === async swap: an awaited overlay→overlay transition keeps the sentinel ===
    // A confirm dialog whose result opens Settings closes the modal (last
    // overlay → 0), then resolves its promise several microtasks later before
    // opening the panel. The sentinel retraction MUST outlast that await-chain,
    // or its history.back() fires in the gap and the trailing popstate tears the
    // freshly-opened panel back down ("Go to provider settings does nothing").
    const bBeforeAsyncSwap = backCount;
    const pBeforeAsyncSwap = pushCount;
    const relClosing = markPopupOpen(() => {});
    relClosing(); // last overlay closes → retraction scheduled
    // Mimic the dialog promise chain: open the next overlay a few microtasks on.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    /** @type {() => void} */
    let relReopened = () => {};
    relReopened = markPopupOpen(() => { relReopened(); }); // Settings opens
    await tick(); // let any (wrongly) scheduled retraction run
    tally(check(isAnyPopupOpen(), 'async-swap: overlay still open after deferred reopen', errors));
    tally(check(backCount === bBeforeAsyncSwap,
      `async-swap: no history.back() — single sentinel inherited (got ${backCount - bBeforeAsyncSwap})`, errors));
    tally(check(pushCount === pBeforeAsyncSwap + 1,
      `async-swap: only the first overlay pushed a sentinel (got ${pushCount - pBeforeAsyncSwap})`, errors));
    relReopened();
    await tick();

    // === Back button (popstate) dismisses the open overlay ===
    let closedByPop = 0;
    /** @type {() => void} */
    let relPop = () => {};
    relPop = markPopupOpen(() => { closedByPop++; relPop(); });
    const bBeforePop = backCount;
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    tally(check(closedByPop === 1, 'popstate: registered close handler invoked', errors));
    tally(check(!isAnyPopupOpen(), 'popstate: overlay closed after Back press', errors));
    await tick();
    tally(check(backCount === bBeforePop,
      'popstate: no extra history.back() — the entry was already popped', errors));

    // === Escape routes through the same registered-handler dismissal ===
    let closedByEsc = 0;
    /** @type {() => void} */
    let relEsc = () => {};
    relEsc = markPopupOpen(() => { closedByEsc++; relEsc(); });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    tally(check(closedByEsc === 1, 'escape: registered close handler invoked', errors));
    tally(check(!isAnyPopupOpen(), 'escape: overlay closed on Escape', errors));
    await tick();

    // === closeAllPopups closes most-recently-opened first (LIFO) ===
    /** @type {number[]} */
    const order = [];
    /** @type {() => void} */
    let rel1 = () => {};
    /** @type {() => void} */
    let rel2 = () => {};
    rel1 = markPopupOpen(() => { order.push(1); rel1(); });
    rel2 = markPopupOpen(() => { order.push(2); rel2(); });
    closeAllPopups();
    tally(check(JSON.stringify(order) === JSON.stringify([2, 1]),
      `closeAll: LIFO dismissal order (got ${JSON.stringify(order)})`, errors));
    tally(check(!isAnyPopupOpen(), 'closeAll: nothing open afterwards', errors));
    await tick();

    // === dropdowns (POPUP_CLOSE_ALL event path) also dismiss via closeAllPopups ===
    let dropdownClosed = 0;
    /** @type {() => void} */
    let relDrop = () => {};
    relDrop = registerOpenPopup({
      id: 'unit-back-btn-dropdown',
      onClose: () => { dropdownClosed++; relDrop(); },
    });
    tally(check(isAnyPopupOpen(), 'dropdown: registerOpenPopup marks open', errors));
    closeAllPopups();
    tally(check(dropdownClosed === 1, 'dropdown: closed via POPUP_CLOSE_ALL event', errors));
    tally(check(!isAnyPopupOpen(), 'dropdown: nothing open afterwards', errors));
    await tick();
  } finally {
    // Drain any deferred sentinel removal before restoring the real API.
    await tick();
    window.history.pushState = realPush;
    window.history.back = realBack;
  }

  return { passed, failed, errors };
}
