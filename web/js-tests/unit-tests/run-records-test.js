//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Browser-side run records.
 *
 * The worker settles the runs it drives; this module covers the one case it
 * cannot — a stop that reaches a thread the worker is not driving. Both halves
 * have a Go twin that must agree with them byte for byte, so both are pinned
 * here: which messages a settle stamps (openRunMessagesLocked) and what a
 * cancelled run hands back (resolveRunOutcome).
 *
 * The last case covers what the UI derives from the same record: the terminal
 * Result block belongs to the run that wrote the summary, so a thread running
 * again must not sit under one.
 * @module unit-tests/run-records-test
 */

import { assert } from '../utilities/test-helpers.js';
import { settleRunCancelled, threadRunSettled, RUN_CANCELLED_NOTE, RUN_STATUS_CANCELLED }
  from '../../js/model/run-records.js';
import { ensureThreadResult } from '../../js/components/conversation-area-rendering.js';

/**
 * @param {unknown} e
 * @returns {string} the message to surface for an assertion failure
 */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} the aggregate test result
 */
export async function runTests() {
  const Y = await import('../../js/vendor/yjs.mjs');
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {Record<string, any>} fields
   * @returns {any} a Y.Map shaped like a conversation item
   */
  const item = (fields) => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    return m;
  };
  /**
   * Build a thread Y.Map holding the given items, live in its own doc so the
   * shared types accept writes.
   * @param {any[]} children
   * @returns {any} the thread Y.Map
   */
  const thread = (children) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const m = new Y.Map();
    doc.transact(() => {
      root.insert(0, [m]);
      m.set('type', 'thread');
      m.set('itemId', 'T1');
      const arr = new Y.Array();
      m.set('items', arr);
      arr.insert(0, children);
    });
    return m;
  };

  // --- 1: a settle stamps every message the run gathered ---
  // A human can type into a child while its delegated run is in flight; the
  // message is promoted mid-run and absorbed into that same run. Both ends of
  // that run must carry the outcome: the invocation message because the caller's
  // tool_result is paired by the coordinates it holds, and the trailing message
  // because that is where liveness is read — stamp one and not the other and
  // the caller either reads the pending placeholder as its answer or parks on a
  // run that already ended.
  try {
    const invocation = item({
      type: 'user', itemId: 'inv-1', content: 'find the auth bug',
      runToolUseId: 'tu-1', runToolName: 'Explore'
    });
    const interjection = item({ type: 'user', itemId: 'human-1', content: 'check the tests too' });
    const t = thread([
      invocation,
      item({ type: 'assistant', itemId: 'a-1', content: 'Looking.' }),
      interjection
    ]);

    assert(threadRunSettled(t) === false, 'a run with no recorded outcome must read as running');
    assert(settleRunCancelled(t) === true, 'an open run must settle');
    assert(invocation.get('runStatus') === RUN_STATUS_CANCELLED,
      `the invocation message must carry the outcome; got ${invocation.get('runStatus')}`);
    assert(interjection.get('runStatus') === RUN_STATUS_CANCELLED,
      'the message the run absorbed carries the same outcome, so the thread reads as finished');
    assert(threadRunSettled(t) === true, 'the settled run must read as finished');
    passed++;
  } catch (e) { failed++; errors.push(`settle stamps the run: ${msg(e)}`); }

  // --- 2: a human-driven run settles on its own trailing message ---
  // No coordinates anywhere, so the trailing user item IS the starter. This is
  // the case that must keep working: a user-created thread records completion
  // nowhere else, so failing to settle would park its column forever.
  try {
    const start = item({ type: 'user', itemId: 'u-1', content: 'do work' });
    const t = thread([start, item({ type: 'assistant', itemId: 'a-1', content: 'Working.' })]);
    assert(settleRunCancelled(t) === true, 'a human-driven run must settle');
    assert(start.get('runStatus') === RUN_STATUS_CANCELLED, 'its trailing user item is its starter');

    // Settling twice is a no-op: the worker usually gets there first.
    assert(settleRunCancelled(t) === false, 'a settled run must not be re-stamped');
    passed++;
  } catch (e) { failed++; errors.push(`human-driven run settles: ${msg(e)}`); }

  // --- 3: a cancelled run hands back what it produced, plus the reason ---
  // Mirrors resolveRunOutcome(cancelled) in worker/run_records.go. A stop that
  // lands after the child has already answered is worth more to the caller than
  // the bare note, and the two writers must compose it identically.
  try {
    const start = item({ type: 'user', itemId: 'u-1', content: 'do work' });
    const t = thread([start, item({ type: 'assistant', itemId: 'a-1', content: 'Got partway.' })]);
    settleRunCancelled(t);
    assert(start.get('runResult') === `Got partway.\n\n${RUN_CANCELLED_NOTE}`,
      `a cancelled run must return its trailing reply then the reason; got ${JSON.stringify(start.get('runResult'))}`);

    // A run stopped mid-tool has no clean reply, so the note stands alone —
    // trailing plumbing is never passed off as an answer.
    const midTool = item({ type: 'user', itemId: 'u-2', content: 'do work' });
    const t2 = thread([
      midTool,
      item({ type: 'assistant', itemId: 'a-2', content: 'Reading files.' }),
      item({ type: 'tool-action', itemId: 't-2', toolUseId: 'tu-2', state: 'running' })
    ]);
    settleRunCancelled(t2);
    assert(midTool.get('runResult') === RUN_CANCELLED_NOTE,
      `a run with no clean trailing reply returns the note alone; got ${JSON.stringify(midTool.get('runResult'))}`);
    passed++;
  } catch (e) { failed++; errors.push(`cancelled run keeps its output: ${msg(e)}`); }

  // --- 3b: a stop that settles a run the parent has already read appends ---
  // The worker does this for the runs it drives; a stop reaching a thread it is
  // not driving must reach the same shape, or the two writers disagree about
  // where a run reports and the parent's committed answer gets rewritten by the
  // browser instead. Mirrors reportRunToParentLocked in worker/run_records.go.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const t = new Y.Map();
    const starter = item({ type: 'user', itemId: 'human-1', content: 'keep going' });
    doc.transact(() => {
      root.insert(0, [t]);
      t.set('type', 'thread');
      t.set('itemId', 'T1');
      t.set('goal', 'map auth');
      t.set('sessionName', 'hunt');
      t.set('runToolUseId', 'tu-1');
      t.set('runResultFed', true); // the parent has read this call's answer
      const arr = new Y.Array();
      t.set('items', arr);
      arr.insert(0, [
        item({
          type: 'user', itemId: 'inv-1', content: 'where is auth?',
          runToolUseId: 'tu-1', runToolName: 'Explore',
          runStatus: 'rest', runResult: 'Auth lives in auth.go.'
        }),
        starter
      ]);
    });

    let minted = 0;
    doc.transact(() => { settleRunCancelled(t, () => `msg-new-${++minted}`); });
    assert(t.get('runResultFed') === true && root.length === 2,
      `the read item must be left alone and a receipt appended; got ${root.length} items`);
    const receipt = root.get(1);
    assert(receipt.get('aliasOf') === 'T1' && receipt.get('runItemId') === 'human-1',
      `the receipt must select the run that just settled; got ${JSON.stringify(receipt.toJSON())}`);
    assert(receipt.get('sessionName') === 'hunt' && !receipt.get('runToolUseId'),
      'a receipt shows the session but claims no call');

    // A second stopped run, with that receipt still unread, follows it forward
    // rather than stacking another item.
    const again = item({ type: 'user', itemId: 'human-2', content: 'and the tests?' });
    doc.transact(() => {
      t.get('items').push([again]);
      settleRunCancelled(t, () => `msg-new-${++minted}`);
    });
    assert(root.length === 2 && root.get(1).get('runItemId') === 'human-2',
      `an unread receipt must follow the session forward; got ${root.length} items`);
    passed++;
  } catch (e) { failed++; errors.push(`browser settle reports to the parent: ${msg(e)}`); }

  // --- 4: the terminal Result block is a compaction fold's alone ---
  // A fold's transcript is folded away, so its summary stands nowhere else and
  // the block IS the column. Every other thread ends on the reply its last run
  // came to rest on and answers its caller through its run records, so it prints
  // no block whatever `result` happens to hold.
  try {
    /**
     * @param {any} t - The thread Y.Map to render for.
     * @returns {HTMLElement} The message list it was rendered into.
     */
    const render = (t) => {
      const messageList = document.createElement('div');
      const footer = document.createElement('conversation-footer');
      messageList.appendChild(footer);
      ensureThreadResult({ _threadYMap: t, _conversation: null }, messageList, footer);
      return messageList;
    };

    const rested = thread([
      item({ type: 'user', itemId: 'u-1', content: 'where is auth?' }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Auth lives in auth.go.' })
    ]);
    rested.set('result', 'Auth lives in auth.go.');
    assert(!render(rested).querySelector('.thread-result-final'),
      'a summary that IS the last message must not be printed again below it');

    // A summary the transcript no longer says — left by an earlier run, or
    // orphaned when the message it came from was edited — stays out of the
    // column too. The thread's tile still carries it.
    const stale = thread([
      item({ type: 'user', itemId: 'u-1', content: 'where is auth?' }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Cancelled before I got there.' })
    ]);
    stale.set('result', 'Auth lives in auth.go.');
    assert(!render(stale).querySelector('.thread-result-final'),
      'a summary the transcript has moved past is not printed under it');

    const delegated = thread([
      item({
        type: 'user', itemId: 'inv-1', content: 'where is auth?',
        runToolUseId: 'tu-1', runToolName: 'Explore', runToolInput: {},
        runStatus: 'rest', runResult: 'Auth lives in auth.go.'
      }),
      item({ type: 'assistant', itemId: 'a-1', content: 'Auth lives in auth.go.' })
    ]);
    delegated.set('result', 'Auth lives in auth.go.');
    assert(!render(delegated).querySelector('.thread-result-final'),
      'a thread that records runs answers its callers through them, not through a block');

    const fold = thread([
      item({ type: 'user', itemId: 'u-1', content: 'summarise this' })
    ]);
    fold.set('boundedCompaction', true);
    fold.set('result', 'What the folded transcript said.');
    const foldList = render(fold);
    assert(!!foldList.querySelector('.thread-result-final'),
      'a fold has nothing but its summary — the block IS the column');
    assert(!!foldList.querySelector('.thread-result-resummarise-btn'),
      'and it carries the only way to write that summary again');
    passed++;
  } catch (e) { failed++; errors.push(`Result block appears only where the summary is not: ${msg(e)}`); }

  return { passed, failed, errors };
}
