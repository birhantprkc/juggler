//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 12: a thread column opens on the START of its last message.
 *
 * Opening a finished thread is an instruction to read what it came back with,
 * and what it came back with is usually taller than the column. Landing at the
 * end of the conversation — correct everywhere else — puts the reader at the
 * last line of that answer, facing a scroll backwards before they can begin.
 *
 * A thread still being driven is the opposite case and keeps today's landing:
 * there is nothing finished to read, and the end is where the next token
 * appears. Both are asserted here, in that order, against the SAME column —
 * columns are reused across thread navigations, so the second open also pins
 * the reuse: a landing tied to the column element rather than to the thread it
 * has been pointed at would fire once and never again.
 *
 * The landing is asked for here rather than waited for. conversation-tab
 * schedules it a frame after the render, and a pool lane's WebView is hidden
 * and software-rendered, so that frame arrives whenever the engine gets round
 * to it. The landing is one-shot, so asking again is either the landing itself
 * or a no-op on top of one that already happened — the assertion that follows
 * is the same either way.
 * @module unit-tests/thread-column-landing-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/** Several viewports of prose: the reply a reader opens the thread to read. */
const LONG_REPLY = `Here is what I found. ${'The quick brown fox jumps over the lazy dog. '.repeat(300)}`;

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

    /** @type {any} */
    let finished = null;
    /** @type {any} */
    let running = null;
    doc.transact(() => {
      root.addEvent(createUserMessage('Look into both of these'));
      finished = root.createSubThread({
        goal: 'The one that finished',
        initialItems: [
          createAssistantMessage('Looking…'),
          createAssistantMessage(LONG_REPLY)
        ],
        extra: { result: 'Done.' }
      });
      running = root.createSubThread({
        goal: 'The one still going',
        initialItems: [
          createAssistantMessage('Looking…'),
          createAssistantMessage(LONG_REPLY)
        ]
      });
    }, author);

    // --- A finished thread opens on the start of its last message ---

    tab.openThread(finished.threadId);

    const threadCol = /** @type {any} */ (tab.querySelector('conversation-area.thread-column'));
    assert(!!threadCol, 'opening a thread should give the tab a thread column');
    const list = /** @type {HTMLElement} */ (threadCol.querySelector('#message-list'));
    assert(!!list, 'the thread column should have a message list');

    /** @returns {HTMLElement} The column's last rendered message. */
    const lastMessage = () => {
      const inner = /** @type {HTMLElement} */ (threadCol.querySelector('#message-list-inner'));
      const messages = inner.querySelectorAll('assistant-message');
      const el = /** @type {HTMLElement|null} */ (messages[messages.length - 1] ?? null);
      assert(!!el, 'the thread column should have rendered its reply');
      return /** @type {HTMLElement} */ (el);
    };

    threadCol.restoreScrollPosition();

    const reply = lastMessage().getBoundingClientRect();
    const view = list.getBoundingClientRect();
    assert(reply.height > view.height,
      `test setup: the reply must be taller than the column, got ${reply.height}px ` +
      `of message in ${view.height}px of viewport`);
    assert(Math.abs(reply.top - view.top) <= 4,
      `opening a finished thread must show the START of its reply: the message ` +
      `begins ${Math.round(reply.top - view.top)}px from the top of the viewport`);

    // --- A thread still running opens at the end, as everything else does ---
    //
    // Non-vacuous because of the case above: this reuses that column, which is
    // parked a long way back at the start of the other thread's reply.
    conversation._llmState.updateStatus(
      conversation.id, 'custom', { message: 'Working' }, running.threadId);
    assert(conversation.isThreadProcessing(running.threadId),
      'test setup: the second thread should read as being driven');

    tab.openThread(running.threadId);
    assert(tab.querySelector('conversation-area.thread-column') === threadCol,
      'test setup: the second thread should reuse the same column');

    threadCol.restoreScrollPosition();

    assert(Math.abs(list.scrollTop) <= 1,
      `a thread still being driven must open at the end, where its next token ` +
      `lands — left ${Math.abs(list.scrollTop)}px short of it`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'thread-column-landing:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
