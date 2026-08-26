//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 3/8b: the message the user just sent is always brought into view.
 *
 * Rule 4b leaves a reader who has scrolled away alone, and it is meant to:
 * items arriving from a running turn must not haul their view about. Sending is
 * the opposite instruction, from the same person, and it wins — from anywhere in
 * the conversation, however long it is.
 *
 * The case that matters is the second one here. The user message rarely arrives
 * alone: the sync batches, so it lands together with the first thing the turn
 * did, an auto-selection takes that item, and a scroll made on the selection's
 * behalf is exactly the scroll rule 4b withholds from this reader. So the follow
 * cannot be something the selection happens to do on the way past.
 * @module unit-tests/user-send-follow-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import '../../js/components/conversation-tab.js';

/**
 * @param {string} id - Distinguishes the row from its siblings.
 * @returns {any} A completed tool action — an item rule 2 would auto-select.
 */
function completedToolAction(id) {
  return createToolActionMessage({
    toolUseId: id,
    toolName: 'write',
    toolInput: { file_path: `${id}.txt`, content: 'hello' },
    state: TOOL_STATES.COMPLETED,
    result: { state: 'completed', content: 'File written' }
  });
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

    // A conversation long enough to get lost in — the reported failure needed
    // the distance, because the scroll that lost it was a glide the arriving
    // turn had time to interrupt.
    doc.transact(() => {
      root.addEvent(createUserMessage('Do a long piece of work'));
      for (let i = 0; i < 40; i++) {
        root.addEvent(createAssistantMessage(
          `Step ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(8)}`));
      }
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');

    // Park near the START of the conversation. The scroller is column-reverse,
    // where the end sits at scrollTop 0 and scrolling back runs negative on
    // WebKit; the sign is engine-detail, so try it and fall back rather than
    // assume. scrollTo({behavior:'instant'}), never a scrollTop assignment: the
    // scroller sets scroll-behavior: smooth, so an assignment animates and reads
    // back as the position we started from.
    const toStart = () => {
      const travel = list.scrollHeight - list.clientHeight;
      list.scrollTo({ top: -travel, behavior: 'instant' });
      if (Math.abs(list.scrollTop) <= 320) list.scrollTo({ top: travel, behavior: 'instant' });
      assert(Math.abs(list.scrollTop) > 320,
        `test setup: should be parked clear of the near-bottom band, got ${list.scrollTop}`);
    };

    assert(list.scrollHeight - list.clientHeight > 400,
      `test setup: the list must overflow to be scrollable, got ` +
      `${list.scrollHeight - list.clientHeight}px of travel`);

    // The message arrives on its own.
    toStart();
    doc.transact(() => {
      root.addEvent(createUserMessage('And now do this'));
    }, author);
    assert(Math.abs(list.scrollTop) <= 1,
      `sending must show the message it sent, wherever the reader was — ` +
      `left at scrollTop ${list.scrollTop}`);

    // The message arrives batched with the turn's first item, which takes the
    // auto-selection. The selection's own scroll is withheld here (rule 4b), so
    // this is the case where a follow delegated to it goes missing entirely.
    toStart();
    const selectedBefore = rootCol.getSelectedItemId();
    doc.transact(() => {
      root.addEvent(createUserMessage('And this too'));
      root.addEvent(completedToolAction('call_with_send_1'));
    }, author);

    assert(rootCol.getSelectedItemId() !== selectedBefore,
      'the turn\'s item still auto-selects: rule 3 re-arms auto-follow');
    assert(Math.abs(list.scrollTop) <= 1,
      `an auto-selection landing in the same batch must not swallow the send's ` +
      `scroll — left at scrollTop ${list.scrollTop}`);

    // The rule is about the reader's own action, not about being at the end:
    // items that arrive on their own still leave a scrolled-away reader alone.
    toStart();
    const parked = list.scrollTop;
    doc.transact(() => {
      root.addEvent(completedToolAction('call_no_send_1'));
    }, author);
    assert(Math.abs(list.scrollTop) > 320,
      `rule 4b must survive: an item arriving without a user message must not ` +
      `move a scrolled-away reader (went ${parked} → ${list.scrollTop})`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'user-send-follow:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
