//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Parallel sub-threads must not farm the parent column's selection.
 *
 * With several threads running under one conversation, the worker's
 * processingState projection names whichever run wrote last, so the top-level
 * threadItemId alternates between siblings several times a second. Each rename
 * reaches ColumnSelectionState.maybeAutoSelectThread, which rewrites the whole
 * column chain — the parent column's selection included. A reader who selected
 * a plain item and then let the pin lift (rule A: selecting the last row
 * re-arms auto-follow) has their selection yanked onto a sub-thread tile on
 * every flip.
 *
 * Two properties hold it still, asserted here:
 *   - getStatusThreadId keeps naming the thread it named while that thread
 *     still holds a live run; the projection's churn between live siblings is
 *     not a change of answer.
 *   - the status path reveals a given thread at most once, so a thread's
 *     ongoing life can never rewrite the chain again.
 *
 * The closing phase documents the boundary that remains: when the named thread
 * rests and a sibling takes over, that sibling's first frame may still open it
 * once — the deferred open the pin test promises, not a repeat steal.
 * @module unit-tests/parallel-thread-selection-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage
} from '../../sdk/lib/message.js';
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

  try {
    const session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // A parent turn running two sub-threads side by side, and still streaming
    // its own rows after them — the plain row is the tail of the root column.
    /** @type {string} */
    let threadA = '';
    /** @type {string} */
    let threadB = '';
    const plainMsg = createAssistantMessage('The parent streams on.');
    doc.transact(() => {
      root.addEvent(createUserMessage('Look into both'));
      threadA = root.createSubThread({
        goal: 'First look',
        initialItems: [createAssistantMessage('Working.')]
      }).threadId;
      threadB = root.createSubThread({
        goal: 'Second look',
        initialItems: [createAssistantMessage('Working too.')]
      }).threadId;
      root.addEvent(plainMsg);
    }, author);
    const plainId = /** @type {string} */ (plainMsg.itemId);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');

    // The open thread columns, by thread id.
    const openThreadIds = () => Array.from(tab.querySelectorAll('conversation-area.thread-column'))
      .map((/** @type {any} */ col) => col.getMessageThread?.()?.threadItemId);

    // A processing frame the way the worker sends one while both run: every
    // live run present under `runs`, the top-level projection naming whichever
    // of them wrote the frame.
    const frameNaming = (/** @type {string} */ named) => ({
      status: 'streaming',
      threadItemId: named,
      runs: {
        [threadA]: { threadItemId: threadA, status: 'streaming' },
        [threadB]: { threadItemId: threadB, status: 'streaming' }
      }
    });

    // While nobody is reading, the status path opens the projected thread —
    // once. This frame names A.
    conversation.llmState._handleProcessingStateChange(conversation.id,
      frameNaming(threadA));

    // The user selects the plain parent row to look at it. It is the tail, so
    // rule A re-arms auto-follow: from here on this column is exactly as
    // unprotected as auto-follow itself, which is the reported case.
    rootCol.selectItem(plainId);
    assert(rootCol.getSelectedItemId() === plainId,
      'selecting the plain row should select it; got ' + rootCol.getSelectedItemId());

    // The projection flips between the siblings as each takes its turn to
    // write — several times a second in a real turn.
    for (const named of [threadB, threadA, threadB, threadA, threadB]) {
      conversation.llmState._handleProcessingStateChange(conversation.id,
        frameNaming(named));
    }

    assert(conversation.llmState.getStatusThreadId(conversation.id) === threadA,
      'the named thread should stay ' + threadA + ' while it still runs — ' +
      'flips between live siblings are churn, not a change of answer; got ' +
      conversation.llmState.getStatusThreadId(conversation.id));
    assert(rootCol.getSelectedItemId() === plainId,
      'sub-thread activity must not move the parent selection off the plain ' +
      'row the user selected; got ' + rootCol.getSelectedItemId());
    assert(openThreadIds().length === 0,
      'no thread column should have opened over the read; got ' +
      JSON.stringify(openThreadIds()));

    // Boundary: when the named thread rests and the sibling takes over, that
    // sibling's first frame may open it — once, the deferred open the pin
    // test promises. After it, the same sibling streaming on changes nothing.
    conversation.llmState._handleProcessingStateChange(conversation.id, {
      status: 'streaming',
      threadItemId: threadB,
      runs: { [threadB]: { threadItemId: threadB, status: 'streaming' } }
    });
    assert(rootCol.getSelectedItemId() === threadB,
      'the resting thread\u2019s successor opens once (the deferred open)');
    for (let i = 0; i < 3; i++) {
      conversation.llmState._handleProcessingStateChange(conversation.id, {
        status: 'streaming',
        threadItemId: threadB,
        runs: { [threadB]: { threadItemId: threadB, status: 'streaming' } }
      });
    }
    assert(rootCol.getSelectedItemId() === threadB,
      'a thread the status path already opened never rewrites the chain again');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
  }

  return { passed, failed, errors };
}
