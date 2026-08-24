//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Turn-completion synchronization for the test harnesses: the per-test deadline
 * policy, wrapped around the model's own turn fence.
 *
 * What "the turn is over" means lives in `model/turn-completion.js`, which the
 * engine's unattended runs wait on too — one definition, so a harness and a
 * `juggler run` cannot disagree about whether a turn finished. What lives here
 * is the part that is only a test's business: how patient to be, and the
 * abort/deadline wiring the runner drives it with.
 * @module test/utilities/turn-sync
 */

import { inspectTurn, observeUntil as observeUntilTerminal, scanToolStates } from '../../js/model/turn-completion.js';

export { scanToolStates };

/**
 * Recursively walk items (including thread nested arrays) looking for a match.
 * @param {any[]} items - Items to search
 * @param {(item: any) => boolean} predicate - Return true to match
 * @returns {boolean} True if predicate matched any item
 */
export function findItemRecursive(items, predicate) {
  if (!items) return false;
  for (const item of items) {
    if (predicate(item)) return true;
    if (item.get('type') === 'thread') {
      const nested = item.get('items');
      if (nested) {
        const nestedItems = nested.toArray ? nested.toArray() : [];
        if (findItemRecursive(nestedItems, predicate)) return true;
      }
    }
  }
  return false;
}

/**
 * True if any tool-action is blocked on user approval (recursively). Thin view
 * over scanToolStates, the single source of the tool-state predicates.
 * @param {any[]} items - Items to search
 * @returns {boolean} True if any tool-action is awaiting user approval
 */
export function hasPendingApproval(items) {
  return scanToolStates(items).hasPending;
}

/**
 * True if any approved/running tool-action is still missing its result
 * (recursively). The worker can flip to idle before the frontend finishes
 * executing an approved tool, so this guards against resolving a wait while a
 * tool result is still in flight (which would race document assertions). Thin
 * view over scanToolStates.
 * @param {any[]} items - Items to search
 * @returns {boolean} True if an approved/running tool is still awaiting its result
 */
export function hasIncompleteApprovedTools(items) {
  return scanToolStates(items).hasIncomplete;
}

/**
 * The shared observe-until-predicate wait, carrying the harnesses' deadline
 * policy. Resolves when `predicate(items, ps)` is truthy (ps = raw metadata
 * processingState), rejects if the predicate throws (constraint-violation path),
 * on timeout, or on abort.
 *
 * Patience: a real future `deadlineMs` bounds the wait (+1s so the runner's hard
 * timeout fires first with the full op trace); a falsy deadline (0 sentinel /
 * undefined) falls back to `timeoutMs`. `signal` tears the wait down at the
 * per-test deadline. This is the ONLY place that deadline policy lives, so a
 * blanket change can't silently corrupt one caller.
 * @param {any} conversation - Conversation instance
 * @param {(items: any[], ps: any) => boolean} predicate
 * @param {{deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export function observeUntil(conversation, predicate, { deadlineMs, signal, timeoutMs = 5000, label = '' } = {}) {
  const effectiveTimeoutMs = deadlineMs
    ? Math.max(0, deadlineMs - Date.now() + 1000)
    : timeoutMs;
  return observeUntilTerminal(conversation, predicate, { timeoutMs: effectiveTimeoutMs, signal, label });
}

/**
 * Wait for a worker turn to reach a durable terminal state, as
 * `model/turn-completion.js` defines it: no approved tool still executing, and
 * either a tool-action parked for approval or an idle worker whose
 * `completedTurns` has advanced past `sinceTurn`.
 *
 * Pass `sinceTurn = conversation.completedTurns` captured *before* the action
 * that starts a new turn (send / compact). Omit it for **settle mode** (resume
 * /rerun paths) where the current turn just needs to quiesce and no new turn
 * epoch is expected.
 * @param {any} conversation - Conversation instance
 * @param {{sinceTurn?: number, deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export function waitForTurnComplete(conversation, { sinceTurn, deadlineMs, signal, timeoutMs = 6000, label = '' } = {}) {
  const fence = typeof sinceTurn === 'number';

  const terminal = (/** @type {any[]} */ items) => inspectTurn(conversation, items, { sinceTurn }).done;

  return observeUntil(conversation, terminal, {
    deadlineMs,
    signal,
    timeoutMs,
    label: `${label || 'turn complete'} (fence=${fence} sinceTurn=${sinceTurn})`
  });
}
