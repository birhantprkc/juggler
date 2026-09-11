//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What one appended item costs the conversation's rendering pass, and that the
 * answer does not depend on how much history is already on screen.
 *
 * This is the question a wall-clock budget used to ask — "one send into a
 * 200-item conversation, under 2500ms" — and could not answer. A millisecond
 * count measures the machine, and this suite's machine runs four test suites at
 * once, so the budget failed under load and passed alone while the render path
 * stayed exactly the same. Worse, its stated reason had gone stale: it existed
 * because conversation-area was believed to rebuild every row on every update,
 * which it does not, so the number it defended was not measuring the thing its
 * comment named.
 *
 * The property actually worth defending is structural, and countable exactly.
 * The diff is keyed by `message-id` (conversation-area-rendering.js): a row that
 * is still in the item list is reused, patched in place, and moved only if it is
 * out of order. So appending one item must add one node, remove none, disturb no
 * existing row, and cost the same at 200 items of history as at 20. A rebuild
 * regression — the one the old budget was watching for — breaks all four of
 * those on any machine, at any speed, on the first run.
 * @module unit-tests/render-scaling-tests
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/user-message.js';
import '../../js/components/assistant-message.js';
import {
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
} from '../../js/components/conversation-area-rendering.js';

/** A history long enough that a per-item cost would be unmissable. */
const LONG_HISTORY = 200;
/** A short one, to compare against. Any per-item cost differs between the two. */
const SHORT_HISTORY = 20;

/**
 * A plain-object stand-in for a conversation item Y.Map — enough for the
 * rendering pass's `.get()` reads.
 * @param {Record<string, any>} fields - The item's fields
 * @returns {{get: (key: string) => any}} A Y.Map-shaped item
 */
function item(fields) {
  return { get: (key) => fields[key] };
}

/**
 * User/assistant pairs, the shape an ordinary transcript has.
 * @param {number} count - How many items
 * @returns {Array<{get: (key: string) => any}>} The items
 */
function history(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(i % 2 === 0
      ? item({ itemId: `ITEM_${i}`, type: 'user', content: `History message ${i}` })
      : item({ itemId: `ITEM_${i}`, type: 'assistant', content: `Response ${i}` }));
  }
  return items;
}

/**
 * Mount a message list with the trailing managed non-item the diff positions
 * against (the real thing is the conversation footer; any managed element does,
 * and this one needs no wiring).
 * @returns {{list: HTMLElement, render: (items: any[]) => void, teardown: () => void}} The mounted list and a render pass over it
 */
function mountList() {
  const list = document.createElement('div');
  const anchor = document.createElement('div');
  anchor.className = 'thread-result-final';
  list.appendChild(anchor);
  document.body.appendChild(list);

  return {
    list,
    render(items) {
      const currentElements = buildElementMap(list);
      removeDeletedElements(currentElements, identifyElementsToKeep(items, currentElements));
      positionElements(null, list, anchor, items, currentElements);
    },
    teardown() {
      list.remove();
    },
  };
}

/**
 * Render `count` items, then append one more, and report what the second pass
 * did to the list.
 *
 * Node counts come from a MutationObserver drained with `takeRecords()`, which
 * hands back what has already happened rather than waiting for anything — the
 * measurement is as synchronous as the render it measures. `childList` on the
 * list alone and not its subtree, so a row re-rendering its own insides is not
 * mistaken for the list rebuilding a row.
 * @param {number} count - Items of history before the append
 * @returns {{added: number, removed: number, rebuilt: string[], rows: number}} What the append cost
 */
function appendCost(count) {
  const { list, render, teardown } = mountList();
  try {
    const items = history(count);
    render(items);

    const before = buildElementMap(list);
    assert(before.size === count,
      `precondition: ${count} items must paint ${count} rows, got ${before.size}`);

    const observer = new MutationObserver(() => {});
    observer.observe(list, { childList: true });
    render([...items, item({ itemId: 'APPENDED', type: 'user', content: 'the new one' })]);
    const records = observer.takeRecords();
    observer.disconnect();

    let added = 0;
    let removed = 0;
    for (const record of records) {
      added += record.addedNodes.length;
      removed += record.removedNodes.length;
    }

    // A row counts as rebuilt when its id survives the pass but its node does
    // not — which is what a full rebuild produces and a diff never does.
    const after = buildElementMap(list);
    const rebuilt = [];
    for (const [id, element] of before) {
      if (after.get(id) !== element) rebuilt.push(id);
    }

    return { added, removed, rebuilt, rows: after.size };
  } finally {
    teardown();
  }
}

/**
 * Run render scaling tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => void} fn - Test case body
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  test('appending to a long conversation touches one row', () => {
    const cost = appendCost(LONG_HISTORY);

    assert(cost.rows === LONG_HISTORY + 1,
      `the appended item must be painted: ${cost.rows} rows, want ${LONG_HISTORY + 1}`);
    assert(cost.rebuilt.length === 0,
      `every existing row must survive as the same node; ${cost.rebuilt.length} were rebuilt (${cost.rebuilt.slice(0, 3).join(', ')}…)`);
    assert(cost.added === 1,
      `an append must add one node, added ${cost.added}`);
    assert(cost.removed === 0,
      `an append must remove nothing, removed ${cost.removed}`);
  });

  test('what an append costs does not grow with the history behind it', () => {
    const shortHistory = appendCost(SHORT_HISTORY);
    const longHistory = appendCost(LONG_HISTORY);

    // The comparison is the point: an absolute count could be argued down one
    // regression at a time, but a per-item cost cannot survive being asked for
    // the same number ten times the history apart.
    assert(longHistory.added === shortHistory.added,
      `an append added ${longHistory.added} nodes at ${LONG_HISTORY} items but ${shortHistory.added} at ${SHORT_HISTORY} — the cost is scaling with history`);
    assert(longHistory.removed === shortHistory.removed,
      `an append removed ${longHistory.removed} nodes at ${LONG_HISTORY} items but ${shortHistory.removed} at ${SHORT_HISTORY} — the cost is scaling with history`);
    assert(longHistory.rebuilt.length === shortHistory.rebuilt.length,
      `an append rebuilt ${longHistory.rebuilt.length} rows at ${LONG_HISTORY} items but ${shortHistory.rebuilt.length} at ${SHORT_HISTORY} — the cost is scaling with history`);
  });

  return { passed, failed, errors };
}
