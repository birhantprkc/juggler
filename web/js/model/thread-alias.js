//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread aliases.
 *
 * A thread a tool calls more than once gets ONE PARENT ITEM PER CALL. The first
 * call inserts the thread itself — the canonical item, which owns the
 * transcript. Every later call inserts an ALIAS: a thread item carrying no
 * transcript of its own, pointing at the canonical with `aliasOf`, and stamped
 * with a RUN SELECTOR (`runToolUseId`) naming the single run it stands for.
 *
 * Selecting either tile opens the same column — they are two views of one body
 * of content. But each tile carries a single run's result, so five calls into
 * one session read as five results down the parent transcript rather than one
 * tile whose text keeps being overwritten.
 *
 * WHICH run depends on where the item stands. The LAST item referring to a
 * session is its live view: it shows the run the transcript is on now, whoever
 * started it — including a run a human started by typing into a stopped child,
 * which no call named and which nothing else in the parent stands for. Every
 * earlier item is a receipt for the one call it was made by, frozen where that
 * run settled, so a later result can never rewrite a tile further up.
 *
 * An alias and its canonical are always siblings: a session is scoped to the
 * thread that called it, so a resume can only be issued from the array the
 * thread already sits in. Mirrors worker/run_records.go (resolveAliasTarget,
 * runByToolUseID, itemRunSettled).
 */

import { threadRunSettled } from './run-records.js';

/**
 * Read a Y.Array, plain array, or nullish as a plain array.
 * @param {any} value - A Y.Array, plain array, or nothing.
 * @returns {Array<any>} The items, or an empty array.
 */
function asArray(value) {
  if (!value) return [];
  if (typeof value.toArray === 'function') return value.toArray();
  return Array.isArray(value) ? value : [];
}

/**
 * Whether this item is an alias: a second view of a thread standing elsewhere in
 * the same array.
 * @param {any} itemYMap - The item Y.Map.
 * @returns {boolean} True for an alias item.
 */
export function isAlias(itemYMap) {
  return !!itemYMap?.get?.('aliasOf');
}

/**
 * The canonical thread an alias names, from the array it stands in. Defaults to
 * the item's own containing Y.Array, which is that array by definition.
 * @param {any} itemYMap - The alias item Y.Map.
 * @param {any} [siblingArray] - The array the item stands in (Y.Array or array).
 * @returns {any|null} The canonical thread Y.Map, or null when it is gone.
 */
export function resolveAliasTarget(itemYMap, siblingArray) {
  const targetId = itemYMap?.get?.('aliasOf');
  if (!targetId) return null;
  for (const item of asArray(siblingArray || itemYMap?.parent)) {
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') !== 'thread' || item.get('aliasOf')) continue;
    if (item.get('itemId') === targetId) return item;
  }
  return null;
}

/**
 * Whether this item is the LAST of the parent's items referring to a session —
 * the canonical and its aliases are the whole set, and they always stand in one
 * array.
 *
 * That item is the session's live view: it shows the run the transcript is on
 * now, whoever started it. Every earlier item is a receipt for the one call it
 * was made by. Mirrors isTrailingViewOf in worker/run_records.go.
 * @param {any} itemYMap - The item Y.Map (canonical or alias).
 * @param {any} canonical - The canonical thread Y.Map it refers to.
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {boolean} True when no later item refers to the same session.
 */
function isTrailingViewOf(itemYMap, canonical, siblingArray) {
  const canonicalId = canonical?.get?.('itemId');
  if (!canonicalId) return false;
  const siblings = asArray(siblingArray || itemYMap?.parent);
  for (let i = siblings.length - 1; i >= 0; i--) {
    const sibling = siblings[i];
    if (typeof sibling?.get !== 'function' || sibling.get('type') !== 'thread') continue;
    const id = sibling.get('itemId');
    if (id !== canonicalId && sibling.get('aliasOf') !== canonicalId) continue;
    return id === itemYMap?.get?.('itemId');
  }
  return false;
}

/**
 * The outcome of the run a thread's transcript is currently on, or null when it
 * records none. An empty status means that run is still going.
 *
 * Reads the LAST user item rather than the run's invocation message: the worker
 * stamps the same outcome onto every message the run gathered, so the trailing
 * one always carries it, and it is the item threadRunSettled asks about. It
 * requires no run selector, which is the point — a run a human started by typing
 * into the thread is recorded on a plain user message, so threadRunRecords does
 * not see it. Mirrors trailingRunOutcome in worker/run_records.go.
 * @param {any} threadYMap - The canonical thread Y.Map.
 * @returns {{status: string, result: string}|null} That run's outcome, or null.
 */
function trailingRunOutcome(threadYMap) {
  const items = asArray(threadYMap?.get?.('items'));
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (typeof item?.get !== 'function' || item.get('type') !== 'user') continue;
    return { status: item.get('runStatus') || '', result: item.get('runResult') || '' };
  }
  return null;
}

/**
 * The thread whose transcript this item shows: the canonical for an alias, the
 * item itself for anything else. Every subtree question — what is running, what
 * is awaiting approval, which column to open — is a question about that thread.
 * An alias whose canonical is gone resolves to itself, so callers still have a
 * Y.Map to read; it simply has no items.
 * @param {any} itemYMap - The item Y.Map.
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {any} The thread Y.Map holding the transcript.
 */
export function canonicalThread(itemYMap, siblingArray) {
  if (!isAlias(itemYMap)) return itemYMap;
  return resolveAliasTarget(itemYMap, siblingArray) || itemYMap;
}

/**
 * The `goal` a call's recorded tool input named, from a Y.Map or a plain object.
 * @param {any} input - A run's `runToolInput`.
 * @returns {string} The goal, or '' when the call named none.
 */
function goalOfToolInput(input) {
  const goal = typeof input?.get === 'function' ? input.get('goal') : input?.goal;
  return typeof goal === 'string' ? goal : '';
}

/**
 * A thread's run records, in transcript order: the invocation messages standing
 * in it, plus the records carried by a fold that swallowed some. Mirrors
 * threadRunRecords in worker/llm_request.go, including its exclusions — a fold
 * has no runs of its own, and a nested thread item's coordinates are its own run
 * selector, not a call into the thread holding it.
 * @param {any} threadYMap - The canonical thread Y.Map.
 * @returns {Array<{toolUseId: string, goal: string, status: string, result: string}>} The runs.
 */
export function threadRunRecords(threadYMap) {
  if (threadYMap?.get?.('boundedCompaction') === true) return [];
  /** @type {Array<{toolUseId: string, goal: string, status: string, result: string}>} */
  const runs = [];
  const add = (/** @type {any} */ read) => {
    const toolUseId = read('runToolUseId');
    const input = read('runToolInput');
    if (!toolUseId || !read('runToolName') || input === null || input === undefined) return;
    runs.push({
      toolUseId,
      goal: goalOfToolInput(input),
      status: read('runStatus') || '',
      result: read('runResult') || ''
    });
  };
  for (const item of asArray(threadYMap?.get?.('items'))) {
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') === 'thread') {
      if (item.get('boundedCompaction') === true) {
        for (const folded of asArray(item.get('foldedRuns'))) {
          add((/** @type {string} */ key) => (
            typeof folded?.get === 'function' ? folded.get(key) : folded?.[key]
          ));
        }
      }
      continue;
    }
    add((/** @type {string} */ key) => item.get(key));
  }
  return runs;
}

/**
 * The goal THIS item stands for: the one its own call named.
 *
 * A thread's `goal` field is the session's header — it moves with the latest
 * call, so it describes the session as it stands rather than the call any one
 * tile was made by. Each call's own goal is already on the item that stands for
 * it, inside the run selector's tool input, stamped when the call was made and
 * never rewritten. Reading it from there is what lets five calls into one
 * session read as five intentions down the parent transcript.
 *
 * Falls back to the item's `goal` field, then to the canonical's: a
 * user-created thread, a fold, and every document written before run selectors
 * carry their goal only there.
 * @param {any} itemYMap - The thread item Y.Map (canonical or alias).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {string} The goal to display for this item ('' when it has none).
 */
export function itemGoal(itemYMap, siblingArray) {
  if (itemYMap?.get?.('runToolUseId')) {
    const goal = goalOfToolInput(itemYMap.get('runToolInput'));
    if (goal) return goal;
  }
  return itemYMap?.get?.('goal') || canonicalThread(itemYMap, siblingArray)?.get?.('goal') || '';
}

/**
 * @typedef {object} ItemRunRecord
 * @property {string} status - How the run settled ('' while it is still going).
 * @property {string} result - What it returned ('' while it is still going).
 * @property {number} call - Its 1-based call number in the thread.
 */

/**
 * The record of the run THIS item stands for, read off the transcript wherever
 * it now is. Null for an item with no run selector — a user- or
 * strategy-created thread, a fold, every document written before aliases — and
 * for a selector naming a run the transcript no longer holds.
 *
 * Which run that is depends on where the item stands. The LAST item referring to
 * a session is its live view and answers for the run the transcript is on now
 * (isTrailingViewOf); every earlier item answers for the one run its selector
 * names, frozen where that run settled. So a session resumed by a later call
 * reports to the item that call appended, and a session resumed by a human —
 * whose run no call named at all — reports to the item still waiting on it.
 * The live view borrows the OUTCOME only: its call number stays its own, because
 * it is still the parent's view of the call it made. Mirrors itemThreadRun in
 * worker/run_records.go.
 * @param {any} itemYMap - The thread item Y.Map (canonical or alias).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {ItemRunRecord|null} That run's record, or null.
 */
export function itemRunRecord(itemYMap, siblingArray) {
  const selector = itemYMap?.get?.('runToolUseId');
  if (!selector) return null;
  const canonical = isAlias(itemYMap) ? resolveAliasTarget(itemYMap, siblingArray) : itemYMap;
  if (!canonical) return null;
  const runs = threadRunRecords(canonical);
  let call = 0;
  let matched = null;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i]?.toolUseId === selector) {
      call = i + 1;
      matched = runs[i];
      break;
    }
  }
  if (isTrailingViewOf(itemYMap, canonical, siblingArray)) {
    const trailing = trailingRunOutcome(canonical);
    // A selector no record answers still stands for a call that was made, so it
    // is numbered after the ones that are recorded.
    if (trailing) return { ...trailing, call: call || runs.length + 1 };
  }
  if (!matched) return null;
  return { status: matched.status, result: matched.result, call };
}

/**
 * Whether the run THIS item stands for is over — the "is this child finished?"
 * question, asked of one item rather than of the thread.
 *
 * An item carrying a run selector answers for its own run, so a caller waits on
 * the call it made rather than on whatever the thread most recently did. A
 * selector that resolves to nothing is over: the thread was deleted, or the run's
 * record was edited away, and there is nothing left to wait for. The exception is
 * a thread recording no run at all, which is one mid-creation.
 *
 * An item with no selector — a user-, strategy- or orchestrator-created thread, a
 * fold, every document written before aliases — answers from the thread itself.
 * An ALIAS with no selector stands for no run and is over: it owns no transcript
 * and no summary, so asking the thread question of it would answer "still
 * working" for as long as it exists. Mirrors itemRunSettled in
 * worker/run_records.go.
 * @param {any} itemYMap - The item Y.Map (canonical, alias, or anything else).
 * @param {any} [siblingArray] - The array the item stands in.
 * @returns {boolean} True when this item's run is over.
 */
export function itemRunSettled(itemYMap, siblingArray) {
  if (itemYMap?.get?.('type') === 'thread' && itemYMap.get('runToolUseId')) {
    const record = itemRunRecord(itemYMap, siblingArray);
    if (record) return !!record.status;
    const canonical = isAlias(itemYMap) ? resolveAliasTarget(itemYMap, siblingArray) : itemYMap;
    if (!canonical) return true; // the alias names a thread that is gone
    if (threadRunRecords(canonical).length > 0) return true; // the selector names a run the transcript no longer holds
    return threadRunSettled(canonical);
  }
  if (isAlias(itemYMap)) return true; // an alias with no selector stands for no run
  return threadRunSettled(itemYMap);
}
