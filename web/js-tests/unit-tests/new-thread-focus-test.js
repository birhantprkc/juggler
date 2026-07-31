//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Pressing "New Thread" with drafted text must move that text into the new
 * thread's box AND leave keyboard focus on the new box.
 *
 * The new column is built during a synchronous rebuild, but its input-box
 * textarea isn't focusable in that same tick and a late re-render can bounce
 * focus to <body> — so the rebuild's focus has to be re-asserted across a short
 * window (conversation-tab._reassertInputFocus). Regression guard for that.
 * @module unit-tests/new-thread-focus-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1400px;height:900px;';
  document.body.appendChild(container);

  /** @type {((e: Event) => void)|null} */
  let sendHandler = null;

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

    // Wire send-message → conversation.sendMessage, mirroring UIEventManager,
    // and capture the promise so we can await full delivery (the /thread
    // command's openThread side effect runs inside sendMessage).
    /** @type {Promise<any>|null} */
    let pendingSend = null;
    sendHandler = (event) => {
      const detail = /** @type {any} */ (event).detail;
      if (!detail || !detail.message) return;
      pendingSend = conversation.sendMessage(
        detail.message,
        detail.threadItemId || null,
        detail.messageThread || conversation.rootMessageThread
      );
    };
    document.addEventListener('send-message', sendHandler);

    const rootInputBox = /** @type {any} */ (tab.querySelector('input-box'));
    assert(!!rootInputBox, 'root input-box should exist');
    if (!rootInputBox._messageThread) rootInputBox.setMessageThread(conversation.rootMessageThread);

    const rootTextarea = /** @type {HTMLTextAreaElement} */ (rootInputBox.querySelector('textarea'));
    assert(!!rootTextarea, 'root textarea should exist');

    // Simulate the user having typed a prompt with the box focused.
    const draft = 'carry me into the new thread';
    rootTextarea.value = draft;
    rootTextarea.focus();
    assert(document.activeElement === rootTextarea, 'precondition: root textarea focused after typing');

    // Press "New Thread".
    rootInputBox._createThread();

    await waitFor(() => !!pendingSend, { description: 'send-message to fire' });
    await pendingSend;

    // The new thread column's input-box textarea must appear...
    await waitFor(
      () => tab.querySelectorAll('input-box textarea').length >= 2,
      { description: 'new thread column input-box textarea to build' }
    );
    const textareas = /** @type {HTMLTextAreaElement[]} */ (
      Array.from(tab.querySelectorAll('input-box textarea'))
    );
    const newTextarea = textareas[textareas.length - 1];

    // ...and the drafted text must have moved into it.
    assert(
      newTextarea.value.includes(draft),
      `new thread box should contain the moved draft (got: "${newTextarea.value}")`
    );

    // The behaviour under test: keyboard focus lands (and stays) on the new box.
    // Its focus is re-asserted across a few macrotasks, so wait for it to settle.
    await waitFor(
      () => document.activeElement === newTextarea,
      { timeoutMs: 2000, description: 'focus to settle on the new thread box' }
    ).catch(() => {});

    const active = /** @type {HTMLElement} */ (document.activeElement);
    let where;
    if (active === newTextarea) where = 'new-box';
    else if (active === rootTextarea) where = 'root-box';
    else if (active?.tagName === 'TEXTAREA') where = 'other-textarea';
    else where = (active?.tagName || 'none') + (active === document.body ? '(body)' : '');
    assert(active === newTextarea, `new thread box must hold keyboard focus, but focus was on: ${where}`);

    // Source box emptied by the move.
    assert(rootTextarea.value === '', `root box should be empty after move (got: "${rootTextarea.value}")`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (sendHandler) document.removeEventListener('send-message', sendHandler);
    container.remove();
  }

  return { passed, failed, errors };
}
