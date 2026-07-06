//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread Nested Array Spike Test
 *
 * Tests both approaches for thread item storage in Yjs:
 *
 * APPROACH 1: True nested CRDT types (Y.Map with nested Y.Array)
 *   - Thread item is a Y.Map, nested items is a Y.Array inside it
 *   - Independent modification, per-property observers
 *   - items.get(i) returns Y.Map (not plain object)
 *
 * APPROACH 2: Named Y.Arrays on doc root
 *   - Thread item is a plain object with threadArrayKey string
 *   - Thread items stored in doc.getArray('thread:thread_1')
 *   - items.get(i) returns plain object (same as existing items)
 *
 * Also validates Go → JS cross-compatibility for both approaches.
 * @module unit-tests/thread-nested-array-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run thread nested array spike tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const Y = await import('../../js/vendor/yjs.mjs');

  // =========================================================================
  // APPROACH 1: True nested CRDT (Y.Map + Y.Array)
  // =========================================================================

  // Test 1: Y.Map thread with nested Y.Array — basic CRUD
  try {
    const doc = new Y.Doc();
    const items = doc.getArray('items');

    doc.transact(() => {
      const thread = new Y.Map();
      items.insert(0, [thread]);

      thread.set('type', 'thread');
      thread.set('itemId', 'thread_1');
      thread.set('goal', 'Test thread');

      const nestedItems = new Y.Array();
      thread.set('items', nestedItems);

      nestedItems.insert(0, [{
        type: 'user',
        content: 'Hello from thread',
        itemId: 'thread_msg_1'
      }]);
    });

    assert(items.length === 1, 'Should have 1 item');

    const thread = items.get(0);
    assert(thread instanceof Y.Map, `Thread should be Y.Map, got ${thread?.constructor?.name}`);
    assert(thread.get('type') === 'thread', 'type should be thread');
    assert(thread.get('goal') === 'Test thread', 'goal mismatch');

    const nestedItems = thread.get('items');
    assert(nestedItems instanceof Y.Array, `Nested items should be Y.Array, got ${nestedItems?.constructor?.name}`);
    assert(nestedItems.length === 1, 'Nested should have 1 item');
    assert(nestedItems.get(0).content === 'Hello from thread', 'Nested content mismatch');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`CRDT basic: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: Y.Map thread — independent modification + observers
  try {
    const doc = new Y.Doc();
    const items = doc.getArray('items');
    const thread = new Y.Map();
    const nestedItems = new Y.Array();

    doc.transact(() => {
      items.insert(0, [thread]);
      thread.set('type', 'thread');

      thread.set('items', nestedItems);
      nestedItems.insert(0, [{ type: 'user', content: 'msg1' }]);
    });

    // Observer on nested array
    let arrayObserverFired = false;
    nestedItems.observe(() => { arrayObserverFired = true; });

    // Observer on thread map
    let mapObserverFired = false;
    thread.observe(() => { mapObserverFired = true; });

    // Modify nested array WITHOUT touching parent
    doc.transact(() => {
      nestedItems.insert(nestedItems.length, [{ type: 'assistant', content: 'msg2' }]);
    });

    assert(nestedItems.length === 2, 'Should have 2 nested items');
    assert(arrayObserverFired, 'Array observer should fire');
    // Map observer should NOT fire for nested array changes
    // (This is a Yjs feature — deep observers are separate)

    // Modify map property
    mapObserverFired = false;
    doc.transact(() => {
      thread.set('result', 'Done');
    });
    assert(thread.get('result') === 'Done', 'Result should update');
    assert(mapObserverFired, 'Map observer should fire for property change');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`CRDT observers: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: Y.Map thread — sync roundtrip
  try {
    const doc1 = new Y.Doc();
    const items1 = doc1.getArray('items');
    const threadForSync = new Y.Map();
    const nestedItemsForSync = new Y.Array();

    doc1.transact(() => {
      items1.insert(0, [threadForSync]);
      threadForSync.set('type', 'thread');
      threadForSync.set('itemId', 'thread_sync');

      threadForSync.set('items', nestedItemsForSync);
      nestedItemsForSync.insert(0, [
        { type: 'user', content: 'Message 1' },
        { type: 'assistant', content: 'Message 2' }
      ]);
    });

    // Encode and apply to new doc
    const update = Y.encodeStateAsUpdate(doc1);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    const items2 = doc2.getArray('items');
    assert(items2.length === 1, 'Synced should have 1 item');

    const thread2 = items2.get(0);
    assert(thread2 instanceof Y.Map, 'Synced thread should be Y.Map');
    assert(thread2.get('type') === 'thread', 'Synced type');

    const nestedItems2 = thread2.get('items');
    assert(nestedItems2 instanceof Y.Array, 'Synced nested should be Y.Array');
    assert(nestedItems2.length === 2, 'Synced nested length');
    assert(nestedItems2.get(0).content === 'Message 1', 'Synced msg 1');
    assert(nestedItems2.get(1).content === 'Message 2', 'Synced msg 2');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`CRDT sync: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Y.Map thread — live bidirectional sync
  try {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Bidirectional sync
    doc1.on('update', (/** @type {Uint8Array} */ update) => {
      Y.applyUpdate(doc2, update);
    });
    doc2.on('update', (/** @type {Uint8Array} */ update) => {
      Y.applyUpdate(doc1, update);
    });

    const liveThread = new Y.Map();
    const liveNested = new Y.Array();
    doc1.transact(() => {
      doc1.getArray('items').insert(0, [liveThread]);
      liveThread.set('type', 'thread');

      liveThread.set('items', liveNested);
      liveNested.insert(0, [{ type: 'user', content: 'Initial' }]);
    });

    // Verify doc2 synced
    const thread2 = doc2.getArray('items').get(0);
    assert(thread2 instanceof Y.Map, 'Doc2 thread is Y.Map');
    const nestedItems2 = thread2.get('items');
    assert(nestedItems2 instanceof Y.Array, 'Doc2 nested is Y.Array');
    assert(nestedItems2.length === 1, 'Doc2 has 1 item');

    // Observe doc2's nested items
    let remoteObserverFired = false;
    nestedItems2.observe(() => { remoteObserverFired = true; });

    // Add item in doc1
    doc1.transact(() => {
      liveNested.insert(liveNested.length, [{ type: 'assistant', content: 'Synced' }]);
    });

    assert(nestedItems2.length === 2, 'Doc2 should have 2 items after sync');
    assert(remoteObserverFired, 'Remote observer should fire');
    assert(nestedItems2.get(1).content === 'Synced', 'Synced content');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`CRDT live sync: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Y.Map thread — recursive nesting
  try {
    const doc = new Y.Doc();
    const items = doc.getArray('items');

    doc.transact(() => {
      const parentThread = new Y.Map();
      items.insert(0, [parentThread]);
      parentThread.set('type', 'thread');
      parentThread.set('itemId', 'parent');

      const parentItems = new Y.Array();
      parentThread.set('items', parentItems);

      parentItems.insert(0, [{ type: 'user', content: 'Start' }]);

      const childThread = new Y.Map();
      parentItems.insert(1, [childThread]);
      childThread.set('type', 'thread');
      childThread.set('itemId', 'child');

      const childItems = new Y.Array();
      childThread.set('items', childItems);
      childItems.insert(0, [{ type: 'user', content: 'Deep nested' }]);
    });

    // Walk the tree
    const parentThread = items.get(0);
    assert(parentThread instanceof Y.Map, 'Parent is Y.Map');

    const parentItems = parentThread.get('items');
    assert(parentItems.length === 2, 'Parent has 2 items');

    const childThread = parentItems.get(1);
    assert(childThread instanceof Y.Map, 'Child is Y.Map');

    const childItems = childThread.get('items');
    assert(childItems.length === 1, 'Child has 1 item');
    assert(childItems.get(0).content === 'Deep nested', 'Deep content');

    // Sync test
    const update = Y.encodeStateAsUpdate(doc);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    const pf2 = doc2.getArray('items').get(0);
    const ci2 = pf2.get('items').get(1).get('items');
    assert(ci2.length === 1, 'Synced child items');
    assert(ci2.get(0).content === 'Deep nested', 'Synced deep content');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`CRDT recursive: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Go cross-compatibility — decode Go-generated nested CRDT update
  try {
    // From TestThreadNestedCRDT in Go
    const GO_CRDT_UPDATE = 'AQmZw6mKBQAHAQVpdGVtcwEoAJnDqYoFAAR0eXBlAXcEZm9sZCgAmcOpigUABml0ZW1JZAF3BmZvbGRfMSgAmcOpigUABGdvYWwBdwlUZXN0IGZvbGQhAJnDqYoFAAZzdGF0dXMBJwCZw6mKBQAFaXRlbXMACACZw6mKBQUCdgMEdHlwZXcEdXNlcgdjb250ZW50dw9IZWxsbyBmcm9tIGZvbGQGaXRlbUlkdwpmb2xkX21zZ18xdgMHY29udGVudHcQUmVzcG9uc2UgaW4gZm9sZAZpdGVtSWR3CmZvbGRfbXNnXzIEdHlwZXcJYXNzaXN0YW50qJnDqYoFBAF3CWNvbXBsZXRlZCgAmcOpigUABnJlc3VsdAF3EVJlc2VhcmNoIGNvbXBsZXRlAZnDqYoFAQQB';

    const binaryString = atob(GO_CRDT_UPDATE);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);

    const items = doc.getArray('items');
    assert(items.length === 1, `Go CRDT: expected 1 item, got ${items.length}`);

    const thread = items.get(0);
    assert(thread instanceof Y.Map, `Go CRDT: thread should be Y.Map, got ${thread?.constructor?.name}`);
    assert(thread.get('type') === 'fold', `Go CRDT: type = ${thread.get('type')}`);
    assert(thread.get('itemId') === 'fold_1', `Go CRDT: itemId = ${thread.get('itemId')}`);
    assert(thread.get('goal') === 'Test fold', `Go CRDT: goal = ${thread.get('goal')}`);
    assert(thread.get('status') === 'completed', `Go CRDT: status = ${thread.get('status')}`);
    assert(thread.get('result') === 'Research complete', `Go CRDT: result = ${thread.get('result')}`);

    const nestedItems = thread.get('items');
    assert(nestedItems instanceof Y.Array, `Go CRDT: nested should be Y.Array, got ${nestedItems?.constructor?.name}`);
    assert(nestedItems.length === 2, `Go CRDT: expected 2 nested items, got ${nestedItems.length}`);
    assert(nestedItems.get(0).content === 'Hello from fold', 'Go CRDT: first nested msg');
    assert(nestedItems.get(1).content === 'Response in fold', 'Go CRDT: second nested msg');

    // Verify we can modify the Go-generated structure
    doc.transact(() => {
      nestedItems.insert(nestedItems.length, [{
        type: 'user', content: 'JS-added message'
      }]);
    });
    assert(nestedItems.length === 3, 'Should have 3 items after JS modification');

    // Verify map property update works
    doc.transact(() => {
      thread.set('result', 'Updated result');
    });
    assert(thread.get('result') === 'Updated result', 'Result update on Go-generated YMap');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`Go CRDT cross-compat: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // APPROACH 2: Named Y.Arrays (for comparison)
  // =========================================================================

  // Test 7: Named Y.Arrays — basic + observer + sync
  try {
    const doc = new Y.Doc();
    const items = doc.getArray('items');
    const threadArrayKey = 'thread:thread_named';

    doc.transact(() => {
      items.insert(0, [{
        type: 'thread',
        itemId: 'thread_named',
        goal: 'Named array test',
        threadArrayKey: threadArrayKey
      }]);
      const threadItems = doc.getArray(threadArrayKey);
      threadItems.insert(0, [{ type: 'user', content: 'Hello' }]);
    });

    const threadItems = doc.getArray(threadArrayKey);
    assert(threadItems.length === 1, 'Named: 1 item');

    let observerFired = false;
    threadItems.observe(() => { observerFired = true; });

    doc.transact(() => {
      threadItems.insert(threadItems.length, [{ type: 'assistant', content: 'Response' }]);
    });

    assert(threadItems.length === 2, 'Named: 2 items');
    assert(observerFired, 'Named: observer fired');

    // Sync
    const update = Y.encodeStateAsUpdate(doc);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);
    assert(doc2.getArray(threadArrayKey).length === 2, 'Named: sync works');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`Named arrays: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // buildThreadInitialItems: sub-thread seeding. A sub-thread is born with NO
  // built-in items (no SYSTEM_1) — its system prompt comes from the root thread
  // at LLM-call time. The helper is a pass-through of caller-supplied items.
  // =========================================================================

  try {
    const { buildThreadInitialItems } = await import('../../js/model/message-thread-context-items.js');

    const seeded = buildThreadInitialItems();
    assert(seeded.length === 0, `seeded: sub-thread must be born empty, got ${seeded.length} item(s)`);
    assert(!seeded.some((/** @type {any} */ it) => it.itemId === 'SYSTEM_1'),
      'seeded: sub-thread must not carry a SYSTEM_1 placeholder');

    // Caller-supplied initialItems pass through in order, with nothing prepended.
    const extra = { type: 'user', content: 'hi', itemId: 'u1' };
    const withExtra = buildThreadInitialItems({ initialItems: [extra] });
    assert(withExtra.length === 1, `withExtra: expected 1 item, got ${withExtra.length}`);
    assert(withExtra[0].itemId === 'u1', 'withExtra: caller item is first (nothing prepended)');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`buildThreadInitialItems: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
