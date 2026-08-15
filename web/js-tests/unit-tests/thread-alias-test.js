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
import { isAlias, canonicalThread, itemGoal, itemRunRecord, threadRunRecords }
  from '../../js/model/thread-alias.js';
import { getThreadDisplayContent, getThreadStatus } from '../../js/utils/thread-display.js';

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
    const live = { message: 'Streaming…', threadId: 'T1' };
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

  return { passed, failed, errors };
}
