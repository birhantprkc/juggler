//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import ResponseHandler from '../services/response-handler.js';
import wsService from '../services/websocket.js';
import providersCache from '../services/providers-cache.js';
import recentModels from '../services/recent-models.js';
import { AbortError } from 'juggler/strategy-type';
import ConversationDocument from './conversation-document.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import workerManager from '../services/worker-manager.js';
import toolExecutor from '../services/tool-executor.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import MessageThread from './message-thread.js';
import { plainToYMap } from './item-accessor.js';
import strategyRegistry from '../registries/strategy-registry.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { TURN_CANCELLED_NOTICE } from '../utils/constants.js';
import {
  findThreadForArray,
  findParentInArray,
  walkThreads,
  findItemByIdRecursive,
  hasUnsettledToolInTree,
  hasPendingApprovalInTree
} from './thread-navigation.js';
import {
  saveAutoApprovalPermission,
} from './conversation-tool-actions.js';
import { setupYjsObservers } from './conversation-observers.js';
import { CONVERSATION_RULES_KEY, CONVERSATION_PATHS_KEY } from './message-thread-permissions.js';
import {
  waitForApproval as orchestrationWaitForApproval,
  continueThread as orchestrationContinueThread,
} from './conversation-orchestration.js';

/**
 * Cancel-settle poll interval: how often _waitForCancellation re-checks
 * whether the worker and local actions have gone idle.
 */
const CANCEL_POLL_MS = 16;

/**
 * Hard ceiling on the cancel-settle wait so a wedged worker doesn't hang
 * the UI forever. Cancel + idle normally completes in <100ms.
 */
const CANCEL_CEILING_MS = 5000;

/**
 * @typedef {import('./session.js').default} Session
 */

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * Model configuration: a concrete (provider, model) pair.
 * @typedef {object} ModelConfig
 * @property {string} [provider] - Provider name (e.g., 'anthropic', 'openai', 'google')
 * @property {string} [model] - Model identifier (e.g., 'claude-sonnet-4-20250514')
 * @property {string} [thinking] - Optional canonical thinking level ('off'|'low'|'medium'|'high'|'max'); absent ⇒ provider default. Inherits atomically with the model down the thread tree.
 */

/**
 * Execute permission pattern entry
 * @typedef {object} ExecutePermissionPattern
 * @property {string} pattern - The pattern string (e.g., 'npm *', 'git *')
 * @property {boolean} enabled - Whether this pattern is currently enabled
 */

/**
 * Conversation permissions configuration
 * @typedef {object} ConversationPermissions
 * @property {boolean} writeFile - Whether file writes are auto-approved
 * @property {ExecutePermissionPattern[]} execute - Shell command patterns that are auto-approved
 */

/**
 * Conversation - Represents a single conversation thread
 *
 * Each conversation owns its own ResponseHandler to ensure complete
 * isolation between concurrent conversations.
 *
 * ARCHITECTURE:
 * - conversation.items[] is the single source of truth (messages + transaction markers)
 * - Transaction markers are embedded in the list when LLM calls complete
 * - getMessages() and getTransactions() filter items[] to return each type
 * - Streaming and tool execution are managed directly by the Conversation class
 * - ResponseHandler processes tool calls and manages the agentic loop
 * @class
 */

class Conversation {
  /**
   * @param {string} id - Unique conversation ID
   * @param {string} name - Display name
   * @param {Session} session - Parent session
   * @param {object} services - Required services
   * @param {import('../services/llm-state.js').default} services.llmState
   * @param {import('../services/action-executor.js').default} services.actionExecutor - Action executor for cancellation
   * @param {import('../services/websocket.js').default} services.wsService - WebSocket service for cancellation
   * @param {object} [options] - Optional configuration
   * @param {boolean} [options.isTransient=false] - If true, conversation won't be persisted to backend
   * @param {string} [options.strategyId] - Strategy ID to use (defaults to 'default')
   * @param {boolean} [options.skipBuiltInContextItems=false] - If true, skip initializing built-in context items (for loaded conversations)
   * @param {'unloaded'|'loading'|'loaded'|'error'} [options.loadState='loaded'] - Initial lazy-load lifecycle state. Stubs created during session bootstrap pass 'unloaded'; freshly-created conversations default to 'loaded'.
   */
  constructor(id, name, session, services, options = {}) {
    // Identity
    /** @type {string} */
    this.id = id;

    /** @type {Session} */
    this._session = session;

    // Seed the session's name cache so `this.name` (a getter) resolves
    // for newly-created conversations before the next GET /api/session
    // refresh. The on-disk folder name (resolved server-side by
    // ScanConvDirs and shipped as `conversationNames`) is the source of
    // truth; this cache is its in-memory projection.
    if (name && session && !session.getConversationName(id)) {
      session.setConversationName(id, name);
    }

    /** @type {string} */
    this.created = new Date().toISOString();

    /** @type {boolean} - If true, this conversation is not persisted to backend */
    this._isTransient = options.isTransient || false;

    /** @type {'unloaded'|'loading'|'loaded'|'error'} @private - per-client lazy-load state, not Yjs */
    this._loadState = options.loadState || 'loaded';

    // Data - all state lives in Yjs document (use getters/setters for access)
    /** @type {ConversationDocument} - Yjs document for main thread (source of truth for conversation state) */
    this._doc = new ConversationDocument(id, 'user:main');

    /** @type {MessageThread} - Root message thread (operates on _doc.root) */
    this._rootMessageThread = new MessageThread(this, this._doc.root, null, options.strategyId);


    /** @type {Set<string>} @private - Tool-actions with handleNewToolAction in flight */
    this._handlingNewToolAction = new Set();

    /** @type {boolean} @private - Flag to prevent observers from firing during construction */
    this._initializing = true;

    // Initialize document as client (no UndoManager, sync only)
    // and set up Yjs observers
    this._setupYjsObservers();

    // LLM call state
    /** @type {number} - Current iteration in agentic loop */
    this._iterationCount = 0;

    // Permission system - controls auto-approval of actions.
    // permissions is a getter that reads from Yjs metadata (no stored field).

    // Services
    /** @type {import('../services/llm-state.js').default} */
    this._llmState = services.llmState;

    /** @type {import('../services/action-executor.js').default} @private */
    this._actionExecutor = services.actionExecutor;

    /** @type {import('../services/websocket.js').default} @private */
    this._wsService = services.wsService;

    /** @type {HTMLElementTagNameMap['conversation-area']|null} */
    this._conversationArea = null; // Will be set via setTabElement()

    /** @type {import('../components/conversation-tab.js').default|null} @private */
    this._tabElement = null;

    // Each conversation owns its own ResponseHandler so streaming state
    // can't bleed across conversations.

    /** @type {ResponseHandler} */
    this._responseHandler = new ResponseHandler({
      conversation: this
    });

    // State change listeners for event-based approval waiting
    // Transient (not persisted) - used to wake up waitForApproval() callers
    /** @type {Set<() => void>} @private */
    this._stateChangeListeners = new Set();

    // Yjs observers for automatic event emission (stored for cleanup)
    /** @type {((events: any[], transaction: any) => void)|null} @private */
    this._yjsItemsObserver = null;
    /** @type {((event: any) => void)|null} @private */
    this._yjsMetadataObserver = null;

    /** @type {boolean} @private - Guard flag to prevent recursive observer calls */
    this._inItemsObserver = false;

    // Initialize built-in context items (system prompt)
    // Skip for loaded conversations - items come from worker Yjs sync
    if (!options.skipBuiltInContextItems) {
      this._initBuiltInContextItems();
    }

    // Mark initialization as complete - observers can now fire
    this._initializing = false;
  }

  // ========================================================================
  // YJS OBSERVERS AND SYNCHRONIZATION
  // ========================================================================
  // Observer wiring lives in conversation-observers.js. The factory below
  // installs items + metadata observers on c._doc and returns a cleanup
  // function. The class stores the returned cleanup as _yjsCleanup.

  _setupYjsObservers() {
    this._yjsCleanup = setupYjsObservers(this);
  }


  /**
   * Save auto-approval permission for a 'yes-always' response.
   * @param {any} ymap - The tool-action Y.Map
   * @param {import('./message-thread.js').default} messageThread
   */
  _saveAutoApprovalPermission(ymap, messageThread) {
    saveAutoApprovalPermission(this, ymap, messageThread);
  }



  // ── Thread Navigation (thin wrappers around thread-navigation.js) ──

  /**
   * Resolve which MessageThread contains a given Y.Map item.
   * @param {*} ymap - The Y.Map item
   * @returns {MessageThread} The matching message thread
   */
  _resolveMessageThreadForMap(ymap) {
    const parent = ymap?.parent;
    return parent ? this._resolveMessageThreadForArray(parent) : this._rootMessageThread;
  }

  /**
   * Resolve which MessageThread owns the given Y.Array.
   * @param {*} yarray - The Y.Array that fired the event
   * @returns {MessageThread} The matching message thread
   */
  _resolveMessageThreadForArray(yarray) {
    const rootArr = this._doc.root.get('items');
    if (yarray === rootArr) return this._rootMessageThread;
    const found = findThreadForArray(rootArr, yarray);
    if (found) return new MessageThread(this, found, found.get('itemId'));
    return this._rootMessageThread;
  }

  /**
   * Find the parent thread's Y.Map for a given threadItemId.
   * @param {string} threadItemId - Thread item ID
   * @returns {*|null} The parent thread Y.Map, or null if at root
   */
  findParentContainer(threadItemId) {
    return findParentInArray(this._rootMessageThread.yarray, threadItemId);
  }

  /**
   * Get all MessageThread instances: root + nested threads.
   * @returns {MessageThread[]} All message threads
   */
  getAllMessageThreads() {
    /** @type {MessageThread[]} */
    const threads = [this._rootMessageThread];
    this._forEachThreadContext(thread => threads.push(thread));
    return threads;
  }

  /**
   * Walk all thread contexts, calling callback for each.
   * @param {(thread: MessageThread) => void} callback
   * @private
   */
  _forEachThreadContext(callback) {
    walkThreads(this._rootMessageThread.items, (threadYMap) => {
      callback(new MessageThread(this, threadYMap, threadYMap.get('itemId')));
    });
  }

  /**
   * Find an item by itemId across the entire thread tree.
   * @param {string} id - Item ID to find
   * @returns {*|null} Y.Map or null
   */
  findItemById(id) {
    return findItemByIdRecursive(this._rootMessageThread.items, id);
  }

  /**
   * Resolve the MessageThread for a given threadItemId.
   * @param {string|null|undefined} threadItemId - Thread item ID, or null/undefined for root
   * @returns {MessageThread} The matching message thread
   */
  resolveMessageThread(threadItemId) {
    if (!threadItemId) {
      return this._rootMessageThread;
    }
    const threadItem = this.findItemById(threadItemId);
    if (threadItem && threadItem.get('type') === 'thread') {
      return new MessageThread(this, threadItem, threadItemId);
    }
    throw new Error(`[BUG] Thread item not found: ${threadItemId}`);
  }

  /**
   * Find the MessageThread that contains a tool-action with the given toolUseId.
   * Searches root items, then thread items.
   * @param {string} toolUseId
   * @returns {MessageThread|null} The MessageThread containing the tool-action, or null
   */
  findMessageThreadForToolUse(toolUseId) {
    // Check root items
    for (const item of this._rootMessageThread.items) {
      if (item.get('type') === 'tool-action' && item.get('toolUseId') === toolUseId) {
        return this._rootMessageThread;
      }
    }
    // Search all threads recursively
    /** @type {MessageThread|null} */
    let found = null;
    this._forEachThreadContext(thread => {
      if (found) return;
      for (const item of thread.items) {
        if (item.get('type') === 'tool-action' && item.get('toolUseId') === toolUseId) {
          found = thread;
          return;
        }
      }
    });
    return found;
  }

  /**
   * Whether this conversation has any content. A conversation has content
   * once any item has been stamped with a transactionId (i.e. at least one
   * LLM round-trip has run).
   * @returns {boolean} True if conversation has at least one stamped item
   */
  hasContent() {
    for (const item of this._rootMessageThread.items) {
      if (item.get?.('transactionId')) return true;
    }
    return false;
  }

  /**
   * Whether this conversation has a first root user message the auto-namer can
   * derive a conversation title from. Mirrors the worker's `firstRootUserMessageText`:
   * the first root-level user item, non-empty once its text is trimmed. False
   * for a freshly created tab with no messages yet (or an image-only first
   * message), so callers can hide the "auto-name now" control when it would be
   * a no-op.
   * @returns {boolean} True if there is a non-empty first user message.
   */
  hasAutoNameSource() {
    for (const item of this._rootMessageThread.items) {
      if (item.get?.('type') === 'user') {
        return (item.get?.('content') || '').trim() !== '';
      }
    }
    return false;
  }

  /**
   * Read-only accessor for the root items array.
   * Used for rendering bootstrap (e.g., connection-manager on reconnect).
   * @returns {Array<any>} Root items array
   */
  get rootItems() {
    return this._rootMessageThread.items;
  }

  /**
   * Human-readable conversation name. Derived from the session-level
   * `_conversationNames` cache, which mirrors the on-disk folder name
   * shipped by GET /api/session.
   * @returns {string} Current display name, or '' if not yet known.
   */
  get name() {
    return this._session ? this._session.getConversationName(this.id) : '';
  }

  /**
   * The current model config, read from Yjs metadata via the root message thread.
   * @returns {any} The model config object
   */
  get modelConfig() {
    return this._rootMessageThread.modelConfig;
  }

  /**
   * The root MessageThread for this conversation.
   * @returns {import('./message-thread.js').default} The root message thread
   */
  get rootMessageThread() {
    return this._rootMessageThread;
  }

  /**
   * Get config data needed to initialize a worker.
   * @returns {{modelConfig: any, currentStrategyId: string, permissionRules: any[], allowedPaths: string[]}} Worker init data
   */
  getWorkerInitData() {
    return {
      modelConfig: this._rootMessageThread.modelConfig || null,
      currentStrategyId: this._rootMessageThread.currentStrategyId,
      permissionRules: this._rootMessageThread.getAllRules(),
      allowedPaths: this._rootMessageThread.getAllowedPaths()
    };
  }

  /**
   * Restore strategy from worker-loaded metadata.
   * @param {string} strategyId
   */
  restoreStrategyFromWorker(strategyId) {
    // The metadata observer handles strategy instance creation.
    // This just ensures the in-memory state is consistent during
    // initial load when metadata is applied via worker sync.
    const root = this._rootMessageThread;
    if (strategyId && strategyId !== root.currentStrategyId) {
      root.currentStrategyId = strategyId;
      root.strategy = strategyRegistry.createStrategy(strategyId, root);
    }
  }

  /**
   * Restore metadata from worker-loaded conversation.
   *
   * IMPORTANT: do NOT write modelConfig back to Yjs here. The worker just
   * loaded its doc from disk and is broadcasting that state via yjs-sync;
   * by the time _doLoadExisting calls this, the local doc already has the
   * worker's modelConfig (flushPendingUpdates was just called). Writing it
   * again produces a redundant Yjs update that RACES against concurrent
   * writers (e.g. the test iframe doing `set-model` at the same moment
   * another iframe is auto-loading the same conv). The tape showed this:
   * a sibling iframe's auto-load wrote modelConfig back, overwriting a
   * concurrent set-model in `duplicate-conversation-basic` and producing
   * the wrong modelConfig on the duplicate. yjs-sync delivers the
   * authoritative value; no JS-side write needed.
   * @param {{modelConfig?: any, currentStrategyId?: string}} metadata
   */
  restoreWorkerMetadata(metadata) {
    if (metadata.currentStrategyId) {
      this.restoreStrategyFromWorker(metadata.currentStrategyId);
    }
  }

  /**
   * Clear all history across the entire conversation (root context).
   * Used for conversation-wide reset (e.g., /clear command without a worker).
   */
  clearAllHistory() {
    this._rootMessageThread.clearHistory();
  }

  /**
   * Delete items from fromIndex to end with full orchestration:
   * cancels pending approvals, stops processing, and clears next steps.
   *
   * Intentionally does NOT call `cancelAndSettle()` — that would also
   * cancel any in-flight tool actions, but rerun/edit flows orchestrate
   * an action *immediately after* this delete and would have it cancelled
   * out from under them. Only the LLM turn is stopped here; deletion of
   * specific items is the caller's contract.
   * @param {import('./message-thread.js').default} messageThread
   * @param {number} fromIndex
   */
  deleteRangeWithCleanup(messageThread, fromIndex) {
    messageThread.cancelPendingApprovals();

    if (this._llmState &&
            this._llmState.isConversationProcessing(this.id)) {
      this.stopProcessing();
    }

    messageThread.deleteRange(fromIndex);
  }

  /**
   * Cancel all pending approvals across root and all threads.
   */
  cancelAllPendingApprovals() {
    // Cancel in root and all threads recursively
    this._rootMessageThread.cancelPendingApprovals();
    this._forEachThreadContext(thread => thread.cancelPendingApprovals());
  }


  // =========================================================================
  // Strategy/LLM Orchestration — delegates to ./conversation-orchestration.js
  // =========================================================================

  /**
   * @param {import('./message-thread.js').default} mt
   * @param {string} toolUseId
   * @returns {Promise<string>} 'yes', 'no', 'yes-always', or 'cancel'
   */
  async waitForApproval(mt, toolUseId) { return orchestrationWaitForApproval(this, mt, toolUseId); }

  /**
   * @param {import('./message-thread.js').default} mt
   * @returns {Promise<void>} Resolves when continuation has been dispatched
   */
  async continueThread(mt) { return orchestrationContinueThread(this, mt); }

  /** @private */
  _initBuiltInContextItems() {
    this._rootMessageThread.initBuiltInContextItems();
  }

  /**
   * Get whether this conversation is currently processing
   * @returns {boolean} Whether conversation is currently processing
   */
  get isProcessing() {
    return this._llmState.isConversationProcessing(this.id);
  }

  // ========================================================================
  // BASIC GETTERS AND STATE ACCESS
  // ========================================================================

  /**
   * Get parent session
   * @returns {Session} Parent session instance
   */
  get session() {
    return this._session;
  }

  /**
   * Lazy-load lifecycle state (per-client view state, not Yjs).
   * @returns {'unloaded'|'loading'|'loaded'|'error'} Current state in the lazy-load FSM
   */
  get loadState() {
    return this._loadState;
  }

  /**
   * Current worker processing state from the Yjs doc metadata.
   * Includes `activity` ('' | 'calling_llm' | 'awaiting_llm'), `status`, and
   * `politePending` (true while a Pause latch is set on a busy frame — the
   * server-authoritative source for the "Pausing…" cue across reloads).
   * Read-only — the worker is the sole writer.
   * @returns {{activity?: string, status?: string, [key: string]: unknown} | undefined} Plain object snapshot of the worker's processingState, or undefined when nothing has been written yet
   */
  get processingState() {
    if (!this._doc) return undefined;
    const raw = this._doc.metadata.get('processingState');
    if (!raw) return undefined;
    return raw.toJSON ? raw.toJSON() : raw;
  }

  /**
   * Monotonic count of worker turns that have completed (reached idle). The
   * worker bumps it atomically on every idle transition (see
   * cmd/juggler/worker/worker.go sendStatus), so it is a durable fence that
   * survives Yjs sync batching: even when a fast turn's busy→idle window
   * coalesces into a single broadcast, this value still advances. Observe
   * *this* to detect "a turn happened" — never the transient `status` edge,
   * which can be batched away entirely.
   * @returns {number} Completed-turn count (0 before the worker first idles)
   */
  get completedTurns() {
    return Number(this._doc?.metadata.get('completedTurns')) || 0;
  }

  /**
   * Transition the lazy-load lifecycle and notify the session so listeners
   * (tab bar, conversation panel) can re-render. No-op when the state is
   * unchanged.
   * @param {'unloaded'|'loading'|'loaded'|'error'} state
   */
  setLoadState(state) {
    if (this._loadState === state) return;
    this._loadState = state;
    this._session?.notifyConversationChange?.('conversation:loadstate-changed', {
      conversationId: this.id,
      loadState: state
    });
  }

  /**
   * Set the tab element that owns this conversation
   * IMPORTANT: This is the ONLY way a conversation gets access to its DOM elements
   * @param {import('../components/conversation-tab.js').default} tabElement
   */
  setTabElement(tabElement) {
    this._tabElement = tabElement;

    // Update conversation area reference to use tab's conversation area
    const conversationArea = /** @type {HTMLElementTagNameMap['conversation-area']|null} */ (tabElement.getConversationArea());
    if (conversationArea) {
      this._conversationArea = conversationArea;
      conversationArea.conversation = this;
    }

    // Register tab with LLM state for per-conversation busy indicators
    this._llmState.registerConversationTab(this.id, tabElement);
  }

  /**
   * Get the tab element for this conversation
   * @returns {import('../components/conversation-tab.js').default|null} Tab element or null
   */
  getTabElement() {
    return this._tabElement;
  }

  /**
   * Get the composer element for this conversation
   * @returns {HTMLElement|null} Composer element or null
   *     */
  _getComposer() {
    if (!this._tabElement) {
      return null;
    }
    return this._tabElement.getComposer();
  }

  /**
   * The thread-item id an composer is currently bound to (null for root),
   * or null when there is no box.
   * @param {any} composer
   * @returns {string|null} The bound thread-item id, or null.
   * @private
   */
  _composerThreadId(composer) {
    return (composer && 'threadItemId' in composer) ? (composer.threadItemId ?? null) : null;
  }

  /**
   * The thread-item id a send is targeting (null for root), taking the
   * MessageThread when given and falling back to the explicit id.
   * @param {import('./message-thread.js').MessageThread|null|undefined} messageThread
   * @param {string|null} threadItemId
   * @returns {string|null} The targeted thread-item id, or null for root.
   * @private
   */
  _targetThreadId(messageThread, threadItemId) {
    return (messageThread?.threadItemId ?? threadItemId) ?? null;
  }

  // ========== APPROVAL MANAGEMENT ==========

  /**
   * Enable auto-approve mode for headless testing.
   * When enabled, all approval requests are immediately granted.
   * @param {boolean} enabled - Whether to auto-approve all actions
   */
  setAutoApprove(enabled) {
    this._autoApprove = enabled;
  }

  // ========== APPROVAL MANAGEMENT ==========

  /**
   * @returns {Promise<void>} Resolves on next state change
   *     */
  _waitForStateChange() {
    return new Promise(resolve => {
      /** @type {() => void} */
      const listener = () => {
        this._stateChangeListeners.delete(listener);
        resolve();
      };
      this._stateChangeListeners.add(listener);
    });
  }

  _emitStateChange() {
    for (const listener of this._stateChangeListeners) {
      listener();
    }
  }

  /**
   * Re-run a tool action. Resets it locally and re-evaluates immediately.
   * Also tells the worker (for batchCompleteSignal reset if strategy loop is active).
   * @param {string} toolUseId - The tool use to re-run
   */
  async retryToolApproval(toolUseId) {
    // Tools whose result IS the user's input (e.g. AskUserQuestion) must be
    // re-asked on re-run, not silently replayed with the stored answer. Ask
    // the owning plugin which behaviour applies.
    const ActionClass = this._toolActionClass(toolUseId);
    if (ActionClass?.rerunRequiresReprompt?.()) {
      // Re-ask path: worker resets to 'pending' and clears result +
      // approvalResponse so the approval/question UI re-renders. The user's
      // fresh answer then drives execution exactly like a first-time ask.
      workerManager.retryToolApproval(this.id, toolUseId);
      return;
    }
    // Re-run path: worker clears the result (the "has been run" flag) and
    // sets state='approved'. The document change triggers the observer which
    // re-evaluates and re-executes the tool.
    workerManager.retryToolAction(this.id, toolUseId);
  }

  /**
   * Resolve the context-item plugin class that owns a tool-action. Public
   * accessor for UI (e.g. the properties panel gating the Re-run control on
   * {@link ContextItem.isRerunnable}). Delegates to {@link _toolActionClass}.
   * @param {string} toolUseId
   * @returns {any} The plugin class, or undefined if not found
   */
  toolActionClass(toolUseId) {
    return this._toolActionClass(toolUseId);
  }

  /**
   * Resolve the context-item plugin class that owns a tool-action, searching
   * all threads (the tool-action may live in a sub-thread).
   * @param {string} toolUseId
   * @returns {any} The plugin class, or undefined if not found
   * @private
   */
  _toolActionClass(toolUseId) {
    for (const thread of this.getAllMessageThreads()) {
      const toolAction = thread.getToolAction(toolUseId);
      if (toolAction) {
        return contextItemRegistry.getByToolName(toolAction.get('toolName'));
      }
    }
    return undefined;
  }

  // ========================================================================
  // Undo/Redo (Yjs CRDT operations)
  // ========================================================================

  /**
   * Undo the last operation in the conversation
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo() {
    if (!workerManager.isWorkerReady(this.id)) {
      return false;
    }
    const result = await workerManager.undo(this.id);
    // Flush any pending Yjs updates so state is current after undo
    this._doc.flushPendingUpdates();
    return result;
  }

  /**
   * Redo the last undone operation
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo() {
    if (!workerManager.isWorkerReady(this.id)) {
      return false;
    }
    const result = await workerManager.redo(this.id);
    // Flush any pending Yjs updates so state is current after redo
    this._doc.flushPendingUpdates();
    return result;
  }

  /**
   * Check if undo is available - Query worker for undo state
   * @returns {boolean} True if can undo
   */
  canUndo() {
    // Query worker manager for cached undo state
    // Worker is the source of truth for undo (main thread has no UndoManager)
    return workerManager.canUndo(this.id);
  }

  /**
   * Check if redo is available - Query worker for redo state
   * @returns {boolean} True if can redo
   */
  canRedo() {
    // Query worker manager for cached redo state
    // Worker is the source of truth for undo (main thread has no UndoManager)
    return workerManager.canRedo(this.id);
  }

  // ========================================================================
  // Message Editing (Pure Yjs CRDT operations)
  // ========================================================================

  /**
   * Get response handler
   * @returns {ResponseHandler} Response handler instance
   */
  get responseHandler() {
    return this._responseHandler;
  }

  // =========================================================================
  // Metadata Observation API (delegates to _doc)
  // =========================================================================

  /**
   * Observe metadata changes on the conversation document
   * @param {(event: any, transaction: any) => void} callback
   */
  observeMetadata(callback) {
    this._doc.observeMetadata(callback);
  }

  /**
   * Stop observing metadata changes
   * @param {(event: any, transaction: any) => void} callback
   */
  unobserveMetadata(callback) {
    this._doc.unobserveMetadata(callback);
  }

  /**
   * Get a metadata value by key
   * @param {string} key
   * @returns {any} The metadata value
   */
  getMetadata(key) {
    return this._doc.metadata.get(key);
  }

  /**
   * Set a metadata value. Authored under the conversation's authorId.
   * @param {string} key
   * @param {*} value
   */
  setMetadata(key, value) {
    this._doc.setMetadata(key, value);
  }

  /**
   * Get all metadata entries as an iterator
   * @returns {IterableIterator<[string, any]>} Metadata entries
   */
  getMetadataEntries() {
    return this._doc.metadata.entries();
  }

  /**
   * Run a Yjs mutation atomically under the conversation's authorId. The
   * sanctioned entry point for any code outside this class that needs to
   * modify the Yjs document — do not reach through `_doc.doc.transact`.
   * @param {() => void} txFn
   */
  atomicUpdate(txFn) {
    this._doc.doc.transact(txFn, this._doc.authorId);
  }

  /** @returns {string} The authorId this conversation tags its writes with. */
  get authorId() {
    return this._doc.authorId;
  }

  // =========================================================================
  // Thread Transaction API
  // =========================================================================

  /**
   * Stop a single thread's subtree — the one primitive behind every "stop a
   * thread" affordance (parent tile button, an in-thread footer Stop). Settles
   * the thread closed the way MessageThread.close() does:
   * worker truth first, then a result stamp.
   *
   * Crucially, the worker-cancel SCOPE equals the settle TARGET. We preempt the
   * single conversation worker only when this thread's subtree is what it is
   * actually driving — the live processing column is this thread or one of its
   * descendants, or a tool-action in the subtree is awaiting approval
   * (`_threadOwnsActiveWork`). A dormant/queued thread owns no in-flight work,
   * so stopping it must NOT kill whatever unrelated thread the worker is running
   * — we just stamp it closed. (Today only one thread runs at a time; this
   * scoping is also what makes the model correct once threads run in parallel.)
   *
   * When we do preempt: cancelAllPendingApprovals() rejects any browser-side
   * approval dialogs in the subtree, then cancelAndSettle() cancels the in-flight
   * turn (the worker cancels its tools, writing state='cancelled') and waits for
   * the worker to go idle, so a live tool can no longer keep the subtree "busy".
   * Only then do we stamp result='Cancelled' — and only if the thread is still
   * resultless, so an existing real summary is never clobbered. The result makes
   * the thread isThreadClosed (result set AND nothing live), returning the
   * parent's composer.
   * @param {*} threadYMap - The Yjs Y.Map for the thread item
   * @returns {Promise<void>}
   */
  async cancelThread(threadYMap) {
    await this.interruptThread(threadYMap);
    this.atomicUpdate(() => {
      const existing = threadYMap.get('result');
      if (typeof existing !== 'string' || existing.length === 0) {
        threadYMap.set('result', 'Cancelled');
      }
    });
  }

  /**
   * Interrupt a thread's in-flight work WITHOUT closing it: cancel any pending
   * approvals in its subtree and preempt the worker turn it owns, but leave the
   * thread resultless (open). Because an open sub-thread keeps `hasBusyItems`
   * true, its column keeps the composer — so the user can keep interacting with
   * the thread after stopping it.
   *
   * This is the "stop from the thread's own vantage" action: Escape while
   * focused in the sub-thread and the sub-thread's footer Stop both route
   * here. Closing a thread (stamping a
   * 'Cancelled' summary) only happens when it is stopped from its PARENT's
   * vantage — `cancelThread` (the parent tile's Stop) or `closeOpenSubThreads`
   * (a root/parent Escape).
   * @param {*} threadYMap - The thread Y.Map.
   * @returns {Promise<void>}
   */
  async interruptThread(threadYMap) {
    if (this._threadOwnsActiveWork(threadYMap)) {
      this.cancelAllPendingApprovals();
      await this.cancelAndSettle();
    }
  }

  /**
   * Close every open (resultless) sub-thread, stamping each with a 'Cancelled'
   * summary. This is the thread-closing half of a root/parent-vantage stop
   * (Escape while focused on the root, the root footer Stop): the caller has
   * already preempted the worker turn; this settles the sub-threads so they go
   * `isThreadClosed` and the composer returns to the root column. An
   * already-closed thread (non-empty result) is left untouched. Threads at
   * every nesting depth are walked.
   * @returns {void}
   */
  closeOpenSubThreads() {
    /** @type {any[]} */
    const open = [];
    walkThreads(this._rootMessageThread.items, (threadYMap) => {
      const res = threadYMap.get('result');
      if (typeof res !== 'string' || res.length === 0) open.push(threadYMap);
    });
    if (open.length === 0) return;
    this.atomicUpdate(() => {
      for (const t of open) {
        const res = t.get('result');
        if (typeof res !== 'string' || res.length === 0) {
          t.set('result', 'Cancelled');
        }
      }
    });
  }

  /**
   * Whether the conversation worker's current activity belongs to this thread's
   * subtree — i.e. stopping this thread should preempt the worker rather than
   * just stamp it closed. True when (a) a tool-action anywhere in the subtree is
   * awaiting approval, or (b) the live processing column is this thread itself
   * or one of its descendants. False for a dormant/queued thread while an
   * unrelated sibling is the live column: that thread owns no in-flight work.
   * @param {*} threadYMap - The thread Y.Map.
   * @returns {boolean} True if the worker is driving this subtree.
   * @private
   */
  _threadOwnsActiveWork(threadYMap) {
    if (!threadYMap || typeof threadYMap.get !== 'function') return false;
    const items = threadYMap.get('items');
    if (hasPendingApprovalInTree(items)) return true;
    const liveId = this._llmState?.getStatusThreadId(this.id) ?? null;
    if (!liveId) return false;
    if (liveId === threadYMap.get('itemId')) return true;
    return !!(items && findItemByIdRecursive(items.toArray(), liveId));
  }

  /**
   * Interrupt whatever sub-thread is the active processing column, if any.
   *
   * The active column is identified the same way the parent tile is — via the
   * live status' threadId (`llmState.getStatusThreadId`). When that points at a
   * sub-thread, it is INTERRUPTED (`interruptThread`): the worker turn is
   * preempted but the thread stays open, so its column keeps the composer and
   * the user can keep interacting with it. This is the fallback used when the
   * caller doesn't know the focused vantage — a bare Escape interrupts the
   * running child rather than closing it.
   *
   * Must be called BEFORE any llmState.stop()/idle write, since those clear the
   * status threadId. Returns false (caller falls back to the root-turn cancel)
   * when the active column is the root or no thread is processing.
   * @returns {Promise<boolean>} True if a sub-thread was interrupted.
   */
  async cancelActiveTurn() {
    const activeThreadId = this._llmState?.getStatusThreadId(this.id) ?? null;
    if (!activeThreadId) return false;
    const threadItem = this.findItemById(activeThreadId);
    if (!threadItem || threadItem.get?.('type') !== 'thread') return false;
    await this.interruptThread(threadItem);
    return true;
  }

  // =========================================================================
  // Move / copy items primitive
  // =========================================================================
  //
  // The single shape every relocation uses: snapshot via toJSON → rebuild via
  // plainToYMap → insert at destination → (move only) delete from source. The
  // shape /compact already used, generalised so compact, expand-in-place,
  // promote-to-tab and the Move/Copy picker are all thin callers.

  /**
   * Deep-clone a toJSON snapshot, minting a fresh itemId for the node and
   * every descendant so a copy collides with nothing. Uses `minter` (a
   * conversation's _nextItemId) so cross-doc copies live in the dest id space.
   * @param {any} snapshot - Plain object/array/primitive from toJSON.
   * @param {() => string} minter - Fresh-id generator.
   * @returns {any} Re-id'd deep clone.
   * @private
   */
  _remintItemIds(snapshot, minter) {
    if (Array.isArray(snapshot)) {
      return snapshot.map(s => this._remintItemIds(s, minter));
    }
    if (snapshot && typeof snapshot === 'object') {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, v] of Object.entries(snapshot)) {
        out[k] = this._remintItemIds(v, minter);
      }
      if (Object.prototype.hasOwnProperty.call(out, 'itemId')) {
        out.itemId = minter();
      }
      return out;
    }
    return snapshot;
  }

  /**
   * Normalise indices: dedupe, drop out-of-range, sort ascending.
   * @param {number[]} indices
   * @param {number} length
   * @returns {number[]} Cleaned, ascending index list.
   * @private
   */
  _normalizeIndices(indices, length) {
    return [...new Set(indices)]
      .filter(i => Number.isInteger(i) && i >= 0 && i < length)
      .sort((a, b) => a - b);
  }

  /**
   * Move items at `indices` from `source` into `dest` at `position`.
   *
   * Same-doc → ONE atomic, undoable transaction (insert + delete together).
   * Cross-doc is NOT one transaction (undo can't cross docs) and is handled by
   * the promote-to-tab path (step 9); this method throws on a cross-doc call so
   * callers don't silently get a non-atomic move.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Indices in source to move.
   * @param {import('./message-thread.js').default} dest - Destination message thread.
   * @param {number} [position] - Insert index in dest (defaults to end).
   * @returns {number} Count of items moved.
   */
  moveItems(source, indices, dest, position) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return 0;
    if (source.conversation._doc.doc !== dest.conversation._doc.doc) {
      throw new Error('moveItems: cross-doc moves are not atomic — use the promote-to-tab path');
    }
    const snapshots = sorted.map(i => source.items[i].toJSON());
    const insertPos = position ?? dest.length;
    const sameContainer = source.container === dest.container;
    this.atomicUpdate(() => {
      // Delete from source first (descending) so indices stay valid.
      for (let k = sorted.length - 1; k >= 0; k--) source.deleteAt(/** @type {number} */ (sorted[k]));
      // When moving within one container, deletions before the insert point
      // shift it left.
      let pos = insertPos;
      if (sameContainer) {
        pos -= sorted.filter(i => i < insertPos).length;
      }
      const ymaps = snapshots.map(s => plainToYMap(s));
      const arr = dest.ensureYarray();
      arr.insert(Math.max(0, Math.min(pos, arr.length)), ymaps);
    });
    return sorted.length;
  }

  /**
   * Copy items at `indices` from `source` into `dest` at `position`, minting
   * fresh itemIds for every copied node. Same-doc → one atomic transaction.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Indices in source to copy.
   * @param {import('./message-thread.js').default} dest - Destination message thread.
   * @param {number} [position] - Insert index in dest (defaults to end).
   * @returns {number} Count of items copied.
   */
  copyItems(source, indices, dest, position) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return 0;
    if (source.conversation._doc.doc !== dest.conversation._doc.doc) {
      throw new Error('copyItems: cross-doc copies are not atomic — use the promote-to-tab path');
    }
    const minter = () => dest.conversation._nextItemId();
    const snapshots = sorted.map(i => this._remintItemIds(source.items[i].toJSON(), minter));
    const insertPos = position ?? dest.length;
    this.atomicUpdate(() => {
      const ymaps = snapshots.map(s => plainToYMap(s));
      const arr = dest.ensureYarray();
      arr.insert(Math.max(0, Math.min(insertPos, arr.length)), ymaps);
    });
    return sorted.length;
  }

  /**
   * Expand a thread in place: splice its items back into the parent at the
   * thread's index and drop the tile. The inverse of folding a selection into
   * a sub-thread (compact / move-into-thread). Same-doc → ONE atomic, fully
   * undoable transaction.
   *
   * Refuses to expand a thread with live/unsettled work in its subtree (mirror
   * of compact's skip of un-resulted threads) so we never strand a running
   * tool at the parent level.
   * @param {string} threadItemId - The thread to expand.
   * @returns {boolean} True if expanded.
   */
  expandThread(threadItemId) {
    const threadYMap = this.findItemById(threadItemId);
    if (!threadYMap || threadYMap.get?.('type') !== 'thread') return false;
    if (hasUnsettledToolInTree(threadYMap.get('items'))) return false;

    const parentContainer = this.findParentContainer(threadItemId);
    const parentThread = parentContainer
      ? new MessageThread(this, parentContainer, parentContainer.get('itemId'))
      : this._rootMessageThread;
    const idx = parentThread.findIndexByItemId(threadItemId);
    if (idx < 0) return false;

    // Flatten the thread's items into the parent. Drop the thread's own
    // SYSTEM_1 placeholder: every container (root or a parent thread) already
    // owns exactly one, so carrying the child's up would duplicate it. Only the
    // placeholder is stripped — a nested `return_result` stays valid when the
    // parent is itself a sub-thread.
    const nested = threadYMap.get('items');
    const snapshots = (nested?.toArray?.() || [])
      .map((/** @type {any} */ it) => it.toJSON())
      .filter((/** @type {{itemId?: string, type?: string}} */ it) => !(it.itemId === 'SYSTEM_1' || it.type === 'system-prompt'));

    this.atomicUpdate(() => {
      parentThread.deleteAt(idx);
      if (snapshots.length) {
        const ymaps = snapshots.map((/** @type {any} */ s) => plainToYMap(s));
        parentThread.ensureYarray().insert(idx, ymaps);
      }
    });
    return true;
  }

  /**
   * Prepare item snapshots for insertion into a new conversation root. Root-only
   * system-prompt placeholders are omitted because the destination root already
   * owns its SYSTEM_1; every remaining item gets fresh IDs in the destination
   * conversation's id space.
   * @param {any[]} items - Source Y.Map items.
   * @param {Conversation} destConversation - Destination conversation.
   * @returns {any[]} Plain snapshots ready for plainToYMap.
   * @private
   */
  _snapshotsForNewRoot(items, destConversation) {
    return items
      .map((/** @type {any} */ it) => it.toJSON())
      .filter((/** @type {any} */ it) => this._isRootTopLevelItem(it))
      .map((/** @type {any} */ it) => this._remintItemIds(it, () => destConversation._nextItemId()));
  }

  /**
   * Whether a plain item snapshot may live at the TOP LEVEL of a conversation
   * root. Two kinds of item are thread-specific and must be dropped when
   * flattening a sub-thread into a new root:
   *   - The `SYSTEM_1` / `system-prompt` placeholder: the destination root seeds
   *     its own, so a copied one would duplicate the system prompt.
   *   - A `return_result` tool-action: that is how a sub-thread reports back to
   *     its parent; a root has no parent to return to, so it is meaningless (and
   *     would be a dangling tool-use) at the top level.
   * Applied only to the top level — nested threads keep their own `return_result`
   * calls, which are valid inside their sub-conversation.
   * @param {any} plain - Plain snapshot from a Y.Map's toJSON().
   * @returns {boolean} True if the item belongs at a conversation root top level.
   * @private
   */
  _isRootTopLevelItem(plain) {
    if (!plain) return false;
    if (plain.itemId === 'SYSTEM_1' || plain.type === 'system-prompt') return false;
    if (plain.type === 'tool-action' && plain.toolName === 'return_result') return false;
    return true;
  }

  /**
   * Copy tab-level state that should follow promoted/copied content into a new
   * root conversation.
   * @param {Conversation} destConversation - Destination conversation.
   * @param {import('./message-thread.js').default} sourceThread - Source thread for effective model config.
   * @returns {Promise<void>}
   * @private
   */
  async _copyNewTabState(destConversation, sourceThread) {
    if (sourceThread.modelConfig) await destConversation.setModelConfig({ ...sourceThread.modelConfig });
    const convRules = this.getMetadata(CONVERSATION_RULES_KEY);
    const convPaths = this.getMetadata(CONVERSATION_PATHS_KEY);
    if (convRules !== undefined) {
      destConversation.setMetadata(CONVERSATION_RULES_KEY, convRules?.toJSON ? convRules.toJSON() : convRules);
    }
    if (convPaths !== undefined) {
      destConversation.setMetadata(CONVERSATION_PATHS_KEY, convPaths?.toJSON ? convPaths.toJSON() : convPaths);
    }
  }

  /**
   * Copy arbitrary items into a new top-level conversation tab. Cross-doc copies
   * are necessarily two-document operations; the new conversation gets fresh itemIds and
   * root-owned context, and the source document is unchanged.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Source indices to copy.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null when nothing copied.
   */
  async copyItemsToNewTab(source, indices, options = {}) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length || !this.session?.createConversation) return null;
    const sourceItems = sorted.map(i => source.items[i]);
    const hasCopyableItem = sourceItems.some((/** @type {any} */ it) => this._isRootTopLevelItem(it.toJSON()));
    if (!hasCopyableItem) return null;

    const newId = await this.session.createConversation(options.name || 'Copied items', { activate: !!options.activate, origin: 'copy-items' });
    const newConv = this.session.getConversation(newId);
    if (!newConv) return null;
    const snapshots = this._snapshotsForNewRoot(sourceItems, newConv);

    newConv.atomicUpdate(() => {
      const arr = newConv.rootMessageThread.ensureYarray();
      arr.insert(arr.length, snapshots.map((/** @type {any} */ s) => plainToYMap(s)));
    });

    await this._copyNewTabState(newConv, source);
    if (options.activate) this.session.switchConversation?.(newId);
    return newId;
  }

  /**
   * Move arbitrary items into a new top-level conversation tab. This is an
   * explicit two-step cross-doc move: copy into the new doc, then delete from
   * the source doc. Undo cannot cross the document boundary.
   * @param {import('./message-thread.js').default} source - Source message thread.
   * @param {number[]} indices - Source indices to move.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null when not moved.
   */
  async moveItemsToNewTab(source, indices, options = {}) {
    const sorted = this._normalizeIndices(indices, source.length);
    if (!sorted.length) return null;
    const newId = await this.copyItemsToNewTab(source, sorted, options);
    if (!newId) return null;
    source.transact(() => source.removeItemsAt(sorted));
    return newId;
  }

  /**
   * Promote a sub-thread into a new top-level conversation tab.
   *
   * Cross-document undo cannot be atomic, so this is intentionally a COPY-style
   * promote: the original thread remains in place and the new conversation receives fresh
   * itemIds. UX can offer a separate "remove original" action later, but this
   * primitive never pretends that a cross-doc move is undoable.
   *
   * State carry-over policy:
   *   - Items: copied into the new root, fresh itemIds recursively. Every thread
   *     is isolated and carries everything it needs in its own items.
   *   - SYSTEM_1: new conversation owns its root context; promoted SYSTEM_1
   *     placeholders (and `return_result` tool-actions, meaningless at a root)
   *     are dropped — the new root seeds its own system prompt.
   *   - modelConfig: source thread's effective modelConfig becomes new root config.
   *   - permissionRules/allowedPaths: conversation-scoped metadata is copied.
   *     Session-scoped permissions already belong to the project and remain shared.
   * @param {string} threadItemId - Thread item ID to promote.
   * @param {{activate?: boolean, name?: string}} [options]
   * @returns {Promise<string|null>} New conversation ID, or null if not promoted.
   */
  async promoteThreadToNewTab(threadItemId, options = {}) {
    const threadYMap = this.findItemById(threadItemId);
    if (!threadYMap || threadYMap.get?.('type') !== 'thread') return null;
    if (hasUnsettledToolInTree(threadYMap.get('items'))) return null;
    if (!this.session?.createConversation) return null;

    const sourceThread = this.resolveMessageThread(threadItemId);
    const nested = threadYMap.get('items');
    const sourceItems = nested?.toArray?.() || [];
    // Every thread is isolated and carries its own history, so the promoted
    // items are exactly the thread's own items.
    const promotedItems = sourceItems;
    const hasCopyableItem = promotedItems.some((/** @type {any} */ it) => this._isRootTopLevelItem(it.toJSON()));
    if (!hasCopyableItem) return null;

    const goal = threadYMap.get('goal') || 'Promoted thread';
    const newId = await this.session.createConversation(options.name || goal, { activate: !!options.activate, origin: 'promote-thread' });
    const newConv = this.session.getConversation(newId);
    if (!newConv) return null;

    const snapshots = this._snapshotsForNewRoot(promotedItems, newConv);

    newConv.atomicUpdate(() => {
      const root = newConv.rootMessageThread;
      const arr = root.ensureYarray();
      arr.insert(arr.length, snapshots.map((/** @type {any} */ s) => plainToYMap(s)));
    });

    await this._copyNewTabState(newConv, sourceThread);

    if (options.activate) this.session.switchConversation?.(newId);
    return newId;
  }

  /**
   * Complete a thread with a result
   * @param {*} threadYMap - The Yjs Y.Map for the thread item
   * @param {string} result - The thread result text
   */
  completeThread(threadYMap, result) {
    this.atomicUpdate(() => {
      threadYMap.set('result', result);
    });
  }

  // =========================================================================
  // Status Message API (delegates to _llmState)
  // =========================================================================

  /**
   * Set a custom status message for this conversation
   * @param {string} statusText
   */
  setStatusMessage(statusText) {
    this._llmState.updateStatus(this.id, 'custom', { message: statusText });
  }



  // ========================================================================
  // MESSAGE SENDING AND LLM INTERACTION
  // ========================================================================

  /**
   * Send a message in this conversation
   * @param {string} userMessage - User's message content
   * @param {string|null} [threadItemId] - Thread item ID if sending from a thread column
   * @param {import('./message-thread.js').MessageThread} [messageThread] - Column-scoped message thread
   * @param {{preemptProcessing?: boolean, attachments?: Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>, skills?: string[], closeRequest?: boolean}} [options] -
   *   When `preemptProcessing` is set, an in-flight turn is cancelled-and-settled
   *   (worker truth) before this message is delivered, instead of the message
   *   being silently dropped by the "already processing" guard. A visible notice
   *   is shown if a live turn was actually cancelled. `attachments` carries
   *   content-addressed asset references (uploaded images) to store on the user
   *   item. `closeRequest` marks the send as a thread close, forcing
   *   return_result for that turn (see MessageThread.close).
   * @returns {Promise<string|null>} null when the message was delivered (or a
   *   slash command was handled); otherwise a short reason describing which
   *   guard dropped it. The drop is silent for users (the UI guard normally
   *   catches it first); the test harness checks the reason so a dropped
   *   message fails the test at the send, not as a downstream fence timeout.
   */
  async sendMessage(userMessage, threadItemId = null, messageThread, options = {}) {
    // Check for slash commands first (these work even when processing)
    if (userMessage.startsWith('/')) {
      // Capture composer before command runs — commands may change the active column
      const composer = this._getComposer();
      const boundBefore = this._composerThreadId(composer);
      // Clear the box BEFORE running the command, not after. A command like
      // /handoff clones the conversation part-way through execute(), and the
      // clone is taken from the source's persisted draft — so if the command
      // text is still sitting in the box when the snapshot happens, it
      // reappears prefilled in the new conversation's input. Clearing first
      // means the clone captures an empty draft. Gated on the same pattern
      // slashCommandHandler.execute() treats as handled (`/foo`, not a bare
      // "/" or "/123"), so genuinely-unhandled input still falls through to a
      // normal send and survives a validation failure in the box. Guarded so a
      // scheduled send firing on a hidden thread doesn't wipe the visible
      // column's in-progress draft. (A command that sets a draft — 'draft' run
      // mode's setDraft side effect — runs after this, so it isn't clobbered.)
      //
      // Only clear when the box's current text IS this command — i.e. the user
      // typed `/foo` and submitted it, so the box holds exactly what we're about
      // to consume. When the command was invoked another way (picked from the
      // slash/commands menu, a scheduled or programmatic send) the box instead
      // holds an unrelated in-progress draft; clearInput() would destroy it
      // non-undoably (setText('') wipes the native undo stack), so leave it be.
      const boxText = (composer && typeof (/** @type {any} */ (composer).getText) === 'function')
        ? /** @type {any} */ (composer).getText().trim()
        : '';
      if (/^\/[a-zA-Z]/.test(userMessage)
          && boxText === userMessage.trim()
          && composer && typeof (/** @type {any} */ (composer).clearInput) === 'function'
          && boundBefore === this._targetThreadId(messageThread, threadItemId)) {
        /** @type {any} */ (composer).clearInput();
      }
      const result = await slashCommandHandler.execute(userMessage, messageThread);
      if (result.handled) {
        if (result.message) {
          this.showWarning(result.message, 3000);
        }
        if (result.sideEffects) {
          await this._handleCommandSideEffects(result.sideEffects);
        }
        return null;
      }
    }

    // Refuse to start an LLM turn when no strategy is enabled. Every strategy
    // ships in `@juggler/core`; with it (or all strategy plugins) disabled
    // there is nothing to drive a turn, so the worker/engine would otherwise
    // spin the inert fallback to no effect. Tell the user — at the moment
    // they try to send — and leave their message in the box. Slash commands
    // were already handled above, so the Extensions settings stay reachable.
    if (!strategyRegistry.hasAnyStrategy()) {
      this.showWarning("Can't start a conversation — the core Juggler extension is turned off. Re-enable it in Extensions settings to continue.", 8000);
      return 'no strategy enabled';
    }

    // Refuse a turn whose selected model belongs to a provider that is not
    // currently available — Claude Code toggled off, an API key removed, etc.
    // The model picker blocks *selecting* such a model, but a conversation can
    // already be sitting on one: selection is sticky and a later provider
    // toggle never retargets it. Without this guard the turn reaches the
    // backend, which rejects it with a developer string ("provider X is not
    // enabled"). Catch it at the send site and offer the same fix the picker
    // does. Slash commands were handled above, so settings stay reachable.
    // Fresh install with no API key: the model picker is empty, nothing is
    // selected, and the worker would bounce with an unsatisfiable "select a
    // model" warning. Surface the real problem — no provider configured — with a
    // jump to Provider Settings. Fire only when there is genuinely nothing to
    // send with: no model already selected AND a positive "cache received and
    // empty" signal (an un-hydrated startup, or a conversation that already has a
    // model, never trips this — the latter is handled just below).
    const selectedConfig = messageThread?.modelConfig || this.modelConfig;
    const hasSelectedModel = !!(selectedConfig && selectedConfig.provider);
    if (!hasSelectedModel && providersCache.hasReceived() && !providersCache.hasAvailableProvider()) {
      await this._showNoProviderConfigured();
      return 'no provider configured';
    }

    const unavailableProvider = this._unavailableSelectedProvider(messageThread);
    if (unavailableProvider) {
      await this._showProviderUnavailable(unavailableProvider);
      return 'provider unavailable';
    }

    // When a turn is already in flight, a message is QUEUED rather than
    // refused — the worker parks it in pendingItems and drains it at the
    // next boundary (see worker/pending_items.go). The only path that still
    // can't queue is the worker-less fallback (it would start a second
    // concurrent strategy on the main thread), so it keeps refusing.
    const isQueueing = this.isProcessing && workerManager.isWorkerReady(this.id);
    if (options.preemptProcessing) {
      await this.cancelAndSettle();
    } else if (this.isProcessing && !isQueueing) {
      return `conversation ${this.id} is processing`;
    }

    // Save message before clearing, so we can restore on validation failure
    this._pendingUserMessage = userMessage;

    // Validation passed locally - now clear the input. Only clear the box when
    // it is showing the thread we sent to: a scheduled send fired from the
    // model on a hidden thread must not wipe the visible column's draft.
    const composer = this._getComposer();
    if (composer && typeof (/** @type {any} */ (composer).clearInput) === 'function'
        && this._composerThreadId(composer) === this._targetThreadId(messageThread, threadItemId)) {
      /** @type {any} */ (composer).clearInput();
    }

    // Cancel any pending approval dialogs for this conversation — but NOT
    // when queueing: a message typed while a tool awaits approval must not
    // dismiss that approval; the queued message waits its turn.
    if (!isQueueing) {
      messageThread?.cancelPendingApprovals();
    }

    // Add to session-level message history for input navigation. An image-only
    // send has empty text — don't push a blank entry into up-arrow history.
    if (userMessage) {
      this._session.addMessageToHistory({ content: userMessage, attachments: options.attachments || [] });
    }

    // Auto-recents: a send is a genuine local user action, so float this
    // conversation to the absolute top of the tab list now. This is the ONLY
    // user-action bump trigger — driven from the action site, never from
    // observing replicated Yjs state, so loading/refreshing a window (pure
    // hydration, no send) leaves every window's settled order untouched.
    this._session.bumpConversation?.(this.id, { forceTop: true });

    // Force scroll to bottom when user sends message. The real
    // "land the follow target on the new user message + spinner"
    // happens later, when onItemsInserted observes the user-message
    // insertion and updateFooter's rising edge observes the spinner
    // becoming visible. Scrolling to anything more specific here is
    // unsafe because neither the user-message DOM nor the spinner
    // exist yet at this point.
    if (this._conversationArea) {
      this._conversationArea.scrollToBottom(true);
    }

    // Route to worker - the worker owns the strategy loop. Turns are driven
    // exclusively by the Go worker; there is no viewer-side fallback loop.
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.sendMessage(this.id, userMessage, messageThread?.threadItemId || threadItemId, options.attachments, options.skills, { closeRequest: options.closeRequest });
      const acceptedConfig = messageThread?.modelConfig || this.modelConfig;
      if (acceptedConfig?.provider && acceptedConfig?.model) {
        recentModels.record(acceptedConfig.provider, acceptedConfig.model, acceptedConfig.thinking);
      }
      // Worker will emit state patches that update proxy, which triggers UI updates
      // Processing state is managed by worker via state patches
      return null;
    }

    // Worker not ready yet (still starting, or spawn failed). Refuse rather than
    // running anything on the main thread; the user can retry once it is up.
    this.showWarning('Still connecting to the engine — try again in a moment.', 5000);
    return 'worker not ready';
  }


  /** @type {Set<Function>} */
  _stopHandlers = new Set();

  /**
   * Guard A one-shot latch: set when a "no-model" validation error triggers a
   * model-config resync + auto-resend (see services/llm-state.js), cleared on the
   * next accepted turn. Prevents a resend loop if the self-heal doesn't take.
   * @type {boolean}
   */
  _modelSelfHealAttempted = false;

  /**
   * Optimistic "Pause pending" cue. True from a polite-stop request until the
   * worker next settles to idle (see isPolitePending, which self-clears it).
   * Local-only: it drives the Pause button's active appearance without a server
   * round-trip. The settled state is ordinary idle — nothing distinguishes a
   * paused conversation from any other idle one once the current step drains.
   * @type {boolean}
   */
  _politePending = false;

  /**
   * Finish processing and clean up
   *     */
  _finishProcessing() {
    this._llmState.stop(this.id);

    // Also directly hide busy indicator as a fallback
    if (this._conversationArea && 'hideBusy' in this._conversationArea) {
      /** @type {any} */ (this._conversationArea).hideBusy();
    }

    this._session.notifyConversationChange('processing:stopped', this.id);
  }

  /**
   * Handle an error during processing
   * @param {import('./message-thread.js').MessageThread} _messageThread
   * @param {string} message - Error message
   */
  _handleError(_messageThread, message) {
    console.error(`[Conversation] Error: ${message}`);

    // The Go worker writes the error item via Yjs sync.

    this._finishProcessing();
  }

  /**
   * Handle cancellation
   *     */
  _handleCancellation() {
    this._finishProcessing();
  }

  /**
   * Handle retry notification for this conversation
   * @param {number} attempt - Current retry attempt
   * @param {number} maxRetries - Maximum retries
   * @param {string} [reason] - Reason for retry (e.g., 'timeout', 'network')
   */
  handleRetry(attempt, maxRetries, reason) {
    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    this._llmState.updateStatus(this.id, 'retry', {
      attempt,
      maxRetries,
      reason
    });
  }

  /**
   * Handle streaming error notification from backend
   * @param {import('./message-thread.js').MessageThread} messageThread
   * @param {string} errorMessage - Detailed error message from LLM provider
   */
  handleStreamingError(messageThread, errorMessage) {
    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    // The Go worker writes the error item via Yjs sync.

    this._llmState.updateStatus(this.id, 'error', {
      message: errorMessage
    });
  }

  /**
   * Handle final response from backend
   * @param {import('./message-thread.js').MessageThread} messageThread
   * @param {import('../services/websocket.js').ContentBlock[]} blocks - Structured response blocks
   * @param {number} inputTokens - Input tokens used
   * @param {number} outputTokens - Output tokens generated
   * @param {number} cachedTokens - Prompt tokens served from cache (OpenAI)
   * @param {string} [transactionId] - Transaction ID; the Go worker owns turn flow, accepted for call-site parity
   * @param {string} [stopReason] - LLM stop reason; the Go worker owns turn flow, accepted for call-site parity
   */
  async handleResponse(messageThread, blocks, inputTokens = 0, outputTokens = 0, cachedTokens = 0, transactionId, stopReason) {
    void blocks;
    void stopReason;
    void transactionId;
    // Check if this conversation is still processing
    if (!this._llmState.isConversationProcessing(this.id)) {
      console.warn('[Conversation] handleResponse called but conversation not processing');
      return;
    }

    try {
      // Update status
      this._llmState.updateStatus(this.id, 'processing_tools', {
        inputTokens,
        outputTokens,
        cachedTokens
      });

      // The Go worker owns the turn: it adds text/thinking blocks during
      // streaming (processStreamChunk) and drives tool execution. The status
      // update above is all the viewer needs to do here.
    } catch (error) {
      console.error('[Conversation] Error in handleResponse:', error);
      this._handleError(messageThread, extractErrorMessage(error));
    }
  }

  // ========================================================================
  // ERROR HANDLING AND CANCELLATION
  // ========================================================================

  /**
   * Handle error for this conversation
   * @param {import('./message-thread.js').MessageThread} messageThread
   * @param {string} error - Error message
   */
  handleError(messageThread, error) {
    console.error(`[ESSENTIAL] [Conversation] Error in ${this.id}: ${error}`);

    if (!this._llmState.isConversationProcessing(this.id)) {
      return;
    }

    // Detect cancellation (case-insensitive, various formats)
    const isCancellation = error === 'Request cancelled by user' ||
            (typeof error === 'string' && error.toLowerCase().includes('cancel'));
    if (isCancellation) {
      this._handleCancellation();
    } else {
      this._handleError(messageThread, error);
    }
  }

  /**
   * Handle shouldContinue request from provider (iteration control callback)
   * This is called when the backend sends a should_continue_request message,
   * which happens after each turn in the tool execution loop.
   * @param {{requestId: string, turnNumber: number, toolCallCount: number}} data - Request data
   */
  async handleShouldContinueRequest(data) {
    const { requestId } = data;
    // Turns are driven by the Go worker; the viewer applies no per-turn
    // iteration control, so always continue.
    wsService.sendShouldContinueResponse(requestId, true, '');
  }

  /**
   * Handle tool execution request from claudecode provider.
   * This is called when the backend sends a tool_use_request message,
   * which happens when claudecode's MCP handler receives a tools/call.
   *
   * Uses ToolExecutor for routing - same code path as workers and strategy loop.
   * @param {{requestId: string, toolUseId: string, toolName: string, toolInput: {[key: string]: unknown}}} data - Tool request data
   */
  async handleToolUseRequest(data) {
    const { requestId, toolUseId, toolName, toolInput } = data;

    // Ensure spinner is showing during claudecode tool execution
    if (!this.isProcessing) {
      this._llmState.start(this.id);
    }
    this._llmState.updateStatus(this.id, 'processing_tools');

    try {
      // Execute via ToolExecutor - handles routing, approval flow internally.
      // onApproved fires when the user approves so the server can start its execution timeout.
      const result = await toolExecutor.executeToolCall(
        { id: toolUseId, name: toolName, input: toolInput || {} },
        this._responseHandler,
        this._rootMessageThread,
        { onApproved: () => wsService.sendToolStarted(requestId) }
      );

      // Extract content and status from result
      /** @type {'success'|'error'|'cancelled'} */
      let resultStatus = 'success';
      let content = 'Tool executed successfully';
      let category = '';

      if (result.resultStatus) {
        resultStatus = /** @type {'success'|'error'|'cancelled'} */ (result.resultStatus);
      } else if (result.success === false) {
        resultStatus = 'error';
      }

      if (result.content) {
        content = result.content;
      } else if (!result.success && result.error) {
        content = /** @type {string} */ (result.error);
      }

      if (result.category) {
        category = /** @type {string} */ (result.category);
      }

      // Send response back to server
      wsService.sendToolResponse(requestId, content, resultStatus, category);
    } catch (error) {
      // AbortError means user cancelled - this vetoes continuation
      if (error instanceof AbortError) {
        wsService.sendToolResponse(requestId, '__ABORT__', 'cancelled', '');
        return;
      }

      // Send regular error response back to server
      wsService.sendToolResponse(
        requestId,
        extractErrorMessage(error),
        'error',
        ''
      );
    }
  }

  /**
   * Register a cleanup function to be called when stopProcessing() fires.
   * Returns an unregister function. Used by strategies to abort their own
   * in-progress operations without coupling conversation.js to strategy internals.
   * @param {Function} fn - Cleanup function
   * @returns {() => void} Unregister function
   */
  registerStopHandler(fn) {
    this._stopHandlers.add(fn);
    return () => this._stopHandlers.delete(fn);
  }

  /**
   * Fire only the registered stop handlers — e.g. the plan strategy aborting
   * its _driveExecution controller — WITHOUT the rest of stopProcessing's
   * teardown. The engine calls this when the worker reports the conversation
   * was cancelled, so engine-driven strategy execution (onWorkerIdle) unwinds
   * promptly. The worker has already cancelled the tools/turn; running full
   * stopProcessing here would loop a cancel back to the worker.
   */
  cancelStrategyExecution() {
    for (const fn of this._stopHandlers) fn();
  }

  /**
   * Stop all processing for this conversation (actions, LLM calls, etc.).
   * For a user-visible cancellation, use addCancellationMessage() instead,
   * which stops processing and posts a cancellation message.
   */
  stopProcessing() {
    // Call all registered stop handlers (e.g. plan strategy aborting its drive controller).
    for (const fn of this._stopHandlers) fn();

    // Cancel all running actions (shells, etc.) via action executor
    this._actionExecutor.cancelAllActions();

    // Cancel worker if active
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.cancel(this.id);
    }
  }

  /**
   * Request a polite stop (Pause): let the current step finish and record its
   * real result, then rest at idle before the next LLM turn. Deliberately does
   * NOT call stopProcessing / cancelAllActions / cancelAllPendingApprovals /
   * addCancellationMessage — polite is uniformly non-destructive; it interrupts
   * nothing and leaves every thread open. It only sends the `pause` message and
   * flips the optimistic local cue so the Pause button renders active until the
   * worker settles.
   */
  requestPoliteStop() {
    if (!workerManager.isWorkerReady(this.id)) return;
    workerManager.pause(this.id);
    this._politePending = true;
  }

  /**
   * Cancel a pending polite stop (Pause) — the inverse of requestPoliteStop.
   * Clears the worker's pause latch (so the current turn continues to its next
   * boundary rather than resting at idle) and drops the optimistic local cue (so
   * the Pause button reverts to its plain state). A no-op unless a polite stop is
   * actually pending, which is what makes the button a toggle: press to pause,
   * press again to un-pause. Deliberately NOT reachable from shift+Escape — that
   * shortcut only ever requests a pause, never cancels one.
   */
  cancelPoliteStop() {
    // Key off isPolitePending() (which consults the synced worker flag), not the
    // raw local field — after a reload _politePending is false but the pause may
    // still be genuinely pending in the synced processingState, and the toggle
    // must still cancel it.
    if (!this.isPolitePending()) return;
    if (workerManager.isWorkerReady(this.id)) workerManager.unpause(this.id);
    this._politePending = false;
  }

  /**
   * Whether a polite stop is in progress. Server-authoritative: the worker
   * publishes `processingState.politePending` while the pause latch is set on a
   * busy frame, so this survives a page reload (the local `_politePending` cue is
   * reset to false on reload). The synced flag is the truth; `_politePending` is
   * only the optimistic pre-sync cue that covers the window between the click and
   * the worker's first frame carrying the flag.
   *
   * Self-clears the local cue once the turn is no longer active — i.e. the worker
   * reached the ordinary idle it rests at after the current step drains — so a
   * later Continue never inherits a stale pending cue.
   * @returns {boolean} true while a polite stop is pending (current step still finishing)
   */
  isPolitePending() {
    // Synced truth wins. Keep the local cue in step so paths that read
    // _politePending directly stay consistent after a reload-driven rehydrate.
    if (this.processingState?.politePending === true) {
      this._politePending = true;
      return true;
    }
    if (this._politePending && !this.isTurnActive()) {
      this._politePending = false;
    }
    return this._politePending;
  }

  /**
   * Whether a turn is currently in flight on this conversation.
   *
   * Synchronous snapshot of the same two truth sources `cancelAndSettle`
   * settles on, so callers that only want to REFUSE a mid-turn action (rather
   * than cancel it) can check without awaiting. See `cancelAndSettle` for the
   * rationale on each source.
   * @returns {boolean} true if the worker is mid-turn OR a frontend-driven
   *   tool action is still running.
   */
  isTurnActive() {
    const status = this.processingState?.status;
    const workerBusy = !!status && status !== 'idle';
    return workerBusy || this._actionExecutor.hasRunningActions();
  }

  /**
   * Cancel any in-flight processing AND wait for it to settle.
   *
   * This is the architectural chokepoint that any code wanting to mutate the
   * conversation while a turn might be live should call. Without it, callers
   * race the worker / action-executor and can snapshot mid-flight state into
   * permanent Yjs items (e.g. a bash tool stuck `state: 'running'` inside a
   * compacted sub-thread).
   *
   * Truth sources (in order):
   *   1. Worker's `processingState.status` in the Yjs metadata — the worker
   *      is the single writer and this reflects whatever phase it is in
   *      (preparing/streaming/processing_tools/mock-paused/idle/etc.).
   *      `llmState.isProcessing` is a UI projection that only models
   *      production statuses, so we cannot use it alone — e.g. it does not
   *      recognise the test-only `mock-paused` status and would report
   *      "idle" while the worker is actually parked.
   *   2. `_actionExecutor.hasRunningActions()` — any frontend-driven tool
   *      action (bash/edit/etc.) still mid-flight.
   *
   * Resolves once both are quiet. Idempotent — if nothing is in flight it
   * resolves on the next microtask. Reactive on the Yjs metadata observer
   * the worker already writes through; the poll is a safety net for the
   * action-executor side which does not (yet) push events.
   * @returns {Promise<void>}
   */
  async cancelAndSettle() {
    const settled = () => !this.isTurnActive();

    if (settled()) return;

    // Something is in flight and we're about to cancel it. Surface that so
    // the preemption is never silent — every caller (new-thread button,
    // slash menu, close-thread) reaches the user through this one notice.
    this.showWarning(TURN_CANCELLED_NOTICE, 5000);

    this.stopProcessing();

    if (settled()) return;

    await new Promise((resolve) => {
      const finish = () => {
        if (!finished && settled()) {
          finished = true;
          clearInterval(pollId);
          clearTimeout(timeoutId);
          this.unobserveMetadata(metaObserver);
          resolve(undefined);
        }
      };
      let finished = false;
      const metaObserver = (/** @type {any} */ event) => {
        if (event.keysChanged?.has?.('processingState')) finish();
      };
      this.observeMetadata(metaObserver);
      const pollId = setInterval(finish, CANCEL_POLL_MS);
      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        clearInterval(pollId);
        this.unobserveMetadata(metaObserver);
        resolve(undefined);
      }, CANCEL_CEILING_MS);
    });
  }

  /**
   * Add a cancellation message
   * Called when user cancels an operation
   */
  addCancellationMessage() {
    this.stopProcessing();
    this._handleCancellation();
  }

  // ========================================================================
  // CONFIGURATION (MODEL, STRATEGY, PERMISSIONS)
  // ========================================================================

  /**
   * Set the LLM model configuration for this conversation
   * @param {ModelConfig|null} config - Model configuration (provider and model)
   */
  async setModelConfig(config) {
    const root = this._rootMessageThread;
    const changed = root.modelConfig?.provider !== config?.provider ||
                        root.modelConfig?.model !== config?.model;

    if (changed) {
      // Setter writes to Yjs metadata; the metadata observer
      // handles _fetchContextWindow and contextWindow clearing.
      root.modelConfig = config;
    }
  }



  /**
   * Ensure context window is fetched for current model
   * @async
   */
  async ensureContextWindow() {
    if (this.modelConfig && !this.contextWindow) {
      await this._fetchContextWindow(this.modelConfig);
    }
  }

  /**
   * Fetch and store the context window for the current model
   * @param {ModelConfig|null} modelConfig - Model configuration
   *     */
  async _fetchContextWindow(modelConfig) {
    if (!modelConfig) return;
    const { provider, model } = modelConfig;
    if (!provider || !model) return;
    // Resolve the window from the WS-pushed provider list — the single source
    // of truth, mirrored client-side in providersCache. waitForFirst() covers
    // the cold-start race (the conversation loads before the first push lands);
    // every client is seeded a providers-update on connect, so it never hangs.
    // A model whose window isn't in the list yet (e.g. a live-API-only model
    // before the first refresh completes) simply stays unset and is backfilled
    // by applyProvidersContextWindow on the next push — no REST round-trip, so
    // no transient 404 in the console.
    const list = await providersCache.waitForFirst();
    if (this.applyProvidersContextWindow(list)) {
      this._session.notifyConversationChange('conversation:context-window-updated', this);
    }
  }

  /**
   * Re-resolve the cached context window from a freshly pushed provider list
   * (the `providers-update` WS event). The value captured at modelConfig time
   * can be a cold-start fallback — claudecode only learns a model's true
   * window from the first turn's CLI result event, then the server
   * rebroadcasts the list — so this lets the footer correct itself once the
   * real number arrives.
   * @param {Array<any>} providers - Provider list from providers-update.
   * @returns {boolean} True when the cached context window changed.
   */
  applyProvidersContextWindow(providers) {
    const config = this.modelConfig;
    if (!config?.provider || !config?.model) return false;
    const provider = providers.find((/** @type {any} */ p) => p?.name === config.provider);
    const model = provider?.modelsWithContext?.find((/** @type {any} */ m) => m?.id === config.model);
    const next = model?.contextWindow;
    if (!next || next === this.contextWindow) return false;
    this.contextWindow = next;
    return true;
  }

  // ========================================================================
  // ID GENERATION
  // ========================================================================

  /**
   * Generate a unique message ID using timestamp + random suffix.
   * This prevents conflicts when undo/redo restores old IDs while new messages are created.
   * @returns {string} Unique message ID (e.g., "msg-1705693200000-a3f2")
   *     */
  _nextItemId() {
    // Use timestamp + random suffix for uniqueness
    // This ensures IDs from undo/redo (which restore old IDs) won't conflict with new ones
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    return `msg-${timestamp}-${random}`;
  }

  /**
   * Serialize conversation to JSON (metadata only - content is in Yjs binary)
   * @returns {{
   *   id: string,
   *   name: string,
   *   created: string
   * }} JSON representation of conversation
   */

  // ========================================================================
  // SERIALIZATION AND CLONING
  // ========================================================================

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      created: this.created
    };
  }

  // ========================================================================
  // UI INTERACTION
  // ========================================================================

  /**
   * Resolve the effective model for a send and return the matching provider
   * cache entry when that provider is known to be unavailable, else null.
   *
   * Conservative on purpose: returns null (allow the send) when no model is
   * selected, or when the provider isn't in the cache at all (a cold cache or
   * a provider that no longer exists). We only refuse on a positive
   * "this provider exists and is not available" signal, so an incomplete local
   * cache never blocks a turn.
   * @param {MessageThread} [messageThread] Thread being sent into, if any.
   * @returns {import('../services/providers-cache.js').Provider|null} The unavailable provider's cache entry, or null to allow the send.
   * @private
   */
  _unavailableSelectedProvider(messageThread) {
    const config = messageThread?.modelConfig || this.modelConfig;
    if (!config || !config.provider) return null;
    const entry = providersCache.get().find(p => p.name === config.provider);
    // Refuse only on a positive "exists and is unavailable" signal. A missing
    // `available` field (partial fixture, pre-`available` payload) is treated as
    // unknown → allow, so incomplete local state never blocks a turn.
    if (!entry || entry.available !== false) return null;
    return entry;
  }

  /**
   * Explain that the selected model's provider is unavailable and offer the
   * same fix the model picker shows at selection time (`_showSelectionProblem`):
   * the provider's auth hint plus a jump to Provider Settings. Falls back to a
   * toast if the confirm dialog isn't wired up.
   * @param {import('../services/providers-cache.js').Provider} provider
   * @private
   */
  async _showProviderUnavailable(provider) {
    const label = provider.displayName || provider.name;
    const hint = (provider.authHint || '').trim();
    const message = hint
      ? `Can't send: ${label} is not available — ${hint}. Re-enable it in Provider Settings or pick another model.`
      : `Can't send: ${label} is not available. Re-enable it in Provider Settings or pick another model.`;
    await this._offerProviderSettings(message, 'Model unavailable');
  }

  /**
   * Explain that no AI provider is configured yet and offer a jump to Provider
   * Settings. Fired on the first-send path when the providers cache is known to
   * be empty (no API key, Claude Code not enabled) — the model picker has
   * nothing selectable, so the generic "select a model" warning is unactionable.
   * @private
   */
  async _showNoProviderConfigured() {
    const message =
      'No AI provider is configured yet — add an API key (or enable Claude Code) in Provider Settings to start chatting.';
    await this._offerProviderSettings(message, 'No provider configured');
  }

  /**
   * Show a message with an offer to jump to Provider Settings, falling back to a
   * toast warning if the confirm dialog isn't wired up.
   * @param {string} message - Body text for the confirm dialog / toast
   * @param {string} title - Confirm-dialog title
   * @private
   */
  async _offerProviderSettings(message, title) {
    const showConfirm = /** @type {any} */ (window).showConfirm;
    if (typeof showConfirm !== 'function') {
      this.showWarning(message, 8000);
      return;
    }
    const goToSettings = await showConfirm(message, title, {
      confirmText: 'Go to provider settings',
      cancelText: 'Cancel',
    });
    if (goToSettings && typeof (/** @type {any} */ (window).openSettings) === 'function') {
      /** @type {any} */ (window).openSettings('providers');
    }
  }

  /**
   * Show a warning message to the user
   * @param {string} message - Warning message to display
   * @param {number} [duration] - Duration to show warning in milliseconds (default: 3000)
   */
  showWarning(message, duration = 3000) {
    const composer = this._getComposer();
    if (composer && 'showWarning' in composer && typeof composer.showWarning === 'function') {
      /** @type {any} */ (composer).showWarning(message, duration);
    }
  }

  /**
   * Handle declarative side-effects returned by command plugins.
   * This is the single point where commands' declared intents are dispatched
   * to the host application (UI, session, etc.).
   * @param {import('juggler/command-type').CommandSideEffect[]} sideEffects
   * @private
   */
  async _handleCommandSideEffects(sideEffects) {
    for (const effect of sideEffects) {
      const data = effect.data || {};
      switch (effect.type) {
        case 'openThread': {
          const tabElement = /** @type {any} */ (this._tabElement);
          if (tabElement) {
            tabElement.openThread(data.threadId);
          }
          break;
        }
        case 'setDraft': {
          // A user command in 'draft' run mode expanded its template into the
          // composer for editing before send. Commands never touch the DOM;
          // they declare intent and the host splices it in, caret at the end.
          const composer = /** @type {any} */ (this._getComposer());
          if (composer && typeof composer.setDraft === 'function') {
            composer.setDraft(String(data.text ?? ''));
          } else if (composer && typeof composer.setText === 'function') {
            composer.setText(String(data.text ?? ''));
          }
          break;
        }
        case 'openCommandManager': {
          // The /commands manager. Loaded lazily so the editor dialog module is
          // only pulled in when actually opened.
          const { openCommandManager } = await import('../components/command-editor-dialog.js');
          openCommandManager();
          break;
        }
      }
    }
  }

  /**
   * Restore the pending user message to the composer after a send failure
   */
  restorePendingMessage() {
    const message = this._pendingUserMessage;
    this._pendingUserMessage = null;
    if (!message) return;
    const composer = this._getComposer();
    if (composer && 'setText' in composer) {
      /** @type {any} */ (composer).setText(message);
    }
  }

  /**
   * Handle Yjs sync message from worker
   * @param {Uint8Array} bytes - Sync message bytes
   */
  handleYjsSyncMessage(bytes) {
    this._doc.applySyncUpdate(bytes);
  }

  /**
   * This conversation's Yjs state vector, sent to the worker on reconnect to
   * request a differential catch-up of any updates missed while disconnected.
   * @returns {Uint8Array} The encoded Yjs state vector.
   */
  getYjsStateVector() {
    return this._doc.getStateVector();
  }

  /**
   * Activate Yjs sync for bidirectional sync with worker.
   * Called by worker manager after worker is ready.
   * Note: activateSync() is idempotent - it only connects once.
   * @param {{ broadcastInitialState?: boolean }} [opts]
   */
  activateYjsSync(opts) {
    this._doc.activateSync(opts);
  }

  /**
   * Re-broadcast this conversation's full doc state to its worker. Guard A's
   * repair for the "no-model" divergence: the worker's doc resolved no model
   * even though this client is displaying one (the model write never reached the
   * worker — the outbound-sync gap). Pushing full state, which includes
   * `defaultModelConfig`, repairs the worker's doc so the next send validates.
   */
  resyncToWorker() {
    this._doc.broadcastFullState();
  }

  /**
   * Resend a message straight to the worker — Guard A's one-shot auto-retry
   * after resyncToWorker(). Deliberately bypasses the local sendMessage guards:
   * they already passed for the original send, and this must ride the same FIFO
   * worker channel immediately after the resync so the model config lands before
   * the resend is re-validated. Text-only (attachments, if any, were already
   * consumed by the original attempt); no-op if the worker isn't ready.
   * @param {string} text - The pending user message to resend.
   * @param {string|null} [threadItemId] - Target thread, or null for root.
   */
  resendToWorker(text, threadItemId = null) {
    if (workerManager.isWorkerReady(this.id)) {
      workerManager.sendMessage(this.id, text, threadItemId, undefined);
    }
  }

  // ========================================================================
  // CLEANUP AND DESTRUCTION
  // ========================================================================

  /**
   * Clean up resources when conversation is destroyed
   */
  destroy() {
    // Stop any active LLM processing
    if (this._llmState && this._llmState.isConversationProcessing(this.id)) {
      this._llmState.stop(this.id);
    }

    // Unregister the tab from LLM state — this tears down the per-conversation
    // Yjs metadata observer registered in setTabElement(). Without it the
    // observer (and its captured conversation) leak for the app's lifetime.
    this._llmState?.unregisterConversationTab?.(this.id);



    // Clean up all local context items
    this._rootMessageThread.contextItems.forEach(contextItem => {
      if (contextItem && typeof contextItem.destroy === 'function') {
        contextItem.destroy();
      }
    });

    // Wake up any waiting loops so they can exit
    this._emitStateChange();

    // Clean up Yjs observers before destroying doc
    this._yjsCleanup?.();
    this._yjsCleanup = null;

    // Clean up Y.Doc (includes sync manager cleanup)
    if (this._doc) {
      this._doc.destroy();
    }

    // No need to clear items - destroy() is final cleanup, worker will be terminated
  }

}

// Export class
export default Conversation;
