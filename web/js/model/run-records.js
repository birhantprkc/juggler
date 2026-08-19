//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Run records.
 *
 * A thread is a sequence of RUNS over one accumulating transcript: a run is one
 * message appended to the thread, the tool loop that message drives, and the
 * rest at the end of it. The message that starts a run carries that run's
 * record — `runStatus`/`runResult` once it settles — and that record, not the
 * thread's `result`, is what tells a parked caller the run is over. (`result`
 * is the thread's current summary; it outlives the run that wrote it.)
 *
 * The worker settles the runs it drives. This covers the one case it cannot: a
 * stop that reaches a thread the worker is not driving — a child spawned but
 * never dispatched — which would otherwise leave its caller waiting for a run
 * that is never going to happen.
 *
 * Pure Y.Map/Y.Array walking; callers wrap the write in their own transaction.
 */

import { plainToYMap } from './item-accessor.js';

/**
 * Run status for a cancelled or interrupted run. Matches the Go spelling
 * (worker/run_records.go); the two writers must agree.
 * @type {string}
 */
export const RUN_STATUS_CANCELLED = 'cancelled';

/**
 * What a cancelled run reports to whoever called it.
 * @type {string}
 */
export const RUN_CANCELLED_NOTE = '[The run was cancelled before it finished.]';

/**
 * The messages of a thread's current run — the user items standing after the
 * last run to settle. Empty when that run has already settled, or the thread has
 * no message to stamp.
 *
 * A run is usually one message, but a human can type into a thread while its run
 * is in flight and the loop absorbs that message into the same run. The outcome
 * goes on all of them: the invocation message carries the tool-use coordinates
 * the caller's `tool_result` is paired by, and the trailing message is where
 * threadRunSettled asks whether the thread is still working. Mirrors
 * openRunMessagesLocked in worker/run_records.go.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {any[]} The open run's item Y.Maps, newest first.
 */
function openRunMessages(threadYMap) {
  const items = threadYMap?.get?.('items');
  if (!items || typeof items.toArray !== 'function') return [];
  const arr = items.toArray();
  const open = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function') continue;
    if (item.get('type') !== 'user') continue;
    if (item.get('runStatus')) break;
    open.push(item);
  }
  return open;
}

/**
 * Whether a thread's most recent run has settled — the "is this child
 * finished?" question, asked of the run rather than of `result`, which is the
 * thread's summary and outlives the run that wrote it. A thread whose
 * transcript records no run at all answers from `result` instead: a thread
 * summarised from the footer, and every document written before run records
 * existed, record completion only there.
 *
 * A compaction fold answers from `result` too: it is not a run but a container
 * of folded transcript, so run records found inside one belong to whatever it
 * swallowed, not to it. Mirrors threadRunSettled in worker/run_records.go.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {boolean} True when the thread's latest run is over.
 */
export function threadRunSettled(threadYMap) {
  if (threadYMap?.get?.('boundedCompaction') !== true) {
    const items = threadYMap?.get?.('items');
    const arr = items && typeof items.toArray === 'function' ? items.toArray() : [];
    let settled = false;
    let hasRuns = false;
    let seenStarter = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (typeof item?.get !== 'function') continue;
      const status = item.get('runStatus');
      // Only user items carry run records. A nested thread item carries the same
      // coordinates to name its own run (model/thread-alias.js), and counting
      // one would answer this thread's liveness with a question about a child's.
      if (item.get('type') === 'user' && (status || item.get('runToolUseId'))) hasRuns = true;
      if (!seenStarter && item.get('type') === 'user') {
        seenStarter = true;
        settled = !!status;
      }
      if (hasRuns && seenStarter) break;
    }
    if (hasRuns) return settled;
  }
  const result = threadYMap?.get?.('result');
  return typeof result === 'string' && result.length > 0;
}

/**
 * A run's trailing assistant text — what a cancelled run hands back alongside
 * the reason. Yields the content ONLY when the last item that encodes a state
 * transition is a non-empty assistant message; any trailing tool-action,
 * meta-tool-result, user or thread item means the run had no clean reply to
 * return. Mirrors selectThreadFallbackResult in worker/thread_reducer.go, whose
 * `effectiveItems` filter this list of types is.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {string} The trailing reply, or ''.
 */
function trailingReply(threadYMap) {
  const items = threadYMap?.get?.('items');
  if (!items || typeof items.toArray !== 'function') return '';
  const arr = items.toArray();
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function') continue;
    const type = item.get('type');
    if (type === 'assistant') return item.get('content') || '';
    if (type === 'user' || type === 'tool-action' || type === 'meta-tool-result' || type === 'thread') {
      return '';
    }
  }
  return '';
}

/**
 * Settle a thread's open run as cancelled, so nothing parked on it keeps
 * waiting. No-op when that run has already settled — the worker settles the run
 * it was driving itself, and it gets there first.
 *
 * What the run produced before it was stopped goes back with the reason
 * appended, exactly as the worker's own cancelled path composes it: a stopped
 * run that had already answered is worth more to its caller than the bare note.
 *
 * Writes no summary: the thread's own transcript shows what happened, and
 * passing a stop off as the thread's result would be a lie the tile repeats.
 * @param {any} threadYMap - The thread Y.Map.
 * @param {() => string} [mintItemId] - Mints an itemId, for the receipt this may
 *   have to append (see reportRunToParent). Omit only where the caller knows the
 *   thread has no parent item to report to.
 * @returns {boolean} True when a run was settled.
 */
export function settleRunCancelled(threadYMap, mintItemId) {
  const open = openRunMessages(threadYMap);
  if (!open.length) return false;
  const produced = trailingReply(threadYMap);
  const result = produced ? `${produced}\n\n${RUN_CANCELLED_NOTE}` : RUN_CANCELLED_NOTE;
  for (const item of open) {
    item.set('runStatus', RUN_STATUS_CANCELLED);
    item.set('runResult', result);
  }
  // openRunMessages walks backwards, so the last entry started this run.
  const starter = open[open.length - 1];
  if (mintItemId) {
    reportRunToParent(threadYMap, starter.get('itemId'), starter.get('runToolUseId') || '', mintItemId);
  }
  return true;
}

/**
 * Give a settling run somewhere in the parent to report to, when the item that
 * would otherwise report it has already answered the model.
 *
 * The parent's last item referring to this thread is its live view, and absorbs
 * a run nobody called for as long as its own result is still unsent — nothing
 * has been read, so nothing moves. Once that item's result has gone to the model
 * (`runResultFed`) it is committed history: rewriting it would slide every
 * message after it and cold-start a stateful provider. So a further run is
 * appended as a RECEIPT of its own instead, selecting the run by the message
 * that started it. An unread receipt is re-pointed rather than joined by
 * another, so a child prompted six times leaves the parent one item to read.
 *
 * Mirrors reportRunToParentLocked in worker/run_records.go. The worker does this
 * for every run it drives; this covers the runs it does not — a stop that
 * settles a thread the worker is not driving.
 * @param {any} threadYMap - The canonical thread Y.Map, whose run just settled.
 * @param {string} starterItemId - The itemId of the message that started it.
 * @param {string} starterCall - The tool-use id that message was called by, or ''.
 * @param {() => string} mintItemId - Mints the receipt's itemId.
 * @returns {void}
 */
export function reportRunToParent(threadYMap, starterItemId, starterCall, mintItemId) {
  const siblings = threadYMap?.parent;
  const canonicalId = threadYMap?.get?.('itemId');
  if (!starterItemId || !canonicalId || typeof siblings?.insert !== 'function') return;

  const arr = typeof siblings.toArray === 'function' ? siblings.toArray() : [];
  let trailing = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (typeof item?.get !== 'function' || item.get('type') !== 'thread') continue;
    const id = item.get('itemId');
    if (id !== canonicalId && item.get('aliasOf') !== canonicalId) continue;
    trailing = item;
    break;
  }
  if (!trailing) return;

  const selector = trailing.get('runToolUseId') || '';
  const runItemId = trailing.get('runItemId');
  // A thread item with no run selector answers no call — a user- or
  // strategy-created thread — so it has no committed pair to protect.
  if (!selector && !runItemId) return;
  if (runItemId === starterItemId) return;

  if (!trailing.get('runResultFed')) {
    // Still unread, so this item absorbs the run — and now says which one, so
    // the absorption survives being read (see itemRunRecord). A call whose OWN
    // run this is needs no such note.
    if (runItemId || starterCall !== selector) trailing.set('runItemId', starterItemId);
    return;
  }
  siblings.insert(siblings.length, [plainToYMap({
    type: 'thread',
    itemId: mintItemId(),
    timestamp: new Date().toISOString(),
    aliasOf: canonicalId,
    goal: threadYMap.get('goal') || '',
    sessionName: threadYMap.get('sessionName') || '',
    runItemId: starterItemId
  })]);
}
