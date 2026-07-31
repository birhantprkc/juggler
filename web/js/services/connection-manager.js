//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import apiService from './api.js';
import wsService from './websocket.js';
import workerManager from './worker-manager.js';
import Session from '../model/session.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * @typedef {object} ConnectionManagerOptions
 * @property {HTMLElement|null} [conversationBar] - Conversation bar element (null for engine)
 * @property {import('./llm-state.js').default} llmState - LLM state manager
 * @property {function(ServerMessage): void} onServerMessage - Callback for server messages
 * @property {function(): void} [onSessionInitialized] - Optional callback after session is created
 * @property {import('../model/session.js').ConversationServices} services - Services for Conversation instances
 * @property {{show: () => void, hide: () => void, startCountdown: (delayMs: number) => void}|null} [disconnectionOverlay] - Overlay for connection loss (null for engine)
 */

/**
 * @typedef {object} ServerMessage
 * @property {string} type - Message type
 * @property {string} conversationId - Conversation ID
 * @property {unknown} data - Message data
 */

/**
 * ConnectionManager
 *
 * Manages WebSocket connections and session initialization.
 * Handles connection lifecycle and status updates.
 * @class
 */
class ConnectionManager {
  /**
   * @param {ConnectionManagerOptions} options - Configuration options
   */
  constructor(options) {
    this._conversationBar = options.conversationBar || null;
    this._llmState = options.llmState;
    this._onServerMessage = options.onServerMessage;
    this._onSessionInitialized = options.onSessionInitialized;
    this._services = options.services;

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {function|null} @private */
    this._unsubscribe = null;

    /** @type {Map<string, import('./websocket.js').WSEventCallback>} @private */
    this._wsCallbacks = new Map();

    /** @type {{show: () => void, hide: () => void, startCountdown: (delayMs: number) => void}|null} @private */
    this._disconnectionOverlay = options.disconnectionOverlay || null;
  }

  /**
   * Get the current session
   * @returns {import('../model/session.js').default|null} Current session instance or null if not initialized
   */
  getSession() {
    return this._session;
  }

  /**
   * Setup WebSocket connection and event handlers
   * @returns {Promise<void>} Completes after initial setup
   */
  async setup() {
    // Register every listener BEFORE connecting. In the juggler.studio remote
    // path, wsService.connect() adopts the bootstrap's already-open DataChannel
    // and flushes its buffered handoff frames SYNCHRONOUSLY — the one-shot
    // 'session' init frame and the 'open' event are emitted before connect()
    // returns. If connect() ran first those would hit zero listeners and be
    // dropped, stranding the UI at "No session loaded". (The normal WS path is
    // indifferent to the order: its events can't fire until a later task.)

    // Handle session initialization
    const sessionCallback = /** @type {any} */ (async () => {
      await this._initializeSession();
    });
    this._wsCallbacks.set('session', sessionCallback);
    wsService.on('session', sessionCallback);

    // Handle connection events
    const openCallback = /** @type {any} */ (async () => {
      // Update connection status in titlebar
      this._updateConnectionStatus(null); // null = connected

      // Hide disconnection overlay (page will reload on reconnect, but good for consistency)
      if (this._disconnectionOverlay) this._disconnectionOverlay.hide();

      // Initialize session if not yet done
      if (!this._session) {
        await this._initializeSession();
      } else {
        // This 'open' is a reconnect (websocket.js only emits 'open'
        // here when it chose NOT to reload). Catch up on any Yjs
        // updates the workers sent while our socket was down, using a
        // state-vector diff. Without this, a viewer that briefly lost
        // its WS — routine over a remote tunnel — silently stops
        // updating until the next full page reload.
        workerManager.resyncReadyConversations();
      }
    });
    this._wsCallbacks.set('open', openCallback);
    wsService.on('open', openCallback);

    const closeCallback = /** @type {any} */ (() => {
      this._updateConnectionStatus('disconnected');
      if (this._disconnectionOverlay) this._disconnectionOverlay.show();
    });
    this._wsCallbacks.set('close', closeCallback);
    wsService.on('close', closeCallback);

    // Handle reconnection attempt notifications
    const reconnectAttemptCallback = /** @type {any} */ ((/** @type {{attempt: number, delayMs: number}} */ data) => {
      if (this._disconnectionOverlay) this._disconnectionOverlay.startCountdown(data.delayMs);
    });
    this._wsCallbacks.set('reconnect-attempt', reconnectAttemptCallback);
    wsService.on('reconnect-attempt', reconnectAttemptCallback);

    const errorCallback = /** @type {any} */ ((/** @type {Error} */ error) => {
      console.error('[ConnectionManager] WebSocket error:', error);
      this._updateConnectionStatus('error');
    });
    this._wsCallbacks.set('error', errorCallback);
    wsService.on('error', errorCallback);

    // Handle incoming messages
    const messageCallback = (/** @type {any} */ data) => {
      this._onServerMessage(data);
    };
    this._wsCallbacks.set('message', messageCallback);
    wsService.on('message', messageCallback);

    // Handle retry notifications
    const retryCallback = (/** @type {any} */ data) => {
      this._handleRetryNotification(data);
    };
    this._wsCallbacks.set('retry', retryCallback);
    wsService.on('retry', retryCallback);

    // Handle streaming error notifications
    const streamingErrorCallback = (/** @type {any} */ data) => {
      this._handleStreamingError(data);
    };
    this._wsCallbacks.set('streaming-error', streamingErrorCallback);
    wsService.on('streaming-error', streamingErrorCallback);

    // Connect only now that all listeners are registered. The studio adopt path
    // flushes buffered realtime frames and emits 'open' synchronously inside
    // connect(); registering first guarantees the flushed 'session' frame is
    // delivered. Don't call _initializeSession here — the 'session'/'open'
    // handlers above drive it once the connection is established.
    wsService.connect();
  }

  /**
   * Handle retry notification from backend
   * @param {any} data - Retry data
   * @private
   */
  _handleRetryNotification(data) {
    if (!this._session) {
      return;
    }

    // Route to specific conversation if conversationId is provided
    const conversationId = data.conversationId;
    if (conversationId) {
      const conversation = this._session.getConversation(conversationId);
      if (conversation) {
        conversation.handleRetry(data.attempt, data.maxRetries, data.reason);
      }
    }
  }

  /**
   * Handle streaming error notification from backend
   * @param {any} data - Error data with message and conversationId
   * @private
   */
  _handleStreamingError(data) {
    if (!this._session) {
      return;
    }

    // Route to specific conversation if conversationId is provided
    const conversationId = data.conversationId;
    if (conversationId) {
      const conversation = this._session.getConversation(conversationId);
      if (conversation) {
        const messageThread = conversation.resolveMessageThread(data.threadItemId);
        conversation.handleStreamingError(messageThread, data.message);
      }
    }
  }

  /**
   * Initialize session
   * @returns {Promise<void>}
   * @private
   */
  async _initializeSession() {
    // Guard against multiple initializations
    if (this._session) {
      return;
    }

    // Create session instance
    this._session = new Session(apiService);

    // CRITICAL: Set services BEFORE loading
    // This allows Conversation instances to be created during load
    this._session.setServices(this._services);

    // Setup session subscription
    this._setupSessionSubscription();

    // Load session data from backend
    // If session doesn't exist (404), clear localStorage and reload to get a new session
    let loadError = null;
    try {
      await this._session.load();
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
        console.warn('[ConnectionManager] Session not found, clearing and reloading...');
        // The recovery here is a viewer page reload; the engine worker has
        // no page and recovers via the server reissuing session state.
        if (typeof window !== 'undefined') {
          localStorage.removeItem('jugglerSessionId');
          window.location.reload();
          return;
        }
      }
      // Don't strand the UI on a failed load. Fall through to wire the
      // session into the UI anyway: the <no-project-overlay> project
      // picker is the user's recovery path (opening a project triggers a
      // full reload that retries the load), and we surface the failure
      // explicitly below rather than silently bricking with no controls.
      console.error('[ConnectionManager] Session load failed:', errorMessage);
      loadError = errorMessage;
    }

    // Notify app that session is initialized (so it can create session-dependent services)
    if (this._onSessionInitialized) {
      this._onSessionInitialized();
    }

    // Give conversation bar access to session
    // This will create conversation-tab elements for all conversations
    if (this._conversationBar) {
      /** @type {any} */ (this._conversationBar).setSession(this._session);
    }

    if (loadError && typeof window !== 'undefined') {
      // Surface the failure now that the picker overlay (wired above) is
      // available as the recovery path. Viewer-only — the engine worker
      // has no alert UI.
      /** @type {any} */ (window).showAlert?.(
        `Couldn't load the session: ${loadError}\n\nPick a project to try again.`,
        'Session load failed'
      );
    }
  }

  /**
   * Setup session subscription to handle state changes
   * @private
   */
  _setupSessionSubscription() {
    if (!this._session) {
      console.error('[ConnectionManager] Cannot setup subscription: session is null');
      return;
    }

    // Subscribe to session changes and update UI
    this._unsubscribe = this._session.subscribe(/** @param {{type: string, data: unknown, session: import('../model/session.js').default}} event */ (event) => {
      // CRITICAL: Use event.session instead of this._session!
      // The event contains the actual session instance with all its data
      const session = event.session;
      const visible = session.getVisibleConversation();

      switch (event.type) {
        case 'session:loaded':
          // Update conversation-area in visible tab when session loads
          if (visible) {
            const tab = visible.getTabElement();
            if (tab) {
              // @ts-ignore - getConversationArea is a method on conversation-tab
              const conversationArea = tab.getConversationArea();
              if (conversationArea) {
                /** @type {any} */(conversationArea).conversation = visible;
                /** @type {any} */(conversationArea).renderFromItems(visible.rootItems || []);
              }
            }
          }
          break;

        case 'context-items:changed':
        case 'conversation:changed':
        case 'processing:started':
        case 'processing:stopped':
        case 'conversation:switched':
        case 'conversation:created':
        case 'conversation:deleted':
          // UI updates are owned by the per-tab components: conversation-bar
          // handles tab visibility, conversation-tab._syncWithConversation()
          // handles context items, model selector, and token display.
          break;

        case 'session:save-error':
          console.error('[ConnectionManager] Failed to save session:', event.data);
          break;
      }
    });
  }

  /**
   * Update connection status in titlebar
   * @param {string|null} status - Connection status ('disconnected', 'error', or null for connected)
   * @private
   */
  _updateConnectionStatus(status) {
    // Pure UI affordance — the engine worker has no document/model-selector.
    if (typeof document === 'undefined') return;
    const modelSelector = /** @type {any} */ (document.querySelector('model-selector'));
    if (modelSelector && typeof modelSelector.setConnectionStatus === 'function') {
      modelSelector.setConnectionStatus(status);
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    // Unsubscribe from session events
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    // Remove every WebSocket listener registered in setup(). Iterating the map
    // (rather than hand-listing event names) guarantees none leak when the set
    // of registered events changes.
    if (wsService) {
      for (const [event, callback] of this._wsCallbacks) {
        wsService.off(/** @type {any} */ (event), callback);
      }
      this._wsCallbacks.clear();
    }

    // Clear references
    this._session = null;
  }
}

export default ConnectionManager;
