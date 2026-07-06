//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Context-item lifecycle extracted from MessageThread. Pure-function helpers
 * that take the MessageThread instance (`mt`) as first argument. The class
 * methods become one-line delegators.
 * @module model/message-thread-context-items
 */

import { plainToYMap, convertToYType } from './item-accessor.js';
import { createContextItemMessage } from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import workerManager from '../services/worker-manager.js';

/**
 * Read context items from the thread's items array. Instances are
 * transient wrappers around CRDT data — fresh objects on every call.
 * @param {any} mt - MessageThread instance
 * @returns {import('juggler/context-item').default[]} Context items
 */
export function getContextItems(mt) {
  const contextItems = [];
  for (const item of mt.items) {
    /** @type {any} */
    let itemData = null;
    if (item.get('itemId') && !item.get('toolUseId')) {
      const rawData = item.get('data');
      itemData = {
        id: item.get('itemId'),
        type: item.get('type') || 'unknown',
        data: rawData?.toJSON ? rawData.toJSON() : (rawData || {})
      };
    } else if (item.get('type') === 'tool-action') {
      const result = item.get('result');
      if (result?.get?.('resultType') === 'context' && item.get('contextItemId')) {
        const fullResult = result.get?.('fullResult');
        const rawCtxData = fullResult?.get?.('data');
        itemData = {
          id: item.get('contextItemId'),
          type: result.get?.('itemType') || 'unknown',
          data: rawCtxData?.toJSON ? rawCtxData.toJSON() : (rawCtxData || {})
        };
      }
    }
    if (!itemData) continue;
    try {
      const contextItem = contextItemRegistry.createItem(itemData, mt.conversation._session, mt.conversation, mt);
      if (contextItem) {
        contextItem.onContentChange = () => {
          handleContextItemContentChanged(mt, contextItem.id, contextItem);
        };
        contextItems.push(contextItem);
      }
    } catch {
      // Ignore context items that fail to load
    }
  }
  contextItems.sort((a, b) => {
    const aUndeletable = /** @type {any} */ (a).preventUserDeletion?.() || false;
    const bUndeletable = /** @type {any} */ (b).preventUserDeletion?.() || false;
    return (bUndeletable ? 1 : 0) - (aUndeletable ? 1 : 0);
  });
  return contextItems;
}

/**
 * @param {any} mt
 * @param {string} itemId
 * @returns {import('juggler/context-item').default|undefined} Context item instance
 */
export function getContextItem(mt, itemId) {
  for (const item of mt.items) {
    /** @type {any} */
    let itemData = null;

    if (item.get('itemId') === itemId && !item.get('toolUseId')) {
      const rawData = item.get('data');
      itemData = {
        id: itemId,
        type: item.get('type') || 'unknown',
        data: rawData?.toJSON ? rawData.toJSON() : (rawData || {})
      };
    } else if (item.get('type') === 'tool-action' && item.get('contextItemId') === itemId) {
      const result = item.get('result');
      if (result?.get?.('resultType') === 'context') {
        const fullResult = result.get?.('fullResult');
        const rawCtxData = fullResult?.get?.('data');
        itemData = {
          id: itemId,
          type: result.get?.('itemType') || 'unknown',
          data: rawCtxData?.toJSON ? rawCtxData.toJSON() : (rawCtxData || {})
        };
      }
    }

    if (!itemData) continue;

    try {
      const contextItem = contextItemRegistry.createItem(itemData, mt.conversation._session, mt.conversation, mt);
      if (contextItem) {
        contextItem.onContentChange = () => {
          handleContextItemContentChanged(mt, contextItem.id, contextItem);
        };
        return contextItem;
      }
    } catch {
      // Ignore context items that fail to load
    }
  }
  return undefined;
}

/**
 * @param {any} mt
 * @param {import('juggler/context-item').default} contextItem
 */
export function addContextItem(mt, contextItem) {
  if (!contextItem || typeof contextItem.toJSON !== 'function') {
    console.error(`[ESSENTIAL] [MessageThread] Attempted to add invalid context item: ${JSON.stringify(contextItem)}`);
    throw new Error('Cannot add context item: not a valid ContextItem instance');
  }
  const itemJSON = contextItem.toJSON();
  const items = mt.items;
  const existingIndex = items.findIndex(
    (/** @type {any} */ item) => item.get('itemId') === contextItem.id
  );
  if (existingIndex >= 0) {
    const ymap = items[existingIndex];
    mt.conversation._doc.doc.transact(() => {
      ymap.set('type', itemJSON.type);
      if (itemJSON.data !== undefined) ymap.set('data', convertToYType(itemJSON.data));
    }, mt.conversation._doc.authorId);
  } else {
    const newMsg = createContextItemMessage({
      itemId: contextItem.id,
      isNew: true,
      itemType: itemJSON.type,
      data: itemJSON.data
    });
    mt.insertAt(mt.length, plainToYMap(newMsg));
  }
}

/**
 * @param {any} mt
 * @param {string} itemId
 */
export function removeContextItem(mt, itemId) {
  const contextItem = getContextItem(mt, itemId);
  if (!contextItem) {
    throw new Error(`Context item not found: ${itemId}`);
  }
  if (contextItem.preventUserDeletion()) {
    throw new Error(`Cannot delete context item: ${contextItem.type}`);
  }
  // User-deleting a context item is its own logical undo step. Force a
  // fresh undo group on the worker so undo doesn't unexpectedly reverse
  // an unrelated mutation that happened in the prior capture window.
  workerManager.stopUndoCapturing(mt.conversation.id);
  const itemIndex = mt.findIndexByItemId(itemId);
  if (itemIndex >= 0) {
    mt.conversation._doc.doc.transact(() => {
      mt.deleteAt(itemIndex);
    }, mt.conversation._doc.authorId);
  }
  if (contextItem.destroy) {
    contextItem.destroy();
  }
}

/**
 * @param {any} mt
 */
export function clearContextItems(mt) {
  const contextItems = getContextItems(mt);
  for (const item of contextItems) {
    if (item.destroy) {
      item.destroy();
    }
  }
  const items = mt.items;
  /** @type {number[]} */
  const itemIndices = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].get('itemId') && !items[i].get('toolUseId')) {
      itemIndices.push(i);
    }
  }
  mt.conversation._doc.doc.transact(() => {
    for (let i = itemIndices.length - 1; i >= 0; i--) {
      mt.deleteAt(itemIndices[i]);
    }
  }, mt.conversation._doc.authorId);
}

/**
 * @param {any} mt
 * @param {string} itemId
 * @param {{data?: object}} updates
 */
export function updateContextItem(mt, itemId, updates) {
  const ymap = mt.findByItemId(itemId);
  if (!ymap) return;
  mt.conversation._doc.doc.transact(() => {
    if (updates.data !== undefined) {
      const existingData = ymap.get('data');
      const existingPlain = existingData?.toJSON ? existingData.toJSON() : (existingData || {});
      const mergedData = { ...existingPlain, ...updates.data };
      ymap.set('data', convertToYType(mergedData));
    }
  }, mt.conversation._doc.authorId);
}

/**
 * @param {any} mt
 * @param {string} itemTypeId
 * @param {Record<string, any>} params
 * @param {object} [options]
 * @returns {Promise<{id: string|null, type: string, created: boolean, error?: string}>} Result
 */
export async function executeContextItem(mt, itemTypeId, params, options) {
  const { executeContextItem: exec } = await import('../services/context-item-utilities.js');
  return exec(mt, mt.conversation, itemTypeId, params, options);
}

/**
 * @param {any} mt
 * @param {string} itemId
 * @returns {Promise<void>}
 */
export async function refreshContextItem(mt, itemId) {
  const { refreshContextItem: refresh } = await import('../services/context-item-utilities.js');
  return refresh(mt, mt.conversation, itemId);
}

/**
 * The single factory for the SYSTEM_1 system-prompt placeholder message — one
 * source of truth for its shape, shared by every thread-initialization path.
 * @returns {object} Plain context-item message for SYSTEM_1
 */
export function createSystemPromptPlaceholder() {
  return createContextItemMessage({
    itemId: 'SYSTEM_1',
    isNew: false,
    itemType: 'system-prompt',
    data: { text: '', selectedPresetId: 'default', isModified: false },
    preventUserDeletion: true
  });
}

/**
 * Compose the ordered list of items a newly-created SUB-THREAD should be seeded
 * with — just the caller-supplied `initialItems`, nothing built-in.
 *
 * A sub-thread does NOT own a system-prompt placeholder: the worker always
 * assembles the system prompt from the ROOT thread's context items
 * (session-worker-callbacks.js), so a per-sub-thread SYSTEM_1 was never read and
 * only diverged from the LLM/orchestrator creation path (the Go worker's
 * insertThreadCore, which seeds nothing). Only the root thread carries SYSTEM_1
 * (see initBuiltInContextItems / ensureSystemPromptPlaceholder). This helper is
 * kept as the single seam JS thread-creation routes through, even though it is
 * now a pass-through, so a future built-in seed has one home.
 * @param {{initialItems?: object[]}} [opts]
 * @returns {object[]} Plain messages to insert into the new thread, in order
 */
export function buildThreadInitialItems({ initialItems = [] } = {}) {
  return [...initialItems];
}

/**
 * Initialize built-in context items (system prompt). Called once by the
 * creating client on new conversation creation.
 * @param {any} mt
 */
export function initBuiltInContextItems(mt) {
  mt.insertAt(0, plainToYMap(createSystemPromptPlaceholder()));
  mt._systemPromptPlaceholderEnsured = true;
}

/**
 * Ensure the root system-prompt placeholder exists. Used only by the creating
 * client's new-conversation flow (no-op if SYSTEM_1 is already present). Sub-
 * threads do NOT use this — they are seeded atomically at creation.
 * @param {any} mt
 */
export function ensureSystemPromptPlaceholder(mt) {
  if (mt._systemPromptPlaceholderEnsured) return;
  mt._systemPromptPlaceholderEnsured = true;
  if (!mt.findByItemId('SYSTEM_1')) {
    mt.insertAt(0, plainToYMap(createSystemPromptPlaceholder()));
  }
}

/**
 * @param {any} mt
 * @param {string} itemId
 * @param {import('juggler/context-item').default} [changedItem]
 * @returns {Promise<void>}
 */
export async function handleContextItemContentChanged(mt, itemId, changedItem) {
  const { handleContextItemContentChanged: handle } = await import('../services/context-item-utilities.js');
  return handle(mt, mt.conversation, itemId, changedItem);
}

/**
 * @param {any} mt
 * @returns {Promise<Set<string>>} Set of new context item IDs
 */
export async function refreshContextItemsAndDetectChanges(mt) {
  const { refreshContextItemsAndDetectChanges: refresh } = await import('../services/context-item-utilities.js');
  return refresh(mt);
}
