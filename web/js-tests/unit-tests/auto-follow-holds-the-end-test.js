//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Rule 11, the other direction: an automatic move never travels away from the end.
 *
 * Passing the near-bottom gate authorises following the conversation, not
 * leaving it — but "bring the selected item fully into view" frames a tall item
 * by showing its TOP, which in a bottom-anchored scroller is a scroll backwards.
 * Both halves of that were reachable while a reader sat at the end watching a
 * turn:
 *   - a batch carrying [tool row, assistant message] auto-selects the tool row,
 *     which is no longer the tail, so the selection scroll takes the minimal-
 *     movement path and hauls the view back by the row's overhang;
 *   - the streaming path asked "is the view pinned to within a pixel" where the
 *     rest of the system asks "is it near the end", so one stray pixel off the
 *     bottom turned on the reader anchor and each batch's growth was undone as
 *     drift.
 * Either one lands the reader outside the near-bottom band, where the anchor
 * holds them for the rest of the turn.
 *
 * The reader's own selection is not an automatic move and must still frame
 * whatever it selects — that is the control here, and the reason the fix cannot
 * simply be "never scroll backwards".
 * @module unit-tests/auto-follow-holds-the-end-test
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
 * @param {number} n - Sentences to emit.
 * @returns {string} Text tall enough to overflow the column several times over.
 */
const longText = (n) => 'the quick brown fox jumps over the lazy dog. '.repeat(n);

/**
 * @param {string} id - Distinguishes the row from its siblings.
 * @returns {any} A completed tool action — the item rule 2 falls back to.
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

    // Enough conversation that there is somewhere behind the reader to be
    // dragged back to.
    doc.transact(() => {
      root.addEvent(createUserMessage('Do a long piece of work'));
      for (let i = 0; i < 30; i++) {
        root.addEvent(createAssistantMessage(`Step ${i}: ${longText(8)}`));
      }
    }, author);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    const list = /** @type {HTMLElement} */ (rootCol.querySelector('#message-list'));
    assert(!!list, 'the column should have a message list');
    const viewport = list.clientHeight;
    assert(list.scrollHeight - viewport > 800,
      `test setup: the list must overflow to be scrollable, got ` +
      `${list.scrollHeight - viewport}px of travel`);

    // The reversed scroller's top extreme is +range or −range depending on the
    // engine; probe it rather than assume.
    const sign = (() => {
      list.scrollTo({ top: -400, behavior: 'instant' });
      return Math.abs(list.scrollTop) > 100 ? -1 : 1;
    })();

    // --- An auto-selected non-tail row must not haul the reader off the end ---

    list.scrollTo({ top: 0, behavior: 'instant' });
    assert(Math.abs(list.scrollTop) < 4,
      `test setup: should start parked at the end, got scrollTop ${list.scrollTop}`);

    // One batch, the shape a turn actually delivers: a tool row, then the text
    // that follows it. Rule 2 skips assistant messages when picking, so the tool
    // row is selected while the assistant message sits after it in selectable
    // order — and the assistant message alone is taller than the viewport, so
    // the tool row ends up entirely above it.
    //
    // How much text that takes is a font-metrics question, and a lane renders in
    // whatever font the platform gave it: the sentence count that overhangs the
    // viewport by a band and a half on one wraps to a third of that on another.
    // So the batch is delivered again with twice the text until the row overhangs
    // far enough for framing it to leave the near-bottom band. Each pass is the
    // same scenario — a tool row followed by text taller than the viewport,
    // arriving while the view sits at the end — so the assertions inside the loop
    // hold for every one of them.
    const BAND_PX = 320;
    let overhang = 0;
    let sentences = 60;
    let grownTo = sentences;
    /** @type {string|null} */
    let selectedId = null;
    /** @type {HTMLElement|null} */
    let selectedEl = null;

    for (let attempt = 0; attempt < 6 && overhang <= BAND_PX + 80; attempt++) {
      grownTo = sentences;
      doc.transact(() => {
        root.addEvent(completedToolAction(`call_tall_${attempt}`));
        root.addEvent(createAssistantMessage(
          `And here is what that produced: ${longText(grownTo)}`));
      }, author);
      sentences *= 2;

      selectedId = rootCol.getSelectedItemId();
      assert(!!selectedId, 'the arriving batch should have auto-selected an item');
      selectedEl = /** @type {HTMLElement|null} */ (
        list.querySelector(`[message-id="${selectedId}"]`)
      );
      assert(!!selectedEl, 'the auto-selected item should have a row');
      assert(/** @type {HTMLElement} */ (selectedEl).tagName === 'TOOL-ACTION-MESSAGE',
        `test setup: rule 2 should pick the tool row over the assistant message, ` +
        `picked a ${/** @type {HTMLElement} */ (selectedEl).tagName}`);

      const ids = rootCol.getSelectableItemIds();
      assert(ids[ids.length - 1] !== selectedId,
        'test setup: the auto-selected tool row must NOT be the tail, or the ' +
        'selection scroll takes the scroll-to-end path and proves nothing');

      assert(Math.abs(list.scrollTop) < 4,
        `an automatic selection must not scroll away from the end, but moved the ` +
        `view ${Math.abs(list.scrollTop)}px back to frame the row it picked`);

      // The condition the minimal-movement path acts on: the row's top is above
      // the viewport top, so "bring it fully into view" means going backwards, and
      // far enough to leave the near-bottom band. Measured after the assertion
      // above, because it is only the true overhang while the view is still at the
      // end — a move backwards is precisely one that reduces it to nothing.
      overhang = list.getBoundingClientRect().top
        - /** @type {HTMLElement} */ (selectedEl).getBoundingClientRect().top;
    }

    assert(overhang > BAND_PX,
      `test setup: the auto-selected row should sit well above the viewport top, ` +
      `or there was nothing here to resist; overhang is ${overhang}px with the ` +
      `message grown to ${grownTo} sentences`);

    // --- The control: the reader's own selection still frames the row ---

    rootCol.selectItem(/** @type {string} */ (selectedId));
    assert(Math.abs(list.scrollTop) > 320,
      `a selection the reader made must still bring its item into view, but the ` +
      `view stayed ${Math.abs(list.scrollTop)}px from the end`);

    // --- Streaming growth inside the near-bottom band doesn't walk backwards ---

    list.scrollTo({ top: sign * 100, behavior: 'instant' });
    const bandStart = Math.abs(list.scrollTop);
    assert(bandStart > 4 && bandStart <= 320,
      `test setup: should be inside the near-bottom band but off the bottom, ` +
      `got ${bandStart}px from the end`);

    const tail = /** @type {any} */ (root.items[root.items.length - 1]);
    const tailEl = /** @type {HTMLElement|null} */ (
      list.querySelector(`[message-id="${tail.get('itemId')}"]`)
    );
    assert(!!tailEl, 'the last assistant message should have a row');
    const heightBefore = /** @type {HTMLElement} */ (tailEl).offsetHeight;

    // A streaming token: content grows inside an existing item, carrying no
    // array-level delta, which is the path _setupStreamingScrollObserver serves.
    doc.transact(() => {
      tail.set('content', `And here is what that produced: ${longText(grownTo * 2)}`);
    }, author);

    assert(/** @type {HTMLElement} */ (tailEl).offsetHeight > heightBefore,
      'test setup: the streaming update should have grown the tail row, or there ' +
      'is no drift for the anchor to (wrongly) correct');
    assert(Math.abs(list.scrollTop) <= bandStart + 4,
      `growth at the end must not push a reader inside the near-bottom band ` +
      `further from it, went ${bandStart} → ${Math.abs(list.scrollTop)}px from the end`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'auto-follow-holds-the-end:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
