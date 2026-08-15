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
 * of content. But each tile carries its own result, frozen at the moment its own
 * run settled, so five calls into one session read as five results down the
 * parent transcript rather than one tile whose text keeps being overwritten.
 *
 * An alias and its canonical are always siblings: a session is scoped to the
 * thread that called it, so a resume can only be issued from the array the
 * thread already sits in. Mirrors worker/run_records.go (resolveAliasTarget,
 * runByToolUseID, itemRunSettled).
 */

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
 * The record of the one run THIS item stands for, read off the transcript
 * wherever it now is. Null for an item with no run selector — a user- or
 * strategy-created thread, a fold, every document written before aliases — and
 * for a selector naming a run the transcript no longer holds.
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
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || run.toolUseId !== selector) continue;
    return { status: run.status, result: run.result, call: i + 1 };
  }
  return null;
}
