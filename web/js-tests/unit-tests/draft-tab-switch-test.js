//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Switching conversation tabs must keep each tab's live message box intact —
 * its exact text AND its native undo history. Each top-level tab has its own
 * persistent <input-box>/<textarea>, so the browser undo stack lives on that
 * element and should survive a switch untouched. Two failure modes broke that:
 *
 *  A. The draft is only persisted by a keystroke DEBOUNCE. Leaving a tab within
 *     the debounce window stranded the last-typed characters in the live
 *     textarea while the persisted draft lagged behind — so any later restore
 *     painted stale/empty text. Parking a tab (setHidden) must flush the draft.
 *
 *  B. The restore in setMessageThread reassigns `textarea.value` (which wipes
 *     the native undo stack) whenever it thinks the thread is "new". That guard
 *     was keyed on the MessageThread OBJECT, so a transient loss of the box's
 *     binding made a re-bind to the SAME thread look new — clobbering the live
 *     text and its undo history. A re-bind to the same logical thread must be a
 *     no-op: no value write at all.
 *
 *  C. Guard against over-correcting B: binding a box to a thread it has NOT yet
 *     shown must still restore that thread's persisted draft.
 * @module unit-tests/draft-tab-switch-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
} from '../utilities/test-helpers.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {boolean} cond
   * @param {string} msg
   */
  const check = (cond, msg) => {
    if (cond) { passed++; } else { failed++; errors.push(msg); }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1400px;height:900px;';
  document.body.appendChild(container);

  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await waitFor(
      () => !!tab.querySelector('input-box textarea'),
      { description: 'root input-box textarea to build' }
    );

    const box = /** @type {any} */ (tab.querySelector('input-box'));
    if (!box._messageThread) box.setMessageThread(conversation.rootMessageThread);
    const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));

    // ---- Case A: parking a tab flushes the debounced draft ------------------
    // Simulate typing (value set + a scheduled, NOT-yet-fired debounce save),
    // then leave the tab before the debounce fires. The persisted draft must
    // already carry the live text.
    box.clearInput();
    const typedA = 'typed but not yet saved (A)';
    textarea.value = typedA;
    box._scheduleDraftSave(typedA); // arms the debounce; does NOT persist yet

    tab.setHidden();

    const draftA = conversation.rootMessageThread.draft;
    check(
      !!draftA && draftA.text === typedA,
      `Case A: setHidden must flush the live draft to the model before parking the tab; ` +
      `expected ${JSON.stringify(typedA)}, got ${JSON.stringify(draftA && draftA.text)}`
    );

    // ---- Case B: re-binding the SAME thread must not touch the textarea -----
    // Clean slate, then simulate unsaved in-flight typing.
    box.clearInput();
    const liveB = 'LIVE UNSAVED (B)';
    textarea.value = liveB;

    // Spy on native value writes: a single reassignment (even to the same
    // string) resets the browser's undo stack, so zero writes == undo intact.
    const proto = window.HTMLTextAreaElement.prototype;
    const nativeValue = /** @type {PropertyDescriptor} */ (
      Object.getOwnPropertyDescriptor(proto, 'value')
    );
    let valueWrites = 0;
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get() { return nativeValue.get?.call(this); },
      set(v) { valueWrites++; nativeValue.set?.call(this, v); },
    });

    // Reproduce the intermittent rogue re-bind: the box transiently loses its
    // thread binding, then _rebuildColumns re-binds it to the SAME root thread.
    box._messageThread = null;
    box.setMessageThread(conversation.rootMessageThread);

    check(
      textarea.value === liveB,
      `Case B: re-binding the same thread must not overwrite live unsaved text; ` +
      `got ${JSON.stringify(textarea.value)}`
    );
    check(
      valueWrites === 0,
      `Case B: re-binding the same thread must not reassign textarea.value ` +
      `(that wipes the native undo stack); value writes = ${valueWrites}`
    );

    // Restore the native accessor before the next case.
    delete (/** @type {any} */ (textarea)).value;

    // ---- Case C: first bind to a not-yet-shown thread still restores --------
    box.clearInput();
    const restoreC = 'RESTORE ME (C)';
    conversation.rootMessageThread.draft = { text: restoreC };
    const preC = conversation.rootMessageThread.draft;
    check(
      !!preC && preC.text === restoreC,
      `Case C precondition: draft should be set on the model; got ${JSON.stringify(preC && preC.text)}`
    );

    // A box that has never shown this thread (fresh key + no binding).
    box._restoredThreadKey = null;
    box._messageThread = null;
    textarea.value = '';
    box.setMessageThread(conversation.rootMessageThread);

    check(
      textarea.value === restoreC,
      `Case C: binding a not-yet-shown thread must restore its persisted draft; ` +
      `got ${JSON.stringify(textarea.value)}`
    );
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? (e.stack || e.message) : String(e));
  } finally {
    container.remove();
  }

  return { passed, failed, errors };
}
