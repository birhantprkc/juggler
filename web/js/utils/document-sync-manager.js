//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * DocumentSyncManager - Unified manager for Yjs document sync
 *
 * Consolidates all Yjs sync concerns into one place:
 * - Y.Doc lifecycle
 * - Bidirectional sync protocol
 * - State persistence
 *
 * This class is DATA-MODEL AGNOSTIC - it knows nothing about conversations,
 * items, context items, etc. It just manages Yjs documents.
 *
 * Usage:
 *   const syncManager = new DocumentSyncManager(doc);
 *   syncManager.initializeAsClient();
 */

import * as Y from '../vendor/yjs.mjs';
import { YJS_SYNC_BATCH_MS } from './constants.js';

/**
 * Origin sentinel for Yjs transactions whose writes are pure derivations of
 * already-undoable state (e.g. the engine's tool-action reducer writing
 * PENDING / approvalOptions / displayData in response to observing an
 * inserted tool-action). The sync manager forwards this marker to the
 * broadcast callback so the transport can flag the outgoing update; the
 * worker then applies it with a non-tracked origin and the UndoManager
 * skips it. Without this, every undo would pop only the most recent
 * derivation and the engine would immediately re-derive — making undo a
 * visible no-op.
 * @type {string}
 */
export const ENGINE_DERIVED_ORIGIN = 'engine-derived';

/**
 * @typedef {(bytes: Uint8Array, opts?: {engineDerived?: boolean}) => void} SyncBroadcastCallback
 */

class DocumentSyncManager {
  /**
   * Create a new document sync manager
   * @param {import('yjs').Doc} doc - The Y.Doc to manage
   */
  constructor(doc) {
    /** @type {import('yjs').Doc} */
    this.doc = doc;

    /** @type {boolean} */
    this._connected = false;

    /** @type {boolean} */
    this._initialized = false;

    // Callbacks
    /** @type {SyncBroadcastCallback|null} */
    this.onSyncBroadcast = null;

    // Batching state for incoming updates
    /** @type {Uint8Array[]} */
    this._pendingUpdates = [];

    /** @type {number|null} */
    this._batchTimer = null;

    // Update handler for sync (bound to preserve 'this')
    /** @type {(update: Uint8Array, origin: any) => void} */
    this._updateHandler = (update, origin) => {
      // Don't broadcast updates that came from remote (avoid echo)
      if (origin !== this && this.onSyncBroadcast) {
        const engineDerived = origin === ENGINE_DERIVED_ORIGIN;
        this.onSyncBroadcast(update, engineDerived ? { engineDerived: true } : undefined);
      }
    };
  }

  /**
   * Initialize as client (sync only)
   * Does NOT connect immediately - call activateSync() when ready
   */
  initializeAsClient() {
    if (this._initialized) {
      throw new Error('[DocumentSyncManager] Already initialized');
    }
    this._initialized = true;
  }

  /**
   * Activate sync (client side, after worker is ready). Idempotent.
   *
   * `broadcastInitialState` defaults to true: encode the doc state and
   * ship it to the worker, picking up any local additions the browser
   * made before activation (e.g. a newly-created conv's system prompt or
   * AI-assistant context items). For conversations loaded from disk the
   * worker already has the full state, so pass false to skip the encode
   * + charCodeAt/btoa broadcast — it can block the main thread for
   * hundreds of ms on large docs.
   * @param {{ broadcastInitialState?: boolean }} [opts]
   */
  activateSync({ broadcastInitialState = true } = {}) {
    if (this._connected) return;
    this.doc.on('update', this._updateHandler);
    this._connected = true;
    if (broadcastInitialState && this.onSyncBroadcast) {
      this.onSyncBroadcast(Y.encodeStateAsUpdate(this.doc));
    }
  }

  /**
   * Apply a sync update from remote
   * Batches rapid updates to reduce main thread blocking during streaming
   * @param {Uint8Array} update - The update bytes to apply
   */
  applySyncUpdate(update) {
    this._pendingUpdates.push(update);

    if (this._batchTimer === null) {
      // Bare setTimeout/clearTimeout are globals in both the window and a
      // module worker; window.* would throw off the main thread.
      this._batchTimer = setTimeout(() => {
        this._applyBatchedUpdates();
      }, YJS_SYNC_BATCH_MS);
    }
  }

  /**
   * Flush all pending updates immediately (synchronously)
   * Use this before reading state that depends on recently received updates
   */
  flushPendingUpdates() {
    if (this._batchTimer !== null) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._applyBatchedUpdates();
  }

  /**
   * Apply all pending updates as a single merged update
   * @private
   */
  _applyBatchedUpdates() {
    this._batchTimer = null;

    if (this._pendingUpdates.length === 0) {
      return;
    }

    const updates = this._pendingUpdates;
    this._pendingUpdates = [];

    // Merge all pending updates into one to reduce deserialization overhead
    const merged = Y.mergeUpdates(updates);

    // Apply once with 'this' as origin to prevent echo
    Y.applyUpdate(this.doc, merged, this);
  }

  // ========================================================================
  // LIFECYCLE
  // ========================================================================

  /**
   * Check if sync is active
   * @returns {boolean} True if sync is active
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Destroy the manager and cleanup resources
   */
  destroy() {
    // Apply any pending updates before destroying
    if (this._batchTimer !== null) {
      clearTimeout(this._batchTimer);
      this._applyBatchedUpdates();
    }

    // Stop listening to updates
    if (this._connected) {
      this.doc.off('update', this._updateHandler);
      this._connected = false;
    }

    // Clear callbacks
    this.onSyncBroadcast = null;

    this._initialized = false;
  }
}

export default DocumentSyncManager;
