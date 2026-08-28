//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The scroll-to-top control reaches the top.
 *
 * It scrolls by a measured delta rather than to a known offset, because the
 * reversed scroller's scrollTop sign is engine detail. That measurement is the
 * fragile part: taken from the content column's first CHILD it read as a few
 * dozen pixels of chrome on any root conversation, because the column leads with
 * a `display: none` `thread-column-actions` and a box-less element's rect is all
 * zeros. The button moved the view a fraction of an inch and stopped.
 *
 * So the assertion is the whole journey — press it from the end of a long
 * conversation and the oldest message must be on screen — not the shape of the
 * delta, which is free to be computed however it likes.
 * @module unit-tests/scroll-to-top-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * Wait for a smooth scroll to finish: poll until the offset holds still across
 * two reads, so the assertion sees where the scroll landed rather than a frame
 * part-way through it.
 * @param {HTMLElement} list - The `#message-list` scroller.
 * @returns {Promise<void>} Resolves once the offset has settled (or the wait caps out).
 */
async function settled(list) {
  let last = NaN;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (list.scrollTop === last) return;
    last = list.scrollTop;
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    // The column only scrolls if it is height-constrained; left to itself the
    // tab grows to its content and nothing ever overflows.
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // Long enough that the trip to the top is unmistakable, and that the oldest
    // rows sit far outside the content-visibility band on the way.
    doc.transact(() => {
      root.addEvent(createUserMessage('The first thing I ever asked'));
      for (let i = 0; i < 60; i++) {
        root.addEvent(createAssistantMessage(
          `Step ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(8)}`));
      }
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');

    const range = list.scrollHeight - list.clientHeight;
    assert(range > 2000,
      `test setup: the conversation must be many viewports long, got ${range}px of travel`);

    // Start from the end, where a reader who wants the top actually presses it.
    list.scrollTo({ top: 0, behavior: 'instant' });
    await settled(list);
    assert(Math.abs(list.scrollTop) < 4,
      `test setup: should start at the end, got scrollTop ${list.scrollTop}`);

    // Press the control itself, so its wiring is covered along with the maths.
    const topBtn = /** @type {HTMLElement|null} */ (
      rootCol.querySelector('#scroll-controls [data-scroll="top"]')
    );
    assert(!!topBtn, 'the column should have a scroll-to-top control');
    /** @type {HTMLElement} */ (topBtn).click();
    await settled(list);

    // |scrollTop| is the distance from the end, so the start is the far extreme
    // of the range whichever sign the engine uses.
    const fromEnd = Math.abs(list.scrollTop);
    assert(fromEnd > range / 2,
      `scroll-to-top must travel to the start of the conversation, but stopped ` +
      `${fromEnd}px from the end of a ${range}px range`);
    assert(fromEnd >= range - 40,
      `scroll-to-top must land at the very top, stopped ${range - fromEnd}px short`);

    // The point of the journey: the oldest message is on screen and rendered.
    const first = /** @type {HTMLElement|null} */ (list.querySelector('user-message'));
    assert(!!first, 'the oldest message should still be in the list');
    const firstRect = /** @type {HTMLElement} */ (first).getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    assert(firstRect.height > 0,
      'the oldest message must be rendered once scrolled to, not left content-visibility: hidden');
    assert(firstRect.bottom > listRect.top && firstRect.top < listRect.bottom,
      `the oldest message must be within the viewport, its box is ` +
      `${firstRect.top}–${firstRect.bottom} against a viewport of ${listRect.top}–${listRect.bottom}`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'scroll-to-top:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
