//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread aliases, browser side.
 *
 * A thread called more than once has one parent item per call: the thread
 * itself, then an alias per later call. Each item answers for the ONE run it
 * stands for, so what a tile says is frozen when that run settles and no later
 * call can rewrite it. These are the reads every surface depends on — the tile,
 * the properties panel, the context preview — and each has a Go twin
 * (worker/run_records.go) that must agree with it.
 * @module unit-tests/thread-alias-test
 */

import { assert } from '../utilities/test-helpers.js';
import { isAlias, canonicalThread, itemGoal, itemRunRecord, itemRunSettled, threadRunRecords,
  promoteThreadView } from '../../js/model/thread-alias.js';
import { getThreadDisplayContent, getThreadStatus, threadCostFigures } from '../../js/utils/thread-display.js';

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
   * @param {Record<string, any>} fields - Item fields.
   * @returns {any} a Y.Map shaped like a conversation item
   */
  const item = (fields) => {
    const m = new Y.Map();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    return m;
  };

  /**
   * Build a root array holding a thread with the given runs, plus one alias per
   * extra run — the shape a session called N times leaves in its parent. A run
   * naming a goal also moves the thread's own `goal`, exactly as resumeSession
   * does: that field is the column header, and it describes the session as it
   * stands.
   * @param {Array<{toolUseId: string, prompt: string, goal?: string, status: string, result: string}>} runs - The calls made.
   * @returns {{root: any, canonical: any, aliases: any[]}} The live document pieces.
   */
  const session = (runs) => {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const canonical = new Y.Map();
    /** @type {any[]} */
    const aliases = [];
    doc.transact(() => {
      root.insert(0, [canonical]);
      canonical.set('type', 'thread');
      canonical.set('itemId', 'T1');
      canonical.set('goal', 'Find the auth code');
      canonical.set('sessionName', 'hunt');
      canonical.set('result', runs[runs.length - 1]?.result || '');
      const nested = new Y.Array();
      canonical.set('items', nested);
      runs.forEach((run, i) => {
        const input = run.goal ? { goal: run.goal, prompt: run.prompt } : {};
        if (run.goal) canonical.set('goal', run.goal);
        nested.push([item({
          type: 'user', itemId: `inv-${i}`, content: run.prompt,
          runToolUseId: run.toolUseId, runToolName: 'create_thread', runToolInput: input,
          runStatus: run.status, runResult: run.result
        })]);
        if (i === 0) {
          canonical.set('runToolUseId', run.toolUseId);
          canonical.set('runToolName', 'create_thread');
          canonical.set('runToolInput', input);
          return;
        }
        const alias = item({
          type: 'thread', itemId: `A${i}`, aliasOf: 'T1',
          goal: run.goal || 'Find the auth code', sessionName: 'hunt',
          runToolUseId: run.toolUseId, runToolName: 'create_thread', runToolInput: input
        });
        aliases.push(alias);
        root.push([alias]);
      });
    });
    return { root, canonical, aliases };
  };

  // --- 1: an alias resolves to the thread it is a view of ---
  try {
    const { canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' }
    ]);
    assert(!isAlias(canonical), 'the thread itself is not an alias');
    assert(isAlias(aliases[0]), 'the second call inserted an alias');
    assert(canonicalThread(aliases[0]) === canonical,
      'an alias must resolve to the thread standing earlier in its own array');
    assert(canonicalThread(canonical) === canonical, 'a thread resolves to itself');
    assert(threadRunRecords(canonical).length === 2,
      'the transcript records both calls, in call order');
    passed++;
  } catch (e) { failed++; errors.push(`alias resolution: ${msg(e)}`); }

  // --- 2: each item answers for its own run, and only its own ---
  try {
    const { canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' }
    ]);
    const first = itemRunRecord(canonical);
    const second = itemRunRecord(aliases[0]);
    assert(first?.call === 1 && first?.result === 'Auth lives in auth.go.',
      `the thread tile keeps its own call's answer; got ${JSON.stringify(first)}`);
    assert(second?.call === 2 && second?.result === 'The server calls it.',
      `the alias carries its own call's answer; got ${JSON.stringify(second)}`);
    assert(getThreadDisplayContent(canonical).text === 'Auth lives in auth.go.',
      'the first tile must not be overwritten by a later call');
    assert(getThreadDisplayContent(aliases[0]).text === 'The server calls it.',
      'the second tile shows the run it stands for');
    passed++;
  } catch (e) { failed++; errors.push(`per-item results: ${msg(e)}`); }

  // --- 3: a settled tile stays settled while a later call runs ---
  // The live status names the thread, and every tile of it would otherwise
  // start spinning — reporting work its own call never asked for.
  try {
    const { canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: '', result: '' }
    ]);
    const live = { byThread: { 'T1': 'Streaming…' } };
    const settled = getThreadStatus(canonical, live);
    assert(settled.showSummary === true && settled.spinner === false,
      `a tile whose own run has settled shows its frozen summary; got ${JSON.stringify(settled)}`);
    const running = getThreadStatus(aliases[0], live);
    assert(running.kind === 'running' && running.spinner === true,
      `the tile whose run is in flight is the one that spins; got ${JSON.stringify(running)}`);
    assert(getThreadDisplayContent(aliases[0]).text === '',
      'a run still going has no result to show');
    passed++;
  } catch (e) { failed++; errors.push(`frozen tiles: ${msg(e)}`); }

  // --- 4: an orphaned alias reads as an alias with nothing behind it ---
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const orphan = item({
      type: 'thread', itemId: 'A9', aliasOf: 'gone',
      runToolUseId: 'tu-9', runToolName: 'create_thread', runToolInput: {}
    });
    doc.transact(() => { root.push([orphan]); });
    assert(canonicalThread(orphan) === orphan,
      'an alias whose thread is gone resolves to itself, so callers still have a Y.Map');
    assert(itemRunRecord(orphan) === null, 'and it can read no record');
    assert(getThreadDisplayContent(orphan).text === '', 'so it shows nothing');
    passed++;
  } catch (e) { failed++; errors.push(`orphaned alias: ${msg(e)}`); }

  // --- 5: each item names the goal its OWN call gave ---
  // The thread's `goal` is the column header and moves with the latest call, so
  // reading it on a tile would caption the first call with the last one's
  // intention. Every per-call surface reads the selector's input instead.
  try {
    const { canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', goal: 'Find the auth code', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', goal: 'Trace the callers', status: 'rest', result: 'The server calls it.' }
    ]);
    assert(canonical.get('goal') === 'Trace the callers',
      'the resume moved the thread header to the latest call, as the worker does');
    assert(itemGoal(canonical) === 'Find the auth code',
      `the first tile keeps the goal its own call named; got ${itemGoal(canonical)}`);
    assert(itemGoal(aliases[0]) === 'Trace the callers',
      `the second tile names its own call's goal; got ${itemGoal(aliases[0])}`);
    assert(getThreadStatus(canonical, null).goal === 'Find the auth code',
      'the tile status block shows that same per-call goal');

    const delegatedDoc = new Y.Doc();
    const delegatedItems = delegatedDoc.getArray('items');
    const explore = item({
      type: 'thread', itemId: 'E1', goal: 'Explore', runGoal: 'Map auth flow',
      runToolUseId: 'tu-e', runToolName: 'Explore', runToolInput: { task: 'A deliberately very long self-contained investigation of every auth path' }
    });
    const research = item({
      type: 'thread', itemId: 'R1', goal: 'Research', runGoal: 'Check v3 changes',
      runToolUseId: 'tu-r', runToolName: 'Research', runToolInput: { question: 'A deliberately very long question with versions, platforms, and constraints' }
    });
    delegatedDoc.transact(() => { delegatedItems.push([explore, research]); });
    assert(itemGoal(explore) === 'Map auth flow',
      'an Explore tile uses the resolved short run goal, not its detailed task');
    assert(itemGoal(research) === 'Check v3 changes',
      'a Research tile uses the resolved short run goal, not its detailed question');
    const legacyExplore = item({
      type: 'thread', itemId: 'E0', goal: 'Explore',
      runToolUseId: 'tu-old', runToolName: 'Explore', runToolInput: { task: 'A long legacy task' }
    });
    delegatedDoc.transact(() => { delegatedItems.push([legacyExplore]); });
    assert(itemGoal(legacyExplore) === 'Explore',
      'a legacy delegated thread falls back to its stored label, not its detailed task');
    passed++;
  } catch (e) { failed++; errors.push(`per-item goals: ${msg(e)}`); }

  // --- 6: an item with no run selector still has its own goal ---
  // A user-created thread, a fold, and every document written before the
  // coordinates were kept record their goal in the field and nowhere else.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const plain = item({ type: 'thread', itemId: 'T9', goal: 'Compacted conversation history' });
    doc.transact(() => { root.push([plain]); });
    assert(itemGoal(plain) === 'Compacted conversation history',
      `a thread with no selector reads its goal field; got ${itemGoal(plain)}`);
    passed++;
  } catch (e) { failed++; errors.push(`goal fallback: ${msg(e)}`); }

  // --- 7: the trailing item tracks the session, earlier items do not ---
  // A human can pick a stopped child back up, and the run that starts is one no
  // call named — recorded on a plain user message carrying no coordinates at
  // all. The last item referring to the session reports it, because nothing else
  // in the parent stands for that work; every earlier item stays the receipt for
  // the call it was made by.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'cancelled', result: '[The run was cancelled before it finished.]' }
    ]);
    const nested = canonical.get('items');
    nested.push([item({ type: 'user', itemId: 'human-1', content: 'keep going' })]);
    const resumed = nested.get(nested.length - 1);

    // While that run is in flight the tile follows the session back into work.
    const live = { byThread: { 'T1': 'Streaming…' } };
    const running = getThreadStatus(aliases[0], live, root);
    assert(running.kind === 'running' && running.spinner === true,
      `the item waiting on the session must follow it back into work; got ${JSON.stringify(running)}`);
    assert(getThreadStatus(canonical, live, root).showSummary === true,
      'the earlier call keeps showing its own answer while the session works');

    // And when it rests, that is what the call reports.
    resumed.set('runStatus', 'rest');
    resumed.set('runResult', 'The server calls it.');
    const record = itemRunRecord(aliases[0], root);
    assert(record?.result === 'The server calls it.',
      `the trailing item reports the session's current run; got ${JSON.stringify(record)}`);
    assert(record?.call === 2,
      `and stays the view of its own call; got call ${record?.call}`);
    assert(itemRunRecord(canonical, root)?.result === 'Auth lives in auth.go.',
      'the first call still answers with the run it started');
    assert(getThreadDisplayContent(aliases[0], root).text === 'The server calls it.',
      'and the tile shows the answer rather than the stop it has moved past');
    passed++;
  } catch (e) { failed++; errors.push(`resumed session: ${msg(e)}`); }

  // --- 8: Continue moves only the trailing session item ---
  // Continue has no user message of its own, so the worker appends a marker for
  // its run to be recorded on. Only the latest owner may follow the session into
  // that run.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'cancelled', result: '[The run was cancelled before it finished.]' }
    ]);
    const nested = canonical.get('items');
    nested.push([item({ type: 'user', itemId: 'cont-1', continuation: true })]);
    const latest = nested.get(nested.length - 1);

    const live = { byThread: { 'T1': 'Streaming…' } };
    const earlier = getThreadStatus(canonical, live, root);
    const running = getThreadStatus(aliases[0], live, root);
    assert(earlier.showSummary === true && earlier.spinner === false,
      `the earlier owner must remain frozen; got ${JSON.stringify(earlier)}`);
    assert(running.kind === 'running' && running.spinner === true,
      `the latest owner must show the restarted session; got ${JSON.stringify(running)}`);
    assert(itemRunSettled(canonical, root) === true,
      'the earlier owner remains settled');
    assert(itemRunSettled(aliases[0], root) === false,
      'the latest owner becomes open');
    assert(getThreadDisplayContent(aliases[0], root).text === '',
      'the cancellation is left behind while the continued run is active');
    assert(nested.get(1).get('runResult') === '[The run was cancelled before it finished.]',
      'the record the parent may already have read is untouched by the Continue');

    latest.set('runStatus', 'rest');
    latest.set('runResult', 'The router calls it.');
    assert(getThreadDisplayContent(canonical, root).text === 'Auth lives in auth.go.',
      'the earlier owner keeps its answer after the continuation settles');
    assert(getThreadDisplayContent(aliases[0], root).text === 'The router calls it.',
      'the latest owner shows the continued answer');
    passed++;
  } catch (e) { failed++; errors.push(`continued session: ${msg(e)}`); }

  // --- 8b: an item the model has read is frozen wherever it stands ---
  // The live view is a licence to absorb news the parent has not heard, never to
  // correct something it has. Once a result has gone to the model the item is
  // committed history: the run that follows gets a receipt of its own, and until
  // it settles the parent has no item standing for it at all.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' }
    ]);
    aliases[0].set('runResultFed', true);
    const nested = canonical.get('items');
    nested.push([item({ type: 'user', itemId: 'human-1', content: 'and the tests?' })]);

    assert(getThreadDisplayContent(aliases[0], root).text === 'The server calls it.',
      'a tile whose answer the model has read must not blank while the session works again');
    assert(itemRunSettled(aliases[0], root) === true,
      'and it must stay settled, or the parent parks on a run nobody asked it to wait for');

    nested.get(nested.length - 1).set('runStatus', 'rest');
    nested.get(nested.length - 1).set('runResult', 'Tests in auth_test.go.');
    assert(getThreadDisplayContent(aliases[0], root).text === 'The server calls it.',
      'and it still answers with its own run once the new one settles');
    passed++;
  } catch (e) { failed++; errors.push(`read item is frozen: ${msg(e)}`); }

  // --- 8b(ii): frozen is about the answer, not about the spinner ---
  // The item above may not have its result rewritten — the model has read it —
  // but the session it stands for can be picked back up, and while that run is in
  // flight this is the only tile the parent has for it: the receipt is appended
  // when the run SETTLES, so until then nothing else stands for the work. Frozen
  // on both counts left the tile showing the previous run's answer, with no
  // spinner, for the whole of the next run — indistinguishable from a session
  // sitting still.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'error', result: 'LLM error: the turn stopped.' }
    ]);
    aliases[0].set('runResultFed', true);
    const nested = canonical.get('items');
    nested.push([item({ type: 'user', itemId: 'cont-1', continuation: true })]);

    const live = { byThread: { 'T1': 'Streaming…' } };
    const running = getThreadStatus(aliases[0], live, root);
    assert(running.kind === 'running' && running.spinner === true,
      `a fed tile must still report the session working again; got ${JSON.stringify(running)}`);
    assert(getThreadDisplayContent(aliases[0], root).text === 'LLM error: the turn stopped.',
      'and the answer the model was given is untouched underneath');

    const earlier = getThreadStatus(canonical, live, root);
    assert(earlier.showSummary === true && earlier.spinner === false,
      `only the trailing view follows the session; got ${JSON.stringify(earlier)}`);
    passed++;
  } catch (e) { failed++; errors.push(`fed item still spins: ${msg(e)}`); }

  // --- 8c: a receipt reports the run nobody called ---
  // It selects that run by the message that started it, since there is no call to
  // name it by, and it is settled by construction: it is only ever appended for a
  // run that has already finished.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' }
    ]);
    aliases[0].set('runResultFed', true);
    const nested = canonical.get('items');
    nested.push([item({
      type: 'user', itemId: 'human-1', content: 'and the tests?',
      runStatus: 'rest', runResult: 'Tests in auth_test.go.'
    })]);
    const receipt = item({
      type: 'thread', itemId: 'R1', aliasOf: 'T1',
      goal: 'Find the auth code', sessionName: 'hunt', runItemId: 'human-1'
    });
    root.push([receipt]);

    const record = itemRunRecord(receipt, root);
    assert(record?.result === 'Tests in auth_test.go.',
      `a receipt reports the run it names; got ${JSON.stringify(record)}`);
    assert(record?.call === 3,
      `a run nobody called is numbered after the calls that were made; got call ${record?.call}`);
    assert(itemRunSettled(receipt, root) === true, 'a receipt is settled by construction');
    assert(getThreadDisplayContent(receipt, root).text === 'Tests in auth_test.go.',
      'and its tile shows that run');
    assert(canonicalThread(receipt, root) === canonical,
      'selecting it opens the thread it is a view of');

    const gone = item({ type: 'thread', itemId: 'R2', aliasOf: 'T1', runItemId: 'edited-away' });
    root.push([gone]);
    assert(itemRunRecord(gone, root) === null,
      'a receipt whose record has been edited away reads nothing rather than borrowing somebody else\'s');
    passed++;
  } catch (e) { failed++; errors.push(`receipt item: ${msg(e)}`); }

  // --- 9: an alias is not mistaken for a thread that never finishes ---
  // An alias owns no transcript and no summary, so the thread-level question
  // ("does it record a settled run, or carry a result?") answers "still working"
  // for as long as it stands there. Everything that asks whether a column is
  // busy walks these items — hasBusyItems, which decides whether Continue is
  // offered at all — so one resumed session would retire the button for good.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' }
    ]);
    assert(itemRunSettled(canonical, root) === true,
      'the thread whose runs have all settled is finished');
    assert(itemRunSettled(aliases[0], root) === true,
      'and so is the alias standing for the second of them');

    // The alias still reports the session honestly while it works.
    const nested = canonical.get('items');
    nested.push([item({ type: 'user', itemId: 'human-1', content: 'keep going' })]);
    assert(itemRunSettled(aliases[0], root) === false,
      'an alias whose session is working again reads as working');
    passed++;
  } catch (e) { failed++; errors.push(`alias settlement: ${msg(e)}`); }

  // --- 9: an alias with no run selector stands for no run ---
  // Its Go twin returns true here for the same reason: there is no run to wait
  // on, and answering from the thread it points at would report somebody else's.
  try {
    const doc = new Y.Doc();
    const root = doc.getArray('items');
    const orphan = item({ type: 'thread', itemId: 'A9', aliasOf: 'gone' });
    doc.transact(() => { root.push([orphan]); });
    assert(itemRunSettled(orphan, root) === true,
      'an alias carrying no selector has no run to wait on');
    passed++;
  } catch (e) { failed++; errors.push(`selectorless alias: ${msg(e)}`); }

  // --- 10: deleting a thread hands the transcript to the next view ---
  // Deleting one tile removes one tile. The thread's other views are separate
  // items the user did not touch, so they cannot go with it — but the transcript
  // has to survive somewhere, or they become tiles with nothing to show. The
  // oldest surviving view takes it on and stops being a view; the rest point at
  // it instead. Each keeps its OWN run selector, so every tile still answers for
  // the one call it was made by and the wire emits the same pairs it did before.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'who calls it?', status: 'rest', result: 'The server calls it.' },
      { toolUseId: 'tu-3', prompt: 'and the tests?', status: 'rest', result: 'Tests in auth_test.go.' }
    ]);
    canonical.set('resultSpec', 'a file list');

    const promoted = promoteThreadView(canonical, root);
    assert(promoted === aliases[0], 'the oldest surviving view takes the thread on');
    assert(!promoted.get('aliasOf'), 'a promoted view is the thread now, not a view of one');
    assert(promoted.get('items')?.length === 3,
      `the transcript moves with it; got ${promoted.get('items')?.length} items`);
    assert(promoted.get('resultSpec') === 'a file list',
      'and so does everything else the thread owned');
    assert(promoted.get('runToolUseId') === 'tu-2',
      'a promoted view keeps standing for the call it was made by');
    assert(threadRunRecords(promoted).length === 3,
      'the promoted thread records every call that was made into it');
    assert(aliases[1].get('aliasOf') === promoted.get('itemId'),
      'the views that remain point at it');
    assert(canonicalThread(aliases[1], root) === promoted,
      'so selecting one still opens the transcript');
    assert(itemRunRecord(aliases[1], root)?.result === 'Tests in auth_test.go.',
      'and each still reports its own run');

    // A thread nobody else views has nothing to hand on: it is simply deleted.
    const { root: soloRoot, canonical: solo } = session([
      { toolUseId: 'tu-1', prompt: 'where is auth?', status: 'rest', result: 'Auth lives in auth.go.' }
    ]);
    assert(promoteThreadView(solo, soloRoot) === null,
      'a thread nobody else views promotes nothing');
    passed++;
  } catch (e) { failed++; errors.push(`thread view promotion: ${msg(e)}`); }

  // --- the delegation economics a tile makes legible ---
  // A sub-thread does not inherit the parent transcript and hands back only its
  // final answer, so a child that reads 40k of files costs its caller a few
  // hundred tokens. Both figures are stamped on the thread at settle; an alias
  // reads them off the thread it is a view of, not off itself.
  try {
    const { root, canonical, aliases } = session([
      { toolUseId: 'tu-1', prompt: 'read them all', status: 'rest', result: 'Auth lives in auth.go.' },
      { toolUseId: 'tu-2', prompt: 'and again', status: 'rest', result: 'The server calls it.' }
    ]);
    assert(threadCostFigures(canonical) === null,
      'a thread that has recorded nothing shows no figures rather than zeroes');

    canonical.set('contextTokens', 41000);
    canonical.set('resultTokens', 700);
    const figures = threadCostFigures(canonical);
    assert(figures?.context === 41000 && figures?.returned === 700,
      `the tile reads both stamped figures; got ${JSON.stringify(figures)}`);
    assert(figures.text === '41k used · 700 returned',
      `the resting tile states the pair; got ${JSON.stringify(figures.text)}`);
    assert(figures.title.includes('41k') && figures.title.includes('700'),
      `the hover explains the pair; got ${JSON.stringify(figures.title)}`);

    assert(threadCostFigures(aliases[0], root)?.context === 41000,
      'an alias reports the figures of the thread it views');
    passed++;
  } catch (e) { failed++; errors.push(`thread cost figures: ${msg(e)}`); }

  return { passed, failed, errors };
}
