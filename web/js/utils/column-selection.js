//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Miller Column Selection State
 *
 * Pure state and logic for Miller column navigation. No DOM dependencies.
 * Tracks which item is selected in each column, which column is active,
 * and handles auto-following of LLM processing threads.
 */

import { findGroup, isGroupId } from './item-grouping.js';
import { canonicalThread } from '../model/thread-alias.js';

/**
 * @typedef {object} ColumnChainEntry
 * @property {'conversation'|'properties'|'transaction'} type - What kind of column to render
 * @property {any} [container] - Y.Map container (root or thread Y.Map) that holds 'items'
 * @property {string|undefined} [threadItemId] - Thread item ID (for thread conversation columns)
 * @property {any} [threadYMap] - The thread Y.Map (for thread conversation columns)
 * @property {string} [viewItemId] - The parent item this column was opened through,
 *   which for a thread called more than once is one of several views of the same
 *   transcript. It is the tile the user is acting on, so it — not the canonical
 *   the column resolves to — is what the column's Delete removes.
 * @property {string} [selectedItemId] - Selected item ID (for properties columns)
 * @property {string} [transactionId] - Round-trip id: the one the selected item
 *   belongs to (properties columns), or the one being shown (transaction columns)
 * @property {string} [groupId] - Display id of the folded tool run this column shows
 * @property {any[]} [groupItems] - The run's items (for group conversation columns)
 */

/** @typedef {(item: any) => boolean} ThreadPredicate */

const AUTO_SELECT_COOLDOWN_MS = 5000;

class ColumnSelectionState {
  constructor() {
    /** @type {(string|null)[]} - Selected itemId per column index */
    this.selections = [];

    /** @type {number} - Which column has focus */
    this.activeColumnIndex = 0;

    /** @type {number} - Timestamp of last manual interaction */
    this.lastManualInteractionTime = 0;

    /** @type {string|null|undefined} - Last observed statusThreadId for change detection */
    this._lastStatusThreadId = undefined;

    /**
     * Whether the transaction-detail panel is open. It is a lens on the
     * properties column beside it rather than a pinned view of one round-trip:
     * it re-targets to whatever that column is showing, so browsing items
     * leaves it up. Its own index is never stored — a properties column is
     * always the tail of the chain, so the transaction column is always the
     * one appended after it.
     * @type {boolean}
     */
    this.txnOpen = false;
  }

  /** Reset selections (e.g. when switching conversations) */
  resetSelections() {
    this.selections = [];
    this.txnOpen = false;
  }

  /** Record that the user manually interacted (click, keyboard) */
  markManualInteraction() {
    this.lastManualInteractionTime = Date.now();
  }

  /**
   * Select an item in a column. Truncates all selections after this column (Finder behavior).
   *
   * `focus` decides whether the keyboard target moves to this column too. A
   * selection the user drives (click, arrow key) belongs in the column they are
   * working in, so it takes focus. A selection the system makes for them — a
   * child column auto-selecting a tool action as it arrives, while the user
   * reads further up — must not, or the next arrow key navigates a column they
   * never asked for. Truncation happens either way: the chain past this column
   * is stale whoever selected it, and clampActiveIndex pulls a focus left
   * dangling past the shortened chain back into range.
   * @param {number} columnIndex
   * @param {string} itemId
   * @param {{focus?: boolean}} [opts] - `focus` (default true): make this the active column.
   */
  selectItem(columnIndex, itemId, opts = {}) {
    const { focus = true } = opts;
    if (focus) this.activeColumnIndex = columnIndex;
    this.selections[columnIndex] = itemId;
    this.selections.length = columnIndex + 1;
  }

  /**
   * Clear selection at a column, removing all columns after it.
   * @param {number} columnIndex
   */
  clearSelection(columnIndex) {
    this.selections.length = columnIndex;
  }

  /**
   * Open the transaction-detail panel beside the properties column at
   * `columnIndex`, and move focus onto it so the existing
   * scroll-to-active-column rule (clampActiveIndex + _scrollToActiveColumn)
   * brings it into view — the same path that handles arrow-right navigation.
   * @param {number} columnIndex - Index of the properties column it opens beside.
   */
  openTransaction(columnIndex) {
    this.txnOpen = true;
    // Transaction column is appended right after the originating properties
    // panel, so its index is columnIndex + 1.
    this.activeColumnIndex = columnIndex + 1;
  }

  /**
   * Close the transaction-detail panel. Focus returns to the properties panel
   * that owns the toggle button so the just-closed column doesn't leave the
   * active index dangling past the shortened chain.
   * @param {number} columnIndex - Index of the properties column that owns the toggle.
   */
  closeTransaction(columnIndex) {
    this.txnOpen = false;
    this.activeColumnIndex = columnIndex;
  }

  /**
   * Remove a thread from selections (e.g. when deleted).
   * @param {string} threadItemId
   * @returns {number} The column index where truncation happened, or -1 if not found
   */
  deleteThread(threadItemId) {
    for (let i = 0; i < this.selections.length; i++) {
      if (this.selections[i] === threadItemId) {
        this.selections.length = i;
        return i;
      }
    }
    return -1;
  }

  /**
   * Navigate left (toward root).
   * @returns {boolean} True if the index changed
   */
  navigateLeft() {
    if (this.activeColumnIndex <= 0) return false;
    this.activeColumnIndex--;
    return true;
  }

  /**
   * Navigate right (into a thread column).
   * Caller must verify the selected item is a thread and the next column exists.
   * @param {number} nextColumnIndex - The column to navigate into
   * @returns {boolean} True if the index changed
   */
  navigateRight(nextColumnIndex) {
    this.activeColumnIndex = nextColumnIndex;
    return true;
  }

  /**
   * Clamp activeColumnIndex to a valid conversation-area column.
   *
   * Exception: when the leaf column is an open transaction-detail panel,
   * keep focus on it. The user opened it deliberately, so the existing
   * scroll-to-active rule should reveal it. Keyboard navigation early-returns
   * gracefully on non-conversation-area columns, so leaving focus there is
   * harmless.
   * @param {{tagName: string}[]} columns - The current column elements
   */
  clampActiveIndex(columns) {
    if (this.activeColumnIndex >= columns.length) {
      this.activeColumnIndex = columns.length - 1;
    }
    const lastIdx = columns.length - 1;
    if (this.txnOpen &&
        this.activeColumnIndex === lastIdx &&
        columns[lastIdx]?.tagName === 'PROPERTIES-PANEL') {
      return;
    }
    while (this.activeColumnIndex > 0 &&
           columns[this.activeColumnIndex] &&
           columns[this.activeColumnIndex]?.tagName !== 'CONVERSATION-AREA') {
      this.activeColumnIndex--;
    }
  }

  /**
   * Resolve the column chain from root through current selections.
   * Walks the Yjs tree to determine what type each column should be.
   * @param {{container: any, items: any[]}} rootThread - The root message thread
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @param {{groupingEnabled?: boolean}} [opts] - Display options; `groupingEnabled`
   *   lets a selection name a folded tool run rather than a single item.
   * @returns {ColumnChainEntry[]} Column chain entries
   */
  resolveColumnChain(rootThread, isThread, opts = {}) {
    /** @type {ColumnChainEntry[]} */
    const chain = [{ type: /** @type {const} */ ('conversation'), container: rootThread.container, threadItemId: undefined }];

    let currentItems = rootThread.items;
    for (let i = 0; i < this.selections.length; i++) {
      const selectedId = this.selections[i];
      if (!selectedId) break;

      // A folded tool run is a display construct, not an item: it opens a
      // column showing the rows it stands for. That column belongs to the SAME
      // thread as this one — the rows are still that thread's items — so it
      // inherits the container/thread identity and only narrows what's listed.
      if (isGroupId(selectedId)) {
        const group = opts.groupingEnabled ? findGroup(currentItems, selectedId) : null;
        if (!group) break;
        const parent = chain[i];
        chain.push({
          type: /** @type {const} */ ('conversation'),
          container: parent?.container,
          threadItemId: parent?.threadItemId,
          threadYMap: parent?.threadYMap,
          groupId: selectedId,
          groupItems: group.members
        });
        currentItems = group.members;
        continue;
      }

      let selectedItem = null;
      for (const item of currentItems) {
        if (!item || !item.get) continue;
        if (item.get('itemId') === selectedId) {
          selectedItem = item;
          break;
        }
      }

      if (!selectedItem) {
        // A queued (pending) message lives in this level's `pendingItems` array,
        // not `items`. It's always a leaf (never a thread), so it gets a plain
        // properties column — same as any selected non-thread item.
        const container = chain[i]?.container;
        const pendingArr = container && container.get ? container.get('pendingItems') : null;
        const pending = pendingArr && pendingArr.toArray ? pendingArr.toArray() : [];
        const isPending = pending.some((/** @type {any} */ it) => it && it.get && it.get('itemId') === selectedId);
        if (isPending) {
          chain.push({
            type: /** @type {const} */ ('properties'),
            selectedItemId: selectedId,
            container: chain[i]?.container
          });
        }
        break;
      }

      if (isThread(selectedItem)) {
        // The one place an alias is resolved. A thread called more than once has
        // one tile per call, each carrying its own result; every one of them
        // opens the SAME column, because they are views of one transcript. The
        // selection keeps naming the tile the user clicked — so that tile stays
        // highlighted — and only the column it opens is the canonical's.
        const thread = canonicalThread(selectedItem, currentItems);
        const nestedItems = thread.get('items');
        if (!nestedItems) break;

        chain.push({
          type: /** @type {const} */ ('conversation'),
          container: thread,
          threadItemId: thread.get('itemId') || selectedId,
          threadYMap: thread,
          viewItemId: selectedId
        });

        currentItems = nestedItems.toArray ? nestedItems.toArray() : [];
      } else {
        chain.push({
          type: /** @type {const} */ ('properties'),
          selectedItemId: selectedId,
          container: chain[i]?.container,
          transactionId: String(selectedItem.get('transactionId') || '')
        });
        break;
      }
    }

    // Append the open transaction-detail panel, if any. It shows the round-trip
    // of whatever the properties column is showing, so it follows the selection
    // rather than pinning one blob — an item belonging to no round-trip simply
    // leaves it empty. A properties column is always the tail of the chain, so
    // the chain no longer ending in one is the single condition that closes the
    // panel.
    if (this.txnOpen) {
      const anchor = chain[chain.length - 1];
      if (anchor?.type === 'properties') {
        chain.push({
          type: /** @type {const} */ ('transaction'),
          transactionId: anchor.transactionId || ''
        });
      } else {
        this.txnOpen = false;
      }
    }

    return chain;
  }

  /**
   * Resolve the chain of thread item IDs from root to a target thread.
   * Recursively walks the Yjs tree to find the path.
   * @param {any[]} rootItems - Root-level items to search
   * @param {string} targetThreadItemId - The thread item ID to find
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @returns {string[]} Chain of item IDs from root to target
   */
  resolveThreadChain(rootItems, targetThreadItemId, isThread) {
    /**
     * @param {any[]} items
     * @returns {string[]|null} Chain if found, null otherwise
     */
    const search = (items) => {
      for (const item of items) {
        if (!item || !item.get) continue;
        const itemId = item.get('itemId');
        if (!itemId) continue;

        if (itemId === targetThreadItemId) {
          return [itemId];
        }

        if (isThread(item)) {
          const nestedItems = item.get('items');
          if (nestedItems) {
            const arr = nestedItems.toArray ? nestedItems.toArray() : [];
            const result = search(arr);
            if (result) {
              return [itemId, ...result];
            }
          }
        }
      }
      return null;
    };

    return search(rootItems) || [];
  }

  /**
   * Check if the LLM processing state targets a new thread and auto-select it.
   * Respects a cooldown so manual user navigation isn't overridden.
   *
   * This is the one automatic path that rewrites the whole chain, so it is also
   * the one that can pull a column out from under a reader — `userPinned` is how
   * the columns say "someone is looking at this". A pin is not consumed:
   * `_lastStatusThreadId` stays untouched so that when the pin lifts (a new user
   * message, the offscreen demotion, focusing a composer) the next sync opens
   * whatever is running by then, rather than the chain staying frozen because
   * the one status change that mattered was spent while nobody could act on it.
   * @param {string|null} statusThreadId - Current LLM status thread ID
   * @param {any[]} rootItems - Root-level items for chain resolution
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @param {{userPinned?: boolean, nowMs?: number}} [opts] - `userPinned`: the
   *   user has a selection of their own somewhere in this tab. `nowMs`: current
   *   timestamp (for testability).
   * @returns {boolean} True if auto-selection was applied
   */
  maybeAutoSelectThread(statusThreadId, rootItems, isThread, opts = {}) {
    const { userPinned = false, nowMs = Date.now() } = opts;
    if (statusThreadId === this._lastStatusThreadId) return false;

    if (userPinned) return false;

    if (nowMs - this.lastManualInteractionTime < AUTO_SELECT_COOLDOWN_MS) {
      // Only apply cooldown for threads the user is already viewing.
      // A new thread (not in current selections) should always auto-open —
      // the user hasn't seen it yet, so there's nothing to protect.
      if (!statusThreadId || this.selections.includes(statusThreadId)) {
        this._lastStatusThreadId = statusThreadId;
        return false;
      }
    }
    if (!statusThreadId) {
      this._lastStatusThreadId = statusThreadId;
      return false;
    }

    const chain = this.resolveThreadChain(rootItems, statusThreadId, isThread);
    if (chain.length === 0) return false;

    // Only mark as handled once the chain actually resolved — the thread item
    // may not be in rootItems yet on the first sync after creation.
    this._lastStatusThreadId = statusThreadId;
    this.selections = chain;
    this.activeColumnIndex = chain.length;
    return true;
  }
}

export { ColumnSelectionState };
export { AUTO_SELECT_COOLDOWN_MS };
