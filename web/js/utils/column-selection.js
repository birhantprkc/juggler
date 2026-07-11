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

/**
 * @typedef {object} ColumnChainEntry
 * @property {'conversation'|'properties'|'transaction'} type - What kind of column to render
 * @property {any} [container] - Y.Map container (root or thread Y.Map) that holds 'items'
 * @property {string|undefined} [threadItemId] - Thread item ID (for thread conversation columns)
 * @property {any} [threadYMap] - The thread Y.Map (for thread conversation columns)
 * @property {string} [selectedItemId] - Selected item ID (for properties columns)
 * @property {string} [transactionId] - Round-trip id (for transaction columns)
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
     * Open transaction-detail panel, if any. Tied to the (columnIndex, itemId)
     * pair that opened it; any selection change that invalidates that pair
     * silently drops the panel during chain resolution.
     * @type {{columnIndex: number, itemId: string, transactionId: string}|null}
     */
    this.openTxn = null;
  }

  /** Reset selections (e.g. when switching conversations) */
  resetSelections() {
    this.selections = [];
    this.openTxn = null;
  }

  /** Record that the user manually interacted (click, keyboard) */
  markManualInteraction() {
    this.lastManualInteractionTime = Date.now();
  }

  /**
   * Select an item in a column. Truncates all selections after this column (Finder behavior).
   * @param {number} columnIndex
   * @param {string} itemId
   */
  selectItem(columnIndex, itemId) {
    this.activeColumnIndex = columnIndex;
    this.selections[columnIndex] = itemId;
    this.selections.length = columnIndex + 1;
    this.openTxn = null;
  }

  /**
   * Clear selection at a column, removing all columns after it.
   * @param {number} columnIndex
   */
  clearSelection(columnIndex) {
    this.selections.length = columnIndex;
    this.openTxn = null;
  }

  /**
   * Open a transaction-detail panel anchored to the (columnIndex, itemId) pair
   * that owns it. The panel auto-closes when that pair is invalidated by any
   * future selection change.
   *
   * Also moves focus onto the new transaction column so the existing
   * scroll-to-active-column rule (clampActiveIndex + _scrollToActiveColumn)
   * brings it into view — the same path that handles arrow-right navigation.
   * @param {number} columnIndex
   * @param {string} itemId
   * @param {string} transactionId
   */
  openTransaction(columnIndex, itemId, transactionId) {
    this.openTxn = { columnIndex, itemId, transactionId };
    // Transaction column is appended right after the originating properties
    // panel, so its index is columnIndex + 1.
    this.activeColumnIndex = columnIndex + 1;
  }

  /**
   * Close the open transaction-detail panel, if any. Focus returns to the
   * properties panel that owns the toggle button so the just-closed column
   * doesn't leave the active index dangling past the shortened chain.
   */
  closeTransaction() {
    if (!this.openTxn) return;
    this.activeColumnIndex = this.openTxn.columnIndex;
    this.openTxn = null;
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
    if (this.openTxn &&
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
   * @returns {ColumnChainEntry[]} Column chain entries
   */
  resolveColumnChain(rootThread, isThread) {
    /** @type {ColumnChainEntry[]} */
    const chain = [{ type: /** @type {const} */ ('conversation'), container: rootThread.container, threadItemId: undefined }];

    let currentItems = rootThread.items;
    for (let i = 0; i < this.selections.length; i++) {
      const selectedId = this.selections[i];
      if (!selectedId) break;

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
        const nestedItems = selectedItem.get('items');
        if (!nestedItems) break;

        chain.push({
          type: /** @type {const} */ ('conversation'),
          container: selectedItem,
          threadItemId: selectedId,
          threadYMap: selectedItem
        });

        currentItems = nestedItems.toArray ? nestedItems.toArray() : [];
      } else {
        chain.push({
          type: /** @type {const} */ ('properties'),
          selectedItemId: selectedId,
          container: chain[i]?.container
        });
        break;
      }
    }

    // Append the open transaction-detail panel (if any), but only when its
    // anchor pair (columnIndex, itemId) still matches the resolved chain.
    // Any selection change that drops or replaces the anchor invalidates it.
    if (this.openTxn) {
      const anchor = chain[this.openTxn.columnIndex];
      const anchorMatches = anchor &&
        anchor.type === 'properties' &&
        anchor.selectedItemId === this.openTxn.itemId;
      if (anchorMatches) {
        chain.push({
          type: /** @type {const} */ ('transaction'),
          transactionId: this.openTxn.transactionId
        });
      } else {
        this.openTxn = null;
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
   * @param {string|null} statusThreadId - Current LLM status thread ID
   * @param {any[]} rootItems - Root-level items for chain resolution
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @param {number} [nowMs] - Current timestamp (for testability)
   * @returns {boolean} True if auto-selection was applied
   */
  maybeAutoSelectThread(statusThreadId, rootItems, isThread, nowMs = Date.now()) {
    if (statusThreadId === this._lastStatusThreadId) return false;

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
