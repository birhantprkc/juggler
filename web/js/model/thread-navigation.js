//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Thread Navigation Utilities
 *
 * Pure functions for navigating the thread tree structure in Yjs documents.
 * These walk Y.Arrays and Y.Maps without depending on Conversation or
 * MessageThread instances.
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * Extract message IDs of newly inserted items from a Yjs delta.
 * @param {Array<any>} delta - Yjs delta array
 * @returns {string[]} Array of itemIds that were inserted
 */
export function extractInsertedItemIds(delta) {
  /** @type {string[]} */
  const itemIds = [];
  if (!Array.isArray(delta)) return itemIds;

  for (const change of delta) {
    if (change.insert && Array.isArray(change.insert)) {
      for (const item of change.insert) {
        if (item && typeof item === 'object') {
          const id = item.get ? item.get('itemId') : item.itemId;
          if (id) itemIds.push(id);
        }
      }
    }
  }
  return itemIds;
}

/**
 * Find which thread Y.Map owns a given Y.Array by searching recursively.
 * @param {*} arr - Y.Array to search within
 * @param {*} targetArray - The Y.Array we're looking for
 * @returns {*|null} The thread Y.Map that owns targetArray, or null
 */
export function findThreadForArray(arr, targetArray) {
  if (!arr) return null;
  const items = arr.toArray();
  for (const item of items) {
    if (!item || typeof item.get !== 'function' || item.get('type') !== 'thread') {
      continue;
    }
    const threadItems = item.get('items');
    if (threadItems === targetArray) {
      return item;
    }
    if (threadItems) {
      const found = findThreadForArray(threadItems, targetArray);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the parent thread Y.Map for a given threadItemId.
 * Returns null if the thread is at the root level (direct child of rootArr).
 * Returns undefined if not found in the subtree.
 * @param {*} arr - Y.Array to search within
 * @param {string} targetId - The threadItemId to find the parent for
 * @returns {*|null|undefined} Parent Y.Map, null if at root level, undefined if not found
 */
export function findParentInArray(arr, targetId) {
  if (!arr) return undefined;
  const items = arr.toArray();
  for (const item of items) {
    if (!item || typeof item.get !== 'function' || item.get('type') !== 'thread') {
      continue;
    }
    if (item.get('itemId') === targetId) {
      return null; // Found at this level — parent is the container above
    }
    const threadItems = item.get('items');
    if (threadItems) {
      const children = threadItems.toArray();
      for (const child of children) {
        if (child && typeof child.get === 'function' &&
                    child.get('type') === 'thread' &&
                    child.get('itemId') === targetId) {
          return item; // This thread Y.Map is the parent
        }
      }
      const found = findParentInArray(threadItems, targetId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Walk all thread items recursively, calling callback for each.
 * @param {Array<*>} items - Items to walk
 * @param {(threadYMap: any) => void} callback - Called with each thread Y.Map
 */
export function walkThreads(items, callback) {
  for (const item of items) {
    if (!item || typeof item.get !== 'function' || item.get('type') !== 'thread') {
      continue;
    }
    const threadItems = item.get('items');
    if (!threadItems) continue;
    callback(item);
    walkThreads(threadItems.toArray(), callback);
  }
}

/**
 * Determine whether a subtree of items contains a tool-action awaiting user
 * approval (state `pending`/`awaiting_approval`), searching recursively through
 * nested threads. This is the single source of truth for propagating the
 * "needs your input" highlight from a deeply-nested sub-thread up to every
 * ancestor tile and the conversation tab — so the visual route from the tab to
 * the required action is unbroken regardless of nesting depth.
 * @param {Array<*>|{toArray: () => Array<*>}|null|undefined} items - Items to
 *   search. Accepts a plain JS array (MessageThread.items) or a Y.Array
 *   (threadYMap.get('items')).
 * @returns {boolean} True if any descendant tool-action is pending approval.
 */
export function hasPendingApprovalInTree(items) {
  if (!items) return false;
  const arr = typeof (/** @type {any} */ (items).toArray) === 'function'
    ? /** @type {any} */ (items).toArray()
    : items;
  for (const item of arr) {
    if (!item || typeof item.get !== 'function') continue;
    const type = item.get('type');
    if (type === 'tool-action') {
      const state = item.get('state');
      // 'awaiting_approval' is a legacy/defensive alias for PENDING that some
      // callers still stamp; treat it as pending here too.
      if (state === TOOL_STATES.PENDING || state === 'awaiting_approval') return true;
    } else if (type === 'thread') {
      if (hasPendingApprovalInTree(item.get('items'))) return true;
    }
  }
  return false;
}

/**
 * Determine whether a subtree of items contains a NON-TERMINAL tool-action
 * (state is anything other than `completed`/`cancelled` — i.e. pending,
 * approved, running, or unset), searching recursively through nested threads.
 * This is the broader sibling of `hasPendingApprovalInTree`: it answers "is
 * there live work anywhere under here", not just "is something awaiting
 * approval". Mirror of the Go worker's terminality check (findThreadWith-
 * IncompleteTool / cancelToolsInArray).
 * @param {Array<*>|{toArray: () => Array<*>}|null|undefined} items - Items to
 *   search (plain JS array or Y.Array).
 * @returns {boolean} True if any descendant tool-action is non-terminal.
 */
export function hasUnsettledToolInTree(items) {
  if (!items) return false;
  const arr = typeof (/** @type {any} */ (items).toArray) === 'function'
    ? /** @type {any} */ (items).toArray()
    : items;
  for (const item of arr) {
    if (!item || typeof item.get !== 'function') continue;
    const type = item.get('type');
    if (type === 'tool-action') {
      const state = item.get('state');
      if (state !== TOOL_STATES.COMPLETED && state !== TOOL_STATES.CANCELLED) return true;
    } else if (type === 'thread') {
      if (hasUnsettledToolInTree(item.get('items'))) return true;
    }
  }
  return false;
}

/**
 * Whether a thread is "closed" (genuinely finished) for navigation/display.
 *
 * A thread is closed when it has a non-empty `result` AND nothing in its
 * subtree is still live (no non-terminal tool-action). The live signal
 * overrides the result: a thread mid-tool-use — pending approval, approved, or
 * running — is still active, even if a stale `result` sits on it (e.g. the
 * "Thread was interrupted" sentinel the crash-repair stamps on every resultless
 * thread on reload, including ones that are in fact just waiting/working).
 * Deriving "closed" from live tool state, never from the persisted `result`
 * alone, keeps the composer from bouncing parent↔child as the tool cycles
 * pending→running.
 *
 * This is the single source of truth for "is this thread done" — every consumer
 * that treats `result` as "finished" (tile status, composer-box placement, footer
 * Reopen/Continue, …) goes through here so they agree. The "still has live work
 * inside" property is derived at point of use, never written into the model.
 * @param {any} threadYMap - The thread Y.Map.
 * @returns {boolean} True if the thread is genuinely finished.
 */
export function isThreadClosed(threadYMap) {
  if (!threadYMap || typeof threadYMap.get !== 'function') return false;
  const result = threadYMap.get('result');
  if (typeof result !== 'string' || result.length === 0) return false;
  return !hasUnsettledToolInTree(threadYMap.get('items'));
}

/**
 * Find an item by itemId, searching recursively through nested threads.
 * @param {Array<*>} items - Items to search
 * @param {string} id - Item ID to find
 * @returns {*|null} Y.Map or null
 */
export function findItemByIdRecursive(items, id) {
  for (const item of items) {
    if (item.get('itemId') === id) {
      return item;
    }
    if (item.get('type') === 'thread') {
      const threadItems = item.get('items');
      if (threadItems) {
        const found = findItemByIdRecursive(threadItems.toArray(), id);
        if (found) return found;
      }
    }
  }
  return null;
}
