//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared turn-completion synchronization for the test harnesses.
 *
 * The one correct way for a test to wait for the worker: observe a DURABLE,
 * level-triggered terminal condition, never a transient state edge. The worker
 * bumps a monotonic counter in the durable `completedTurns` metadata key on
 * every idle transition (cmd/juggler/worker/worker.go sendStatus);
 * `Conversation.completedTurns` exposes it. Fencing on that counter is immune
 * to Yjs sync batching — a fast turn whose busy→idle window coalesces into a
 * single broadcast still advances the counter — and to the stale-idle race (an
 * idle left over from the previous turn), in one condition.
 *
 * This module is the single home for that logic so the integration and UI
 * harnesses can't drift apart again (the bug that motivated it lived in one
 * harness while the other had already done it right).
 * @module test/utilities/turn-sync
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';

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
 * Single-pass scan combining the two tool-state checks the turn fence needs, so
 * the hot wait path walks the item tree (including nested threads) once per
 * observer fire instead of twice.
 * @param {any[]} items - Items to search
 * @returns {{hasIncomplete: boolean, hasPending: boolean}} Pending-approval and in-flight-result flags for the turn fence
 */
export function scanToolStates(items) {
  let hasIncomplete = false;
  let hasPending = false;
  const walk = (/** @type {any[]} */ list) => {
    if (!list) return;
    for (const item of list) {
      const type = item.get('type');
      if (type === 'tool-action') {
        const state = item.get('state');
        const result = item.get('result');
        if ((state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED) &&
					(result === undefined || result === null)) hasIncomplete = true;
        if (state === TOOL_STATES.PENDING) hasPending = true;
      } else if (type === 'thread') {
        const nested = item.get('items');
        if (nested) walk(nested.toArray ? nested.toArray() : []);
      }
    }
  };
  walk(items);
  return { hasIncomplete, hasPending };
}

/**
 * The shared observe-until-predicate engine: the Promise + Yjs observer + timer
 * + abort + cleanup machinery that both waitForTurnComplete and the integration
 * harness's _waitForCondition run on. Resolves when `predicate(items, ps)` is
 * truthy (ps = raw metadata processingState), rejects if the predicate throws
 * (constraint-violation path), on timeout, or on abort. Keeping this in one
 * place is the point — the two waiters previously each carried their own copy.
 *
 * Patience: a real future `deadlineMs` bounds the wait (+1s so the runner's hard
 * timeout fires first with the full op trace); a falsy deadline (0 sentinel /
 * undefined) falls back to `timeoutMs`. `signal` tears the wait down at the
 * per-test deadline.
 * @param {any} conversation - Conversation instance
 * @param {(items: any[], ps: any) => boolean} predicate
 * @param {{deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export function observeUntil(conversation, predicate, { deadlineMs, signal, timeoutMs = 5000, label = '' } = {}) {
  // @ts-ignore - _doc access needed for low-level Yjs observers in test harness
  const doc = conversation._doc;
  const metadata = doc.metadata;
  // Observe the root map deeply rather than root.get('items') directly: a
  // just-created conversation (/duplicate, promote-to-tab) may not have its
  // items array yet, and a deep root observer both survives that and fires
  // when the array appears and on every nested change thereafter.
  const root = doc.root;

  const effectiveTimeoutMs = deadlineMs
    ? Math.max(0, deadlineMs - Date.now() + 1000)
    : timeoutMs;
  const suffix = label ? `: ${label}` : '';

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Aborted waiting for condition${suffix} (per-test deadline)`));
      return;
    }

    const cleanup = () => {
      metadata.unobserve(check);
      root.unobserveDeep(check);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new Error(`Aborted waiting for condition${suffix} (per-test deadline)`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for condition${suffix}`));
    }, effectiveTimeoutMs);

    const check = () => {
      const items = conversation.rootMessageThread.items || [];
      const ps = metadata.get('processingState');
      let matched = false;
      try {
        matched = !!predicate(items, ps);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (matched) {
        cleanup();
        resolve();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    metadata.observe(check);
    root.observeDeep(check);
    check(); // resolve synchronously if already satisfied
  });
}

/**
 * Wait for a worker turn to reach a durable terminal state.
 *
 * Resolves when, with no approved tool still executing, EITHER:
 *  - a tool-action is pending approval (the turn is paused for the user), OR
 *  - the worker is idle — and, in **fence mode**, `completedTurns` has advanced
 *    past `sinceTurn` (a genuinely new turn finished, not a stale idle).
 *
 * Pass `sinceTurn = conversation.completedTurns` captured *before* the action
 * that starts a new turn (send / compact). Omit it for **settle mode** (resume
 * /rerun paths) where the current turn just needs to quiesce and no new turn
 * epoch is expected.
 *
 * Patience: when `deadlineMs` (the per-test hard deadline) is supplied the wait
 * stays patient up to it (+1s margin so the runner's own timeout fires first);
 * otherwise it uses `timeoutMs`. `signal` (the per-test AbortController) tears
 * the wait down immediately at the deadline. This is the ONLY place that
 * deadline policy lives, so a blanket change can't silently corrupt one caller.
 * @param {any} conversation - Conversation instance
 * @param {{sinceTurn?: number, deadlineMs?: number, signal?: AbortSignal, timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<void>}
 */
export function waitForTurnComplete(conversation, { sinceTurn, deadlineMs, signal, timeoutMs = 6000, label = '' } = {}) {
  const fence = typeof sinceTurn === 'number';

  const terminal = (/** @type {any[]} */ items) => {
    const { hasIncomplete, hasPending } = scanToolStates(items);
    // An approved tool is still running — hold, even if a sibling is pending.
    if (hasIncomplete) return false;
    // Paused for user input — done regardless of phase.
    if (hasPending) return true;
    // Worker must be idle. Read processingState ONCE (the durable signal the
    // worker writes) and derive both status and the turn epoch from it.
    const ps = conversation.processingState;
    if (ps && ps.status !== 'idle') return false;
    // Idle. Fence mode additionally requires a NEW completed turn — immune to
    // sync-batch coalescing and to a stale idle from the previous turn. The
    // counter lives in its own `completedTurns` metadata key (read via the
    // getter), not inside the ephemeral processingState blob.
    return fence ? conversation.completedTurns > sinceTurn : true;
  };

  return observeUntil(conversation, terminal, {
    deadlineMs,
    signal,
    timeoutMs,
    label: `${label || 'turn complete'} (fence=${fence} sinceTurn=${sinceTurn})`
  });
}
