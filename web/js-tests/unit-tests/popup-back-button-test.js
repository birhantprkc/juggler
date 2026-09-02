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
 *  - the `popstate` answering our OWN sentinel drop is not a Back press: an
 *    overlay opened while it was in flight survives it, and the history layer is
 *    covered again afterwards;
 *  - Escape routes through the same registered-handler dismissal;
 *  - closeAllPopups() closes most-recently-opened first (LIFO), and also
 *    dismisses dropdowns wired through the POPUP_CLOSE_ALL event.
 *
 * The History API is stubbed for all but the first case, so the test never
 * actually navigates the iframe — a real history.back() at the base entry would
 * unload the test page — and we assert only that popup-manager drives push/back
 * correctly. The stray-pop case is the exception: it needs the real API, since
 * the whole of it happens in the gap before a real back() answers. It leaves the
 * layer as it found it, on the sentinel entry it pushed.
 * @module unit-tests/popup-back-button-test
 */

import {
  markPopupOpen,
  isAnyPopupOpen,
  isForeignPopupOpen,
  closeAllPopups,
  registerOpenPopup,
  __resetPopupManagerForTests,
} from '../../js/utils/popup-manager.js';
import { modelGestureShouldHandle } from '../../js/services/model-cycler.js';

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
 * Wait for the next `popstate` — the browser's answer to a history.back(), which
 * arrives in its own task some time after the call.
 * @param {number} [timeoutMs] - How long to wait before giving up.
 * @returns {Promise<boolean>} True if a popstate arrived within the budget.
 */
function nextPopstate(timeoutMs = 2000) {
  return new Promise((resolve) => {
    /** @type {any} */
    let timer = null;
    const onPop = () => { clearTimeout(timer); resolve(true); };
    window.addEventListener('popstate', onPop, { once: true });
    timer = setTimeout(() => {
      window.removeEventListener('popstate', onPop);
      resolve(false);
    }, timeoutMs);
  });
}

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

  // === a sentinel WE dropped must not dismiss the overlay that replaced it ===
  //
  // This case runs against the REAL History API, before the stub below goes in:
  // the failure lives entirely in the gap between history.back() being called
  // and its popstate arriving, and a stubbed back() never produces one.
  //
  // Closing the last overlay queues the sentinel's retraction. An overlay that
  // opens after that back() has been called — but before its popstate lands —
  // pushes a fresh sentinel and is then hit by the trailing pop, which the
  // handler reads as a Back press and dismisses it. It is not a Back press: it
  // is our own retraction answering. (Seen as the Pinboard's refused-open notice
  // vanishing when it opened just after a context menu closed.)
  //
  // The traversal also does NOT land where the overlay's own sentinel is: its
  // target is fixed when it is queued, so the entry pushed while it was in
  // flight is jumped clean over (measured in WebKit: the pop arrives at the base
  // entry with both sentinels left ahead of it). That leaves the layer bare, so
  // the second half of the case is that it gets covered again — a layer that
  // believes in a sentinel it hasn't got spends the user's next Back press
  // leaving the app.
  __resetPopupManagerForTests();
  const relClosingReal = markPopupOpen(() => {});
  relClosingReal();       // last overlay closes → retraction queued
  await tick();           // the retraction runs: history.back() is called
  const popLanded = nextPopstate();
  let strayClosed = 0;
  /** @type {() => void} */
  let relAfterPop = () => {};
  relAfterPop = markPopupOpen(() => { strayClosed++; relAfterPop(); });
  const sawPop = await popLanded;
  // Without the pop there is nothing to survive, so the checks below would pass
  // for the wrong reason.
  tally(check(sawPop, 'stray-pop: precondition — the retraction popstate arrived', errors));
  tally(check(strayClosed === 0,
    `stray-pop: an overlay opened during our own sentinel drop survives it (closed ${strayClosed}×)`, errors));
  tally(check(isAnyPopupOpen(), 'stray-pop: and it is still registered open', errors));
  const coveredAfterPop = /** @type {any} */ (window.history.state);
  tally(check(!!coveredAfterPop && coveredAfterPop[OVERLAY_MARKER] === true,
    `stray-pop: the overlay layer is covered by a real sentinel again, got ${JSON.stringify(coveredAfterPop)}`, errors));
  // Drain this overlay's own retraction before the stubs go up, so no real pop
  // wanders into the stubbed cases below.
  const drainPop = nextPopstate();
  relAfterPop();
  await tick();
  tally(check(await drainPop, 'stray-pop: the closing overlay drops its sentinel for real', errors));

  // Stub History so no real navigation occurs; count the calls popup-manager
  // makes and capture the most recent pushed state for assertions.
  const realPush = window.history.pushState;
  const realBack = window.history.back;
  let pushCount = 0;
  let backCount = 0;
  /** @type {any} */
  let lastPushState = null;
  window.history.pushState = function (state) { pushCount++; lastPushState = state; };
  // The stub answers with a popstate, as the real API does a task later. A stub
  // that only counts leaves popup-manager owed an answer for the rest of the
  // realm's life, and the next Back press is spent settling that debt instead of
  // dismissing. Answering synchronously keeps each case's bookkeeping settled by
  // the time it asserts.
  window.history.back = function () {
    backCount++;
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  };

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

    // === isForeignPopupOpen: the window-wide cycler gate ===
    // Clean baseline, then exercise each foreign/own combination. `dummyEvt`
    // stands in for the KeyboardEvent the gate ignores (it reads focus from
    // nothing — the whole point is that it fires window-wide).
    __resetPopupManagerForTests();
    const dummyEvt = /** @type {any} */ ({});
    tally(check(!isForeignPopupOpen([]), 'foreign: nothing open ⇒ not foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === true,
      'gate: fires when nothing is open', errors));

    // A foreign id-keyed dropdown blocks the gesture.
    const relForeign = registerOpenPopup({ id: 'some-other-dropdown', onClose: () => {} });
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'foreign: an id outside the allow-list is foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === false,
      'gate: stands down while a foreign dropdown is open', errors));
    relForeign();

    // The cyclers' OWN HUD popup is never foreign — the gesture fires over it.
    const relOwn = registerOpenPopup({ id: 'model-selector', onClose: () => {} });
    tally(check(!isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'own: the allow-listed HUD id is not foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === true,
      'gate: fires over the cyclers own model-selector HUD', errors));

    // ...but a foreign modal stacked over the own HUD still blocks it.
    const relModal = markPopupOpen(() => {});
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'own+modal: an id-less modal over the HUD is still foreign', errors));
    tally(check(modelGestureShouldHandle(dummyEvt) === false,
      'gate: a foreign modal over the HUD stands the gesture down', errors));
    relModal();
    relOwn();

    // A bare modal (id-less markPopupOpen) is foreign even against any allow-list.
    const relBareModal = markPopupOpen(() => {});
    tally(check(isForeignPopupOpen(['model-selector', 'thinking-mini']),
      'modal: an id-less modal has no id to allow-list ⇒ foreign', errors));
    relBareModal();
    tally(check(!isForeignPopupOpen(['model-selector']),
      'cleanup: nothing foreign after releasing everything', errors));
    await tick();
  } finally {
    // Drain any deferred sentinel removal before restoring the real API.
    await tick();
    window.history.pushState = realPush;
    window.history.back = realBack;
  }

  return { passed, failed, errors };
}
