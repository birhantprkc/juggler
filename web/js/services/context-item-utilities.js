//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Context Item Utilities
 *
 * Free functions that coordinate context item lifecycle: execution,
 * refresh, content change detection, and worker synchronization.
 *
 * These operate on a MessageThread's doc state but depend on external
 * services (registry, worker, session) — which is why they don't
 * belong on MessageThread itself.
 */

import contextItemRegistry from '../registries/context-item-registry.js';
import workerManager from './worker-manager.js';
import { createContextItemMessage } from '../../sdk/lib/message.js';
import { convertToYType } from '../model/item-accessor.js';
import { hashString } from '../utils/hash.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * @typedef {import('../model/message-thread.js').default} MessageThread
 * @typedef {import('../model/conversation.js').default} Conversation
 * @typedef {import('../model/session.js').default} Session
 */

// Per-thread batching state for context item yjs updates.
// Uses WeakMap so threads can be GC'd without cleanup.
/** @type {WeakMap<MessageThread, Map<string, any>>} */
const pendingUpdates = new WeakMap();
/** @type {WeakMap<MessageThread, ReturnType<typeof setTimeout>|null>} */
const updateTimers = new WeakMap();

/**
 * Execute a context item and create it in the thread.
 * @param {MessageThread} mt
 * @param {Conversation} conv
 * @param {string} itemTypeId
 * @param {Record<string, any>} params
 * @param {{customId?: string, toolName?: string}} [options]
 * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
 */
export async function executeContextItem(mt, conv, itemTypeId, params, options = {}) {
  const { customId, toolName = itemTypeId } = options;
  const session = conv._session;
  /** @type {any} */
  const ItemClass = contextItemRegistry.get(itemTypeId);
  if (!ItemClass) {
    return { id: null, type: itemTypeId, created: false, error: `Unknown context item type: ${itemTypeId}` };
  }

  // Each user-driven context-item action is its own logical undo step.
  // Close the worker UndoManager's capture window so the resulting
  // mutations don't merge with the preceding step.
  const { default: workerManager } = await import('./worker-manager.js');
  workerManager.stopUndoCapturing(conv.id);

  // Check merge/replace with existing items of same type
  if (!customId && ItemClass.mergeOrReplace) {
    const existingItemsOfType = mt.contextItems.filter(item => item.type === itemTypeId);
    const context = { projectPath: session.projectPath };
    const mergeResult = ItemClass.mergeOrReplace(params, existingItemsOfType, context);
    if (mergeResult) {
      const existingItem = /** @type {import('juggler/context-item').default} */ (mergeResult.item);
      if (!existingItem?.id || !mt.findByItemId(existingItem.id)) {
        console.error(`[ContextItemOrchestrator] BUG: mergeOrReplace for ${itemTypeId} returned invalid item - creating new`);
      } else if (existingItem.type !== itemTypeId) {
        console.error(`[ContextItemOrchestrator] BUG: mergeOrReplace returned wrong type: ${existingItem.type} (expected ${itemTypeId})`);
      } else {
        if (mergeResult.action === 'merge') {
          Object.assign(existingItem.data, mergeResult.mergedParams);
        }
        if (mergeResult.action === 'reuse' || mergeResult.action === 'merge') {
          /** @type {import('juggler/context-item').ToolCallContext} */
          const ctx = { session, conversation: conv };
          const toolResult = await existingItem.handleToolCall(toolName, params, ctx);
          if (!toolResult.success) {
            return { id: existingItem.id, type: existingItem.type, created: false, error: toolResult.error };
          }
          mt.addContextItem(existingItem);
          repositionPlaceholder(conv, existingItem.id);
          return { id: existingItem.id, type: existingItem.type, created: true };
        }
      }
    }
  }

  // Determine item ID
  let newItemId;
  if (customId) {
    const existingItem = mt.contextItems.find(item => item.id === customId);
    if (existingItem) {
      if (existingItem.type !== itemTypeId) {
        return { id: null, type: itemTypeId, created: false,
          error: `Cannot replace context item ${customId}: type mismatch (${existingItem.type} vs ${itemTypeId})` };
      }
      mt.removeContextItem(customId);
    }
    newItemId = customId;
  } else {
    newItemId = generateUniqueItemId(mt, ItemClass);
  }

  // Create and execute
  const contextItem = new ItemClass({ id: newItemId, type: itemTypeId, session, conversation: conv, messageThread: mt });
  /** @type {import('juggler/context-item').ToolCallResult} */
  let toolResult;
  try {
    /** @type {import('juggler/context-item').ToolCallContext} */
    const ctx = { session, conversation: conv };
    toolResult = await contextItem.handleToolCall(toolName, params, ctx);
  } catch (err) {
    const errorMessage = extractErrorMessage(err);
    mt.addEvent(createContextItemMessage({ itemType: itemTypeId, error: errorMessage, isNew: true }));
    return { id: null, type: itemTypeId, created: false, error: errorMessage };
  }

  if (!toolResult.success) {
    const errorMessage = toolResult.error || 'Context item execution failed';
    mt.addEvent(createContextItemMessage({ itemType: itemTypeId, error: errorMessage, isNew: true }));
    return { id: null, type: itemTypeId, created: false, error: errorMessage };
  }

  // Add message to conversation if not already present
  const alreadyHasMessage = mt.getMessages().some(
    (/** @type {any} */ e) => e.get('itemId') === newItemId
  );
  if (!alreadyHasMessage) {
    const itemJSON = contextItem.toJSON();
    mt.addEvent(createContextItemMessage({
      itemId: newItemId,
      isNew: true,
      itemType: contextItem.type,
      data: itemJSON.data
    }));
  }

  mt.addContextItem(contextItem);
  return { id: newItemId, type: contextItem.type, created: true };
}

/**
 * Refresh a single context item.
 * @param {MessageThread} mt
 * @param {Conversation} conv
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export async function refreshContextItem(mt, conv, itemId) {
  /** @type {any} */ (conv)._animationService.animateContextItemRefresh(itemId);
  const contextItem = mt.getContextItem(itemId);
  if (!contextItem) {
    console.error(`[ESSENTIAL] [ContextItemOrchestrator] Context item not found: ${itemId}`);
    return;
  }
  const ItemClass = contextItemRegistry.get(contextItem.type);
  if (!ItemClass) {
    console.error(`[ESSENTIAL] [ContextItemOrchestrator] Context item class not found for: ${contextItem.type}`);
    return;
  }
  /** @type {any} */
  const manifest = /** @type {any} */ (ItemClass).MANIFEST;
  if (!manifest || !manifest.refreshable) {
    return;
  }
  try {
    await /** @type {any} */ (contextItem).refresh();
    conv._session.save();
  } catch (error) {
    console.error(`[ESSENTIAL] [ContextItemOrchestrator] Failed to refresh context item: ${error}`);
    if (error instanceof Error) {
      /** @type {Record<string, any>} */ (contextItem.data).error = error.message;
    }
    conv._session.save();
  }
}

/**
 * Refresh all refreshable context items in a thread.
 * @param {MessageThread} mt
 * @param {Conversation} conv
 * @returns {Promise<void>}
 */
export async function refreshAllContextItems(mt, conv) {
  const refreshableItems = mt.contextItems.filter(item => {
    const ItemClass = contextItemRegistry.get(item.type);
    const manifest = ItemClass && /** @type {any} */ (ItemClass).MANIFEST;
    return manifest && manifest.refreshable === true;
  });
  await Promise.all(
    refreshableItems.map(item => refreshContextItem(mt, conv, item.id))
  );
}

/**
 * Handle context item content change — detects data diffs,
 * batches yjs updates, and notifies the worker.
 * @param {MessageThread} mt
 * @param {Conversation} conv
 * @param {string} itemId
 * @param {import('juggler/context-item').default} [changedItem]
 */
export async function handleContextItemContentChanged(mt, conv, itemId, changedItem) {
  const contextItem = changedItem || mt.getContextItem(itemId);
  if (!contextItem) return;
  const existingItem = mt.findByItemId(itemId);
  if (!existingItem) return;

  const existingDataRaw = existingItem.get('data');
  const existingItemData = {
    id: existingItem.get('itemId'),
    type: existingItem.get('type') || 'unknown',
    data: existingDataRaw?.toJSON ? existingDataRaw.toJSON() : (existingDataRaw || {})
  };
  const newData = (typeof contextItem.toJSON === 'function' ? contextItem.toJSON().data : contextItem.data) || {};
  const dataChanged = JSON.stringify(existingItemData.data) !== JSON.stringify(newData);

  if (dataChanged) {
    // Batch the yjs update
    if (!pendingUpdates.has(mt)) pendingUpdates.set(mt, new Map());
    /** @type {Map<string, any>} */ (pendingUpdates.get(mt)).set(itemId, { ...existingItemData, data: newData });
    flushUpdates(mt, conv);

    // Notify worker
    const dataHash = hashString(JSON.stringify(newData));
    workerManager.updateAndRepositionToolActions(conv.id, itemId, dataHash);
  }
}

/**
 * Ensure all context items have UI marker messages in the conversation.
 * @param {MessageThread} mt
 * @returns {Promise<Set<string>>} Set of new context item IDs
 */
export async function refreshContextItemsAndDetectChanges(mt) {
  /** @type {Set<string>} */
  const newItemIds = new Set();
  for (const contextItem of mt.contextItems) {
    if (contextItem.type === 'system-prompt') continue;
    const itemMsg = mt.getMessages().find(
      (/** @type {any} */ e) => e.get('itemId') === contextItem.id
    );
    if (!itemMsg) {
      mt.addEvent(createContextItemMessage({
        itemId: contextItem.id,
        itemType: contextItem.type,
        isNew: true
      }));
      newItemIds.add(contextItem.id);
    }
  }
  return newItemIds;
}

// ── Selection helpers ─────────────────────────────────────────────────

/**
 * Check if a Y.Map item is a valid selection candidate.
 * Returns false for items without an itemId and for hidden context items
 * (e.g., transaction markers).
 * @param {any} item - Y.Map item from the items array
 * @param {MessageThread} messageThread
 * @returns {boolean} True if the item is selectable
 */
export function isItemSelectable(item, messageThread) {
  const itemId = item?.get?.('itemId');
  if (!itemId) return false;
  if (messageThread) {
    const ci = messageThread.getContextItem(itemId);
    if (ci && !ci.isVisible()) return false;
  }
  return true;
}

/**
 * Find the nearest selectable neighbor for an item about to be deleted.
 * Prefers the item after deletedIndex; falls back to the item before.
 * @param {any[]} items - Current items array (pre-deletion)
 * @param {number} deletedIndex - Index of the item being deleted
 * @param {MessageThread} messageThread
 * @returns {string|null} Item ID of the neighbor, or null if none
 */
export function findNeighborItemId(items, deletedIndex, messageThread) {
  for (let i = deletedIndex + 1; i < items.length; i++) {
    if (isItemSelectable(items[i], messageThread)) return items[i].get('itemId');
  }
  for (let i = deletedIndex - 1; i >= 0; i--) {
    if (isItemSelectable(items[i], messageThread)) return items[i].get('itemId');
  }
  return null;
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * @param {Conversation} conv
 * @param {string} itemId
 */
function repositionPlaceholder(conv, itemId) {
  workerManager.repositionContextItemPlaceholder(conv.id, itemId);
}

/**
 * Allocate a new, unique, never-reused item ID for the given conversation + prefix.
 * IDs are issued from a per-prefix monotonic counter stored in the Yjs metadata map.
 * Because the counter never decrements (not even on undo), IDs deleted by the user
 * are never reused — preventing undo re-insertion from producing duplicates.
 * For existing docs that pre-date the counter: the counter is bootstrapped from the
 * highest numeric suffix found across all threads for this prefix, then incremented.
 * @param {MessageThread} mt
 * @param {any} ItemClass
 * @returns {string} Unique item ID
 */
function generateUniqueItemId(mt, ItemClass) {
  const idPrefix = (ItemClass.MANIFEST && ItemClass.MANIFEST.idPrefix) || 'ITEM';
  const conv = mt.conversation;
  const metaKey = `nextItemNum_${idPrefix}`;

  let nextNum = conv.getMetadata(metaKey);
  if (typeof nextNum !== 'number') {
    // Bootstrap: scan all threads for the highest used numeric suffix for this prefix.
    const prefixUnderscore = idPrefix + '_';
    let maxNum = 0;
    for (const thread of conv.getAllMessageThreads()) {
      for (const item of thread.contextItems) {
        if (item.id && item.id.startsWith(prefixUnderscore)) {
          const suffix = parseInt(item.id.slice(prefixUnderscore.length), 10);
          if (!isNaN(suffix) && suffix > maxNum) maxNum = suffix;
        }
      }
    }
    nextNum = maxNum;
  }

  nextNum++;
  conv.setMetadata(metaKey, nextNum);

  return `${idPrefix}_${nextNum}`;
}

/**
 * Flush pending context item updates in a single yjs transaction.
 * @param {MessageThread} mt
 * @param {Conversation} conv
 */
function flushUpdates(mt, conv) {
  if (updateTimers.get(mt)) return;
  updateTimers.set(mt, setTimeout(() => {
    const updates = pendingUpdates.get(mt);
    if (!updates || updates.size === 0) {
      updateTimers.set(mt, null);
      return;
    }
    const batch = new Map(updates);
    updates.clear();
    conv.atomicUpdate(() => {
      for (const [itemId, itemData] of batch) {
        const ymap = mt.findByItemId(itemId);
        if (ymap) {
          ymap.set('type', itemData.type);
          ymap.set('data', convertToYType(itemData.data));
        }
      }
    });
    updateTimers.set(mt, null);
  }, 0));
}
