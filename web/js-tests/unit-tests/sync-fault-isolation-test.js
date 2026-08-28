//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Sync fault isolation tests.
 *
 * Applying a batch runs the whole UI fan-out synchronously inside
 * Y.applyUpdate, so any component that throws while rendering throws from
 * inside DocumentSyncManager's batch timer. If that exception escapes, the
 * conversation's inbound stream dies while its outbound half keeps working —
 * the document goes on accepting messages and never shows an answer — and
 * because the fan-out is per-document exactly one conversation strands while
 * every other one in the same client stays healthy.
 *
 * These tests pin the isolation: a throwing observer does not escape, does not
 * stop later updates, and is reported rather than swallowed.
 * @module unit-tests/sync-fault-isolation-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory (not used by this test)
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run sync fault isolation tests.
 * @param {TestContext} _ctx - Test context (unused - this test doesn't need fixtures)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const Y = await import('../../js/vendor/yjs.mjs');
  const { default: DocumentSyncManager } = await import('../../js/utils/document-sync-manager.js');

  /**
   * Build a manager, a peer to generate real updates from, and a fault sink.
   * @returns {{doc: any, mgr: any, faults: any[], push: (text: string) => void}} The
   *   manager under test, its doc, the faults it reported, and a function that
   *   feeds it one real update and flushes the batch synchronously.
   */
  const makeManager = () => {
    const doc = new Y.Doc();
    const mgr = new DocumentSyncManager(doc);
    mgr.initializeAsClient();
    /** @type {any[]} */
    const faults = [];
    mgr.onSyncFault = (/** @type {any} */ fault) => { faults.push(fault); };
    const peer = new Y.Doc();
    /**
     * Write to the peer and hand the resulting update to the manager.
     * @param {string} text - Value to append to the peer's items array.
     */
    const push = (text) => {
      const before = Y.encodeStateVector(doc);
      peer.getArray('items').push([text]);
      mgr.applySyncUpdate(Y.encodeStateAsUpdate(peer, before));
      mgr.flushPendingUpdates();
    };
    return { doc, mgr, faults, push };
  };

  const run = (/** @type {string} */ name, /** @type {() => void|Promise<void>} */ fn) => {
    return Promise.resolve().then(fn).then(() => { passed++; }).catch((e) => {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  // The whole incident in one test: a render that throws must not take the
  // conversation's inbound stream with it.
  await run('a throwing observer does not escape and does not stop later updates', () => {
    const { doc, faults, push } = makeManager();
    let throwOnObserve = true;
    doc.getArray('items').observe(() => {
      if (throwOnObserve) throw new Error('render blew up');
    });

    // Escaping here is the bug: flushPendingUpdates would rethrow, and in
    // production this same throw escapes the batch timeout instead.
    push('first');
    assert(faults.length === 1, `expected one reported fault, got ${faults.length}`);
    assert(faults[0].phase === 'apply', `expected an apply fault, got ${faults[0].phase}`);
    assert(faults[0].consecutive === 1, `expected consecutive=1, got ${faults[0].consecutive}`);
    assert(!faults[0].unrecoverable, 'one bad render must not be called unrecoverable');

    // Yjs integrates the structs before it runs observers, so the document
    // holds the update even though the fan-out failed. Only the UI missed it.
    assert(doc.getArray('items').length === 1,
      `the document should still hold the applied update, got ${doc.getArray('items').length}`);

    // The pipeline has to survive: this is what a frozen conversation never did.
    throwOnObserve = false;
    push('second');
    assert(doc.getArray('items').length === 2,
      `later updates must still apply, got ${doc.getArray('items').length}`);
    assert(faults.length === 1, `a clean batch should report nothing, got ${faults.length}`);
  });

  await run('a clean batch clears the failure run', () => {
    const { doc, mgr, faults, push } = makeManager();
    let throwOnObserve = true;
    doc.getArray('items').observe(() => {
      if (throwOnObserve) throw new Error('render blew up');
    });

    push('a');
    push('b');
    assert(mgr._consecutiveFailures === 2,
      `expected two consecutive failures, got ${mgr._consecutiveFailures}`);

    throwOnObserve = false;
    push('c');
    assert(mgr._consecutiveFailures === 0,
      `a clean apply should reset the run, got ${mgr._consecutiveFailures}`);

    throwOnObserve = true;
    push('d');
    assert(faults[faults.length - 1].consecutive === 1,
      `the run should restart at 1, got ${faults[faults.length - 1].consecutive}`);
  });

  // A render that fails every time is not a glitch to ride out: the client can
  // no longer display this document by applying deltas to it, and whoever owns
  // the conversation needs to hear that rather than watch renders vanish.
  await run('a sustained run of failures is reported as unrecoverable', () => {
    const { doc, faults, push } = makeManager();
    doc.getArray('items').observe(() => { throw new Error('render blew up'); });

    push('a');
    push('b');
    assert(!faults[1].unrecoverable, 'two failures should not yet be unrecoverable');
    push('c');
    assert(faults[2].unrecoverable,
      'a third consecutive failure should be reported as unrecoverable');
    assert(faults[2].consecutive === 3, `expected consecutive=3, got ${faults[2].consecutive}`);
  });

  // Containment at the observer is what keeps one component's render bug from
  // blanking components that have nothing to do with it: Yjs runs the observers
  // for a transaction in turn, and an exception from one abandons the rest.
  await run('a guarded observer does not starve the observers behind it', async () => {
    const { guarded } = await import('../../js/utils/fault-report.js');
    const doc = new Y.Doc();
    const items = doc.getArray('items');
    let secondRan = 0;

    items.observe(guarded('test:throwing', () => { throw new Error('render blew up'); }));
    items.observe(() => { secondRan++; });

    const peer = new Y.Doc();
    peer.getArray('items').push(['x']);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));

    assert(secondRan === 1,
      `the observer behind a failing one should still run, ran ${secondRan} times`);
    assert(items.length === 1, `the document should hold the update, got ${items.length}`);
  });

  // The reporter runs on the failure path, so a broken one would turn a
  // recoverable render fault into the very escape this class exists to stop.
  await run('a throwing fault reporter does not escape either', () => {
    const { doc, mgr } = makeManager();
    mgr.onSyncFault = () => { throw new Error('reporter blew up'); };
    doc.getArray('items').observe(() => { throw new Error('render blew up'); });

    const peer = new Y.Doc();
    peer.getArray('items').push(['x']);
    mgr.applySyncUpdate(Y.encodeStateAsUpdate(peer));
    mgr.flushPendingUpdates();

    assert(mgr._consecutiveFailures === 1,
      `the failure should still be counted, got ${mgr._consecutiveFailures}`);
  });

  // The sink is what carries a viewer fault off this page. Nothing else can:
  // the window's console cannot be opened in a release build.
  await run('faults reach the sink named, with their stack', async () => {
    const { setFaultSink, reportFault, guarded } = await import('../../js/utils/fault-report.js');
    /** @type {any[]} */
    const sent = [];
    setFaultSink((/** @type {any} */ fault) => { sent.push(fault); });
    try {
      reportFault('test:direct', new Error('direct boom'), { convId: 'conv_x' });
      assert(sent.length === 1, `expected one report, got ${sent.length}`);
      assert(sent[0].source === 'test:direct', `wrong source: ${sent[0].source}`);
      assert(sent[0].message === 'direct boom', `wrong message: ${sent[0].message}`);
      assert(typeof sent[0].stack === 'string' && sent[0].stack.length > 0,
        'a thrown Error should report a stack');
      assert(sent[0].detail?.convId === 'conv_x',
        `the conversation id should ride along, got ${sent[0].detail?.convId}`);

      // guarded swallows and reports rather than rethrowing, and yields
      // undefined so a caller reading a return value sees nothing rather than
      // a half-built result.
      const result = guarded('test:wrapped', () => { throw new Error('wrapped boom'); })();
      assert(result === undefined, 'a guarded callback that throws should yield undefined');
      assert(sent.length === 2, `expected a second report, got ${sent.length}`);
      assert(sent[1].source === 'test:wrapped', `wrong source: ${sent[1].source}`);
    } finally {
      setFaultSink(null);
    }
  });

  return { passed, failed, errors };
}
