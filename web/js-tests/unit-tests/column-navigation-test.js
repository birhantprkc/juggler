//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What may move the Miller columns sideways, and what may take the arrow keys.
 *
 * Both are the user's to set — they scroll the row by dragging, and they choose
 * the column they are working in — so the rules pinned here are about NOT
 * touching either:
 *
 *   1. An auto-selection (a column picking up an item that just arrived) applies
 *      to its own column and leaves the keyboard where the user left it. Only a
 *      selection the user drives moves the active column.
 *   2. Walking items with ↑/↓ never scrolls the row horizontally. The selection
 *      moves inside one column; nothing to its left or right was asked for.
 *   3. Clicking into a column that is off-screen still reveals it — the case
 *      that must keep working, and the control that stops rule 2 from passing
 *      because nothing scrolls at all.
 * @module unit-tests/column-navigation-test
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
import { ColumnSelectionState } from '../../js/utils/column-selection.js';
import '../../js/components/conversation-tab.js';

/**
 * Let deferred work land. The column scroll is scheduled on
 * requestAnimationFrame, shimmed to a macrotask below, so a couple of
 * macrotask hops is enough.
 * @returns {Promise<void>} Resolves once queued callbacks have run.
 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 20); });
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

  /**
   * @param {string} label - Rule under test, used to label a failure.
   * @param {() => void|Promise<void>} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('an auto-selection leaves the keyboard in the column the user is in', () => {
    const state = new ColumnSelectionState();
    state.selectItem(0, 'root-item');
    state.selectItem(1, 'thread-item');
    assert(state.activeColumnIndex === 1,
      'the user clicking into a column takes the keyboard with them');

    // The thread column picks up a tool action as it arrives while the user
    // reads the root column.
    state.activeColumnIndex = 0;
    state.selectItem(1, 'arriving-tool-action', { focus: false });
    assert(state.activeColumnIndex === 0,
      `an auto-selection stole the keyboard target (column ${state.activeColumnIndex})`);
    assert(state.selections[1] === 'arriving-tool-action',
      'the auto-selection must still apply to its own column');
  });

  await run('focus left past a shortened chain is clamped back into range', () => {
    const state = new ColumnSelectionState();
    state.selections = ['a', 'b', 'c'];
    state.activeColumnIndex = 2;
    // The root column auto-selects: everything past it is a stale chain.
    state.selectItem(0, 'new-root-item', { focus: false });
    assert(state.selections.length === 1, 'truncation applies whoever selected');
    state.clampActiveIndex([{ tagName: 'CONVERSATION-AREA' }]);
    assert(state.activeColumnIndex === 0,
      `focus dangled past the chain at column ${state.activeColumnIndex}`);
  });

  // The column scroll is scheduled on requestAnimationFrame, which never fires
  // in the hidden test-pool window. Shim it to a macrotask for the duration so
  // the deferred scroll runs deterministically (production keeps the real rAF).
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  /** @type {Map<number, ReturnType<typeof setTimeout>>} */
  const pendingFrames = new Map();
  let nextFrameId = 1;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) => {
    const id = nextFrameId++;
    pendingFrames.set(id, setTimeout(() => { pendingFrames.delete(id); cb(Date.now()); }, 0));
    return id;
  };
  window.cancelAnimationFrame = (/** @type {number} */ id) => {
    const t = pendingFrames.get(id);
    if (t) { clearTimeout(t); pendingFrames.delete(id); }
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let tab = null;
  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    doc.transact(() => {
      root.addEvent(createUserMessage('Read a file'));
      root.addEvent(createAssistantMessage('Reading...'));
      root.addEvent(createToolActionMessage({
        toolUseId: 'call_col_nav_1',
        toolName: 'read',
        toolInput: { file_path: 'nav.txt' },
        state: TOOL_STATES.COMPLETED,
        result: { state: 'completed', content: 'hello' }
      }));
      root.addEvent(createAssistantMessage('Read it.'));
    }, conversation._doc.authorId);

    const container = /** @type {HTMLElement} */ (tab.querySelector('column-container'));
    assert(!!container, 'no column-container');

    // Narrow the row so the columns overflow it and a horizontal scroll
    // position exists to be lost. Both columns are at least 30rem wide.
    container.style.width = '520px';
    container.style.maxWidth = '520px';

    const rootCol = /** @type {any} */ (tab.querySelectorAll('column-container > conversation-area')[0]);
    assert(!!rootCol, 'no root conversation column');

    // Land the selection in the middle of the list: the tail re-arms
    // auto-follow (rule A), and both neighbours must exist for ↑ and ↓.
    const ids = rootCol.getSelectableItemIds();
    assert(ids.length >= 3, `expected at least 3 selectable items, got ${ids.length}`);
    rootCol.selectItem(ids[1]);
    await settle();

    // Stand where the user would: the row dragged right, so the column being
    // navigated is only partly on screen. Any rule that re-anchors the row on
    // selection has something to move here — parked at the left edge it would
    // have nothing to do, and this could not tell the two apart. `auto`
    // overrides the row's smooth CSS so the position lands now, not over the
    // next few frames.
    container.style.scrollBehavior = 'auto';
    container.scrollLeft = 200;
    assert(container.scrollLeft > 1,
      'the columns did not overflow the row, so there was no scroll position to lose');

    // Record every horizontal move the tab asks for, without performing it:
    // the row's `scroll-behavior: smooth` would otherwise still be animating
    // when the assertion reads scrollLeft, and a scroll that has not landed
    // yet looks exactly like one that never happened.
    /** @type {any[]} */
    const scrolls = [];
    const realScrollTo = container.scrollTo.bind(container);
    /** @type {any} */ (container).scrollTo = (/** @type {any} */ opts) => { scrolls.push(opts); };

    try {
      const selectedId = () => rootCol.querySelector('.selected')?.getAttribute('message-id') ?? null;
      const before = selectedId();
      const press = (/** @type {string} */ key) => {
        rootCol.querySelector('#message-list')?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true })
        );
      };

      press('ArrowUp');
      await settle();
      const afterUp = selectedId();
      assert(afterUp && afterUp !== before,
        'ArrowUp did not move the selection, so this proves nothing about scrolling');

      press('ArrowDown');
      await settle();
      assert(selectedId() === before, 'ArrowDown did not come back to where ArrowUp started');

      assert(scrolls.length === 0,
        `walking items with the arrow keys scrolled the column row ${scrolls.length} time(s) — ` +
        'the horizontal position is the user\'s');

      // Control: clicking into the properties column, which hangs off the right
      // of the narrowed row, still reveals it.
      const propsCol = /** @type {HTMLElement} */ (container.querySelector('properties-panel'));
      assert(!!propsCol, 'selecting an item did not open a properties column');
      propsCol.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      assert(scrolls.length === 1,
        'clicking into an off-screen column must still bring it into view');
    } finally {
      /** @type {any} */ (container).scrollTo = realScrollTo;
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`arrow keys leave the horizontal scroll alone: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    tab?.setHidden?.();
    host.remove();
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (session && conversation) {
      try {
        await session.deleteConversation(conversation.id, 'column-navigation:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
