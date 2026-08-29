//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The starting hint on the empty background of a conversation with no history.
 *
 * The one thing that can quietly break it is the emptiness test: a new
 * conversation is NOT an empty one — it is seeded with standing context items
 * before the first message, so an item COUNT would hide the hint on exactly the
 * conversation it exists for. The assertions are therefore that it shows while
 * the column holds only standing items, and goes the moment a conversational
 * item lands.
 *
 * It is an absolutely-positioned sibling of the scroller rather than a row in
 * the transcript, so the second assertion also stands for the item diff never
 * having a chance to delete it.
 * @module unit-tests/empty-conversation-hint-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage } from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

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
    conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    tab.style.cssText = 'display:flex;height:100%;min-height:0;overflow:hidden;';
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    // A tab's first activation defers its transcript sync by a macrotask, and
    // nothing else here mutates the doc to force the rebuild early.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const hint = /** @type {HTMLElement|null} */ (rootCol.querySelector('conversation-empty-hint'));
    assert(!!hint, 'the column should carry the starting hint');

    // --- A fresh conversation shows it, standing context items and all ---

    assert(conversation.rootItems.length > 0,
      'test setup: a new conversation should already hold seeded standing context ' +
      'items, or this proves nothing about counting items instead of history');
    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden') === false,
      'a conversation with no history should show the starting hint, but it is hidden' +
      ` (the column holds ${conversation.rootItems.length} seeded item(s))`);

    // --- The first real message retires it ---

    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;
    doc.transact(() => {
      conversation.rootMessageThread.addEvent(createUserMessage('Right, off we go'));
    }, author);

    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'the hint should go as soon as the conversation has history');

    // --- A thread column never shows it ---

    // Called directly: opening a real sub-thread would prove the same thing at
    // the cost of a whole turn, and the rule under test is one line of state.
    rootCol._threadYMap = {};
    rootCol._updateEmptyHint([]);
    assert(/** @type {HTMLElement} */ (hint).classList.contains('hidden'),
      'a thread column is opened from work already done and must not show the hint');
    rootCol._threadYMap = null;

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'empty-conversation-hint:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
