//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} SessionEvent
 * @property {string} type - Event type name
 * @property {any} data - Event data
 */

/**
 * @typedef {object} ModalOptions
 * @property {string} [confirmText] - Text for confirm button
 * @property {string} [cancelText] - Text for cancel button
 * @property {boolean} [danger] - Show danger styling for destructive actions
 */

// Augment Window interface with modal dialog methods
/**
 * @typedef {object} WindowWithModals
 * @property {(message: string, title?: string) => Promise<void>} showAlert - Show alert dialog
 * @property {(message: string, title?: string, options?: ModalOptions) => Promise<boolean>} showConfirm - Show confirm dialog
 * @property {(message: string, defaultValue?: string, title?: string) => Promise<string|null>} showPrompt - Show prompt dialog
 * @property {typeof ConversationBar} ConversationBar - ConversationBar class
 */

import { MAX_CONVERSATIONS, CONVERSATION_LIMIT_MESSAGE } from '../model/session.js';
import { MAX_CONVERSATION_NAME_LENGTH } from '../utils/constants.js';
import { hasPendingApprovalInTree } from '../model/thread-navigation.js';
import { setupColumnResize, applyColumnWidthPx } from '../utils/column-resize.js';
import { formatBytes } from '../utils/format.js';
import { registerContextMenuProvider } from '../services/context-menu-service.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import './bin-modal.js';
import './info-rail.js';
import './info-cards-button.js';

// Leading-edge debounce window for new-conversation creation. Guards against
// accidental double-activation — most commonly a double-click on the "+"
// button, where the second click lands before the async create resolves and
// would spawn a second tab.
const NEW_CONVERSATION_DEBOUNCE_MS = 500;

// Material "delete" (trash can) icon — the per-tab "move to bin" affordance.
const BIN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="1rem" viewBox="0 -960 960 960" width="1rem" fill="currentColor" aria-hidden="true"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>`;

/**
 * ConversationBar - Vertical sidebar of conversation tabs.
 *
 * Fixed-left, resizable column of stacked tab buttons. Allows switching,
 * creating, deleting, and drag-reordering conversations along the Y axis.
 */
/**
 * The currently-connected ConversationBar instance. Tracked at module scope so
 * the single context-menu provider (registered once below) can reach the live
 * bar's session + helpers without re-registering on every connect/disconnect.
 * @type {ConversationBar|null}
 */
let _activeBar = null;

class ConversationBar extends HTMLElement {
  constructor() {
    super();

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {Function|null} @private */
    this._unsubscribe = null;

    /** @type {Map<string, HTMLElement>} @private Map of conversationId -> conversation-tab element */
    this._tabElements = new Map();

    /** @type {HTMLElement|null} @private */
    this._tabsContainer = null;

    /** @type {{tab: HTMLElement, startY: number, startOrder: string[], startIdx: number, dropIdx: number, pointerId: number, active: boolean, ghost: HTMLElement|null}|null} @private */
    this._drag = null;

    /** @type {number|null} @private Auto-scroll rAF handle while dragging near edges */
    this._autoScrollRaf = null;

    /** @type {boolean} @private Track if a drag just occurred to prevent click/dblclick */
    this._dragJustOccurred = false;

    /**
     * Cache of DOM elements for diff-based rendering to preserve scroll position
     * @type {Map<string, HTMLElement>} @private
     * Keys: conversationId -> <li> tab element, 'add-button' -> add button <li>, 'tabs-menu' -> <menu>, 'nav' -> <nav>
     */
    this._cachedElements = new Map();

    /** @type {Function|null} @private Unsubscribe from LLMState status observer */
    this._llmStateUnsubscribe = null;

    /** @type {((e: Event) => void)|null} @private */
    this._focusTabListHandler = null;

    /** @type {((e: MouseEvent) => void)|null} @private */
    this._barClickHandler = null;

    /** @type {((e: KeyboardEvent) => void)|null} @private */
    this._keydownHandler = null;

    /** @type {((e: FocusEvent) => void)|null} @private */
    this._focusOutHandler = null;

    /** @type {((e: Event) => void)|null} @private */
    this._cycleTabHandler = null;

    /** @type {(() => void)|null} @private */
    this._newConversationHandler = null;

    /** @type {(() => void)|null} @private */
    this._binActiveHandler = null;

    /** @type {(() => void)|null} @private */
    this._renameActiveHandler = null;

    /** @type {number} @private Timestamp (ms) of the last accepted new-conversation create, for leading-edge debounce */
    this._lastCreateAt = 0;
  }

  connectedCallback() {
    _activeBar = this;
    this.render();
    this._findTabsContainer();
    this._setupKeyboardNavigation();
  }

  disconnectedCallback() {
    if (_activeBar === this) _activeBar = null;
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._llmStateUnsubscribe) {
      this._llmStateUnsubscribe();
      this._llmStateUnsubscribe = null;
    }
    if (this._focusTabListHandler) {
      document.removeEventListener('juggler:focus-tab-list', this._focusTabListHandler);
      this._focusTabListHandler = null;
    }
    if (this._barClickHandler) {
      this.removeEventListener('click', this._barClickHandler);
      this._barClickHandler = null;
    }
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
    if (this._focusOutHandler) {
      this.removeEventListener('focusout', this._focusOutHandler);
      this._focusOutHandler = null;
    }
    if (this._cycleTabHandler) {
      window.removeEventListener('juggler:cycle-tab', this._cycleTabHandler);
      this._cycleTabHandler = null;
    }
    if (this._newConversationHandler) {
      document.removeEventListener('juggler:new-conversation', this._newConversationHandler);
      this._newConversationHandler = null;
    }
    if (this._binActiveHandler) {
      document.removeEventListener('juggler:bin-active-conversation', this._binActiveHandler);
      this._binActiveHandler = null;
    }
    if (this._renameActiveHandler) {
      document.removeEventListener('juggler:rename-active-conversation', this._renameActiveHandler);
      this._renameActiveHandler = null;
    }
  }

  /**
   * Find and store reference to conversation-tabs-container
   * @private
   */
  _findTabsContainer() {
    this._tabsContainer = document.querySelector('conversation-tabs-container');
    if (!this._tabsContainer) {
      console.error('[ConversationBar] Could not find conversation-tabs-container');
    }
  }

  /**
   * Set up keyboard navigation for the tab list focus mode.
   * @private
   */
  _setupKeyboardNavigation() {
    if (this._keydownHandler || this._focusTabListHandler) return;

    this._focusTabListHandler = () => this._enterTabListFocus();

    // A click on the bar's empty background focuses the tab list — the same
    // mode ArrowLeft out of the leftmost conversation column enters — so a bar
    // click becomes a way into keyboard tab navigation (↑/↓ switch, Enter
    // renames, → enters the conversation, Esc leaves), and fixes a click landing
    // on inert chrome that left focus somewhere Return couldn't reach.
    //
    // The empty area is mostly the info-rail (flex:1, it grows to fill the space
    // above the Bin), so we can't exclude the rail wholesale — only the things
    // with their own click behaviour: tabs, the info cards, and any interactive
    // control (the +, Bin, card buttons/links, the resize handle). A click that
    // misses all of those — bare rail, gaps, padding — enters tab-list focus.
    this._barClickHandler = (e) => {
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (!target) return;
      if (target.closest(
        '.conversation-tab, .info-card, col-resize-handle, button, a, input, textarea, select',
      )) return;
      this._enterTabListFocus();
    };

    this._keydownHandler = (e) => {
      if (!this.classList.contains('tab-list-focused')) return;

      // Stand down while an overlay owns the keyboard: this document-level
      // handler switches tabs behind the popup, so ↑/↓ must not reach it. Same
      // shared rule as the central dispatcher (KeyShortcutManager).
      if (keyShortcutManager.suppressedByOverlay()) return;

      const target = /** @type {Element|null} */ (e.target);
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (target?.closest('action-confirmation')) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          this._switchAdjacentTab(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._switchAdjacentTab(1);
          break;
        case 'ArrowRight':
          // Move right, out of the tab list and into the conversation — commit
          // the selection and focus its composer (same as _enterActiveTab).
          e.preventDefault();
          this._enterActiveTab();
          break;
        case 'Escape':
          e.preventDefault();
          this._exitTabListFocus();
          break;
        case 'Enter':
          // Return, while the tab bar itself is focused, renames the active
          // tab (Finder-style). Escape / ArrowRight remain the "leave tab-list
          // focus" affordances.
          e.preventDefault();
          this._exitTabListFocus();
          this._enterRenameMode(this._session?.visibleConversationId || '');
          break;
      }
    };

    this._focusOutHandler = () => {
      queueMicrotask(() => {
        if (!this.matches(':focus-within')) {
          this._exitTabListFocus();
        }
      });
    };

    this._cycleTabHandler = (e) => this._handleCycleTab(e);

    // Command shortcuts route here so a keystroke and a click share one path:
    // "new conversation" reuses the cap + inline-rename UX; "bin" reuses the
    // running-turn guard + fly-to-bin animation, always targeting the visible tab.
    this._newConversationHandler = () => { void this._createConversation(); };
    this._binActiveHandler = () => {
      const id = this._session?.visibleConversationId;
      if (id) void this._binConversation(id);
    };
    // F2 (from the KeyShortcutManager) opens inline rename on the visible tab —
    // the same UX as clicking the already-active tab.
    this._renameActiveHandler = () => {
      const id = this._session?.visibleConversationId;
      if (id) this._enterRenameMode(id);
    };

    document.addEventListener('juggler:focus-tab-list', this._focusTabListHandler);
    this.addEventListener('click', this._barClickHandler);
    document.addEventListener('keydown', this._keydownHandler);
    this.addEventListener('focusout', this._focusOutHandler);
    window.addEventListener('juggler:cycle-tab', this._cycleTabHandler);
    document.addEventListener('juggler:new-conversation', this._newConversationHandler);
    document.addEventListener('juggler:bin-active-conversation', this._binActiveHandler);
    document.addEventListener('juggler:rename-active-conversation', this._renameActiveHandler);
  }

  /**
   * Enter tab-list focus mode: the bar itself takes keyboard focus, so ↑/↓
   * switch tabs, Enter renames the active tab, → enters the conversation, and
   * Esc leaves. Reached two ways — ArrowLeft out of the leftmost conversation
   * column (via the juggler:focus-tab-list event) and a click on the bar's
   * empty background (see the click handler in _setupKeyboardNavigation).
   * @private
   */
  _enterTabListFocus() {
    this.classList.add('tab-list-focused');
    this.setAttribute('tabindex', '-1');
    this.focus({ preventScroll: true });
    this._scrollActiveTabIntoView();
  }

  /** @private */
  _exitTabListFocus() {
    this.classList.remove('tab-list-focused');
    if (document.activeElement === this) this.blur();
  }

  /** @private */
  _enterActiveTab() {
    this._exitTabListFocus();
    const activeTab = /** @type {any} */ (this._tabElements.get(this._session?.visibleConversationId || ''));
    activeTab?._focusInput?.();
  }

  /** @private */
  _scrollActiveTabIntoView() {
    const activeTab = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tab.active'));
    activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  /**
   * @param {number} step
   * @param {{focusInput?: boolean}} [options]
   * @private
   */
  _switchAdjacentTab(step, options = {}) {
    if (!this._session) return;
    const ids = Array.from(this._session.conversations.keys());
    if (ids.length < 2) return;

    const currentId = this._session.visibleConversationId;
    const currentIdx = currentId ? ids.indexOf(currentId) : -1;
    const nextIdx = ((currentIdx < 0 ? 0 : currentIdx + step) + ids.length) % ids.length;
    const nextId = ids[nextIdx];
    if (nextId && nextId !== currentId) {
      this._switchConversation(nextId, options);
      requestAnimationFrame(() => this._scrollActiveTabIntoView());
    }
  }

  /**
   * Handle the Ctrl+Tab / Ctrl+Shift+Tab accelerator, dispatched from the
   * native window as a `juggler:cycle-tab` event (WKWebView eats the keystroke
   * before page JS, so the round-trip through Wails is required; in a browser
   * the event never fires). Unlike arrow-key navigation within the tab list,
   * cycling commits like a click: it leaves tab-list-focus mode and gives the
   * newly-shown tab's input box keyboard focus.
   * @param {Event} e
   * @private
   */
  _handleCycleTab(e) {
    const detail = /** @type {CustomEvent} */ (e).detail;
    const step = detail?.direction === 'prev' ? -1 : 1;
    this._exitTabListFocus();
    this._switchAdjacentTab(step, { focusInput: true });
  }

  /**
   * Set the session to display conversations from
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    // Unsubscribe from old session
    if (this._unsubscribe) {
      this._unsubscribe();
    }
    if (this._llmStateUnsubscribe) {
      this._llmStateUnsubscribe();
      this._llmStateUnsubscribe = null;
    }

    this._session = session;

    // Subscribe to LLM status changes so we can update per-tab indicator classes
    // without re-rendering the whole bar. Pull the (shared) llmState off any
    // conversation; new conversations registered later use the same instance.
    const anyConv = session.conversations.values().next().value;
    const llmState = anyConv?._llmState;
    if (llmState && typeof llmState.addStatusObserver === 'function') {
      this._llmStateUnsubscribe = llmState.addStatusObserver(
        (/** @type {string} */ convId) => this._refreshTabStatus(convId)
      );
    }

    // Subscribe to session changes
    this._unsubscribe = session.subscribe(/** @param {SessionEvent} event */ (event) => {
      if (event.type === 'conversation:created') {
        this._handleConversationCreated(event.data);
      } else if (event.type === 'conversation:deleted') {
        this._handleConversationDeleted(event.data);
      } else if (event.type === 'conversation:switched') {
        this._handleConversationSwitched(event.data);
      } else if (event.type === 'conversation:rename-requested') {
        this._enterRenameMode(event.data.conversationId);
      }

      // Re-render tab buttons whenever conversations change
      if (event.type === 'conversation:created' ||
          event.type === 'conversation:deleted' ||
          event.type === 'conversation:switched' ||
          event.type === 'conversation:reordered' ||
          event.type === 'conversation:changed') {
        this.render();
      }
    });

    // Create conversation-tab elements for existing conversations
    this._initializeConversationTabs();

    this.render();
  }

  /**
   * Initialize conversation-tab elements for all existing conversations
   * @private
   */
  _initializeConversationTabs() {
    if (!this._session || !this._tabsContainer) {
      return;
    }

    // Create tab element for each conversation
    this._session.conversations.forEach((conversation) => {
      this._createConversationTab(conversation);
    });

    // Show the visible conversation's tab
    const visibleId = this._session.visibleConversationId;
    if (visibleId) {
      this._showTab(visibleId);
    }
  }

  /**
   * Create a conversation-tab element for a conversation
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _createConversationTab(conversation) {
    if (!this._tabsContainer) {
      console.error('[ConversationBar] Cannot create tab: container not found');
      return;
    }

    // Idempotent: if a tab already exists for this id, rebind the
    // conversation object and return. Guards against duplicate
    // `conversation:created` events (e.g. originator + broadcast echo race
    // on create) leaking an orphaned `<conversation-tab>` into the DOM —
    // _tabElements.set would overwrite the Map entry but the first element
    // would stay parented in the container, untouched by future setActive/
    // setHidden/remove calls and visible forever.
    const existing = this._tabElements.get(conversation.id);
    if (existing) {
      // @ts-ignore - setConversation is a method on conversation-tab
      existing.setConversation(conversation);
      return;
    }

    // Import and create tab element
    const tabElement = document.createElement('conversation-tab');
    tabElement.id = `conversation-tab-${conversation.id}`;

    // Start hidden
    // @ts-ignore - setHidden is a method on conversation-tab
    tabElement.setHidden();

    // Store reference
    this._tabElements.set(conversation.id, tabElement);

    // Append to container FIRST (this triggers connectedCallback)
    this._tabsContainer.appendChild(tabElement);

    // THEN link conversation to tab (child elements now exist)
    // @ts-ignore - setConversation is a method on conversation-tab
    tabElement.setConversation(conversation);
  }

  /**
   * Show a specific conversation tab, hide others
   * @param {string} conversationId
   * @private
   */
  _showTab(conversationId) {
    this._tabElements.forEach((tabElement, id) => {
      if (id === conversationId) {
        // @ts-ignore - setActive is a method on conversation-tab
        tabElement.setActive();
      } else {
        // @ts-ignore - setHidden is a method on conversation-tab
        tabElement.setHidden();
      }
    });
  }

  /**
   * Handle conversation created event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationCreated(conversation) {
    this._createConversationTab(conversation);
    // If the session was empty when setSession() ran, the llmState observer
    // hasn't been wired up yet. Wire it now using this first conversation.
    if (!this._llmStateUnsubscribe && conversation._llmState
        && typeof conversation._llmState.addStatusObserver === 'function') {
      this._llmStateUnsubscribe = conversation._llmState.addStatusObserver(
        (/** @type {string} */ convId) => this._refreshTabStatus(convId)
      );
    }
    // Switch to the new conversation (will be handled by conversation:switched event)
  }

  /**
   * Handle conversation deleted event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationDeleted(conversation) {
    const tabElement = this._tabElements.get(conversation.id);
    if (tabElement) {
      // Remove from DOM
      tabElement.remove();
      // Remove from map
      this._tabElements.delete(conversation.id);
    }
  }

  /**
   * Handle conversation switched event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationSwitched(conversation) {
    this._showTab(conversation.id);
  }

  render() {
    if (!this._session) {
      this.innerHTML = '<div class="conversation-bar-empty">No session loaded</div>';
      return;
    }

    // Get or create nav container (only created once)
    let nav = /** @type {HTMLElement|null} */ (this._cachedElements.get('nav'));
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'conversation-bar';
      this._cachedElements.set('nav', nav);
      this.innerHTML = '';
      this.appendChild(nav);

      // Resize handle on the right edge of the sidebar (reuses miller-column logic)
      const handle = document.createElement('col-resize-handle');
      this.appendChild(handle);

      // Detect double-tap/double-click via timing so it works for both mouse
      // and touch (dblclick doesn't fire reliably on touch devices).
      let lastTapTime = 0;
      handle.addEventListener('pointerdown', (e) => {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this._autoFitWidth();
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      }, true);

      setupColumnResize(this, 'juggler-tab-sidebar-width', 8);
    }

    // Get or create tabs menu container (only created once, preserves scroll position)
    let tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabsMenu) {
      tabsMenu = document.createElement('menu');
      tabsMenu.className = 'conversation-tabs';
      this._cachedElements.set('tabs-menu', tabsMenu);
      nav.appendChild(tabsMenu);
    }

    // Ambient info cards (Tips, Git status, …), parked in the empty space above
    // the Bin. Created once and cached; it manages its own visibility and measures
    // the sidebar's free space to decide how many cards fit (reconciled at the end
    // of render()). Sits between the flex:1 tabs menu and the Bin, resting above it.
    let infoRail = /** @type {any} */ (this._cachedElements.get('info-rail'));
    if (!infoRail) {
      infoRail = document.createElement('info-rail');
      this._cachedElements.set('info-rail', infoRail);
      nav.appendChild(infoRail);
    }
    infoRail.setSession(this._session);

    // The "i" info-cards menu — the un-hide surface for cards closed via their ×.
    // Created once and cached; it manages its own visibility (shown only when at
    // least one info card is enabled) and sits just below the rail, above the Bin.
    let infoCardsBtn = /** @type {any} */ (this._cachedElements.get('info-cards-button'));
    if (!infoCardsBtn) {
      infoCardsBtn = document.createElement('info-cards-button');
      this._cachedElements.set('info-cards-button', infoCardsBtn);
      nav.appendChild(infoCardsBtn);
    }

    // Bottom-of-bar "Bin" button — opens the bin modal.
    let binBtn = /** @type {HTMLButtonElement|null} */ (this._cachedElements.get('bin-button'));
    if (!binBtn) {
      binBtn = document.createElement('button');
      binBtn.className = 'conversation-bin-button';
      binBtn.title = 'View binned conversations';
      binBtn.setAttribute('aria-label', 'Open bin');
      binBtn.innerHTML = `${BIN_ICON_SVG}<span class="conversation-bin-label">Bin</span><span class="conversation-bin-size" hidden></span><span class="conversation-bin-count" hidden></span>`;
      binBtn.addEventListener('click', () => this._openBinModal());
      this._cachedElements.set('bin-button', binBtn);
      nav.appendChild(binBtn);
    }

    // Refresh the count badge + size hint from session state on every render.
    const count = this._session.binnedCount || 0;
    const sizeBytes = this._session.binSizeBytes || 0;
    const countEl = /** @type {HTMLElement|null} */ (binBtn.querySelector('.conversation-bin-count'));
    if (countEl) {
      if (count > 0) {
        countEl.textContent = String(count);
        countEl.hidden = false;
      } else {
        countEl.textContent = '';
        countEl.hidden = true;
      }
    }
    // Approximate folder size, shown only when there's something in the bin
    // and the server has reported a non-zero tally (it refreshes lazily).
    const sizeEl = /** @type {HTMLElement|null} */ (binBtn.querySelector('.conversation-bin-size'));
    if (sizeEl) {
      if (count > 0 && sizeBytes > 0) {
        sizeEl.textContent = formatBytes(sizeBytes);
        sizeEl.hidden = false;
      } else {
        sizeEl.textContent = '';
        sizeEl.hidden = true;
      }
    }
    if (count > 0) {
      const items = `${count} ${count === 1 ? 'conversation' : 'conversations'}`;
      binBtn.title = sizeBytes > 0
        ? `View binned conversations — ${items} (${formatBytes(sizeBytes)})`
        : `View binned conversations — ${items}`;
    } else {
      binBtn.title = 'View binned conversations';
    }

    // Convert Map to array for rendering
    const conversations = Array.from(this._session.conversations.values());
    const visibleId = this._session.visibleConversationId;

    // Get or create add button (only created once) and pin it to the top
    let addButton = /** @type {HTMLElement|null} */ (this._cachedElements.get('add-button'));
    if (!addButton) {
      addButton = document.createElement('li');
      addButton.className = 'conversation-add-item';
      addButton.innerHTML = `
        <button class="conversation-add"
                title="New conversation" data-shortcut-id="new-conversation"
                aria-label="Create new conversation">+</button>
      `;
      this._cachedElements.set('add-button', addButton);

      const addBtn = addButton.querySelector('.conversation-add');
      if (addBtn) {
        addBtn.addEventListener('click', () => this._createConversation());
      }
    }
    if (addButton.parentNode !== tabsMenu || tabsMenu.firstChild !== addButton) {
      tabsMenu.insertBefore(addButton, tabsMenu.firstChild);
    }

    // Track which conversation IDs are still present
    /** @type {Set<string>} */
    const currentConversationIds = new Set(conversations.map(c => c.id));

    // Update or create tab elements for each conversation, in Map order.
    for (const conv of conversations) {
      this._renderOrUpdateTab(conv, visibleId, tabsMenu);
    }

    // Reorder tabs to match Map order, but only move tabs that are out of
    // place — re-inserting a node restarts CSS animations on it (used by the
    // tab status bar pulse), so we skip moves that don't change position.
    let expected = addButton.nextSibling;
    for (const conv of conversations) {
      const tab = this._cachedElements.get(conv.id);
      if (!tab) continue;
      if (tab !== expected) {
        tabsMenu.insertBefore(tab, expected);
      }
      expected = tab.nextSibling;
    }

    // Remove tabs for deleted conversations
    for (const [id, element] of this._cachedElements) {
      if (id !== 'nav' && id !== 'tabs-menu' && id !== 'add-button' && id !== 'bin-button' && id !== 'info-rail' && id !== 'info-cards-button' && !currentConversationIds.has(id)) {
        element.remove();
        this._cachedElements.delete(id);
      }
    }

    // Reconcile the ambient info rail LAST, once the tabs are laid out, so it can
    // measure the real free space in the sidebar and show/hide cards accordingly.
    if (infoRail && typeof infoRail.update === 'function') {
      infoRail.update();
    }
  }

  /**
   * Render or update a tab element for a conversation (diff-based update)
   * @param {import('../model/conversation.js').default} conv - The conversation
   * @param {string|null} visibleId - The currently visible conversation ID
   * @param {HTMLElement} tabsMenu - The tabs menu container
   * @private
   */
  _renderOrUpdateTab(conv, visibleId, tabsMenu) {
    const name = conv.name || 'Untitled';
    const isActive = conv.id === visibleId;

    // Get existing tab element or create new one
    let tab = /** @type {HTMLElement|null} */ (this._cachedElements.get(conv.id));

    if (!tab) {
      // Create new tab element
      tab = document.createElement('li');
      tab.className = 'conversation-tab';
      tab.dataset.conversationId = conv.id;

      tab.innerHTML = `
        <span class="tab-drag-handle" aria-hidden="true">⠿</span>
        <button class="conversation-tab-button">
          <span class="conversation-tab-name"></span>
        </button>
      `;
      const newName = tab.querySelector('.conversation-tab-name');
      if (newName) newName.textContent = name;

      this._cachedElements.set(conv.id, tab);

      // Attach event listeners (only once per tab)
      this._attachTabEventListeners(tab, conv.id);

      // Add to DOM (render() reorders to the correct position after this).
      tabsMenu.appendChild(tab);
    } else {
      // Update existing tab in-place. DO NOT re-append unconditionally:
      // moving a node restarts its CSS animations (status-bar pulse).
      // render() fixes order separately and only moves nodes that need to move.
      const tabName = tab.querySelector('.conversation-tab-name');

      // Don't disturb the input while the user is mid-rename. The post-commit
      // teardown removes .is-renaming and a subsequent render() paints the name.
      if (tabName && !tab.classList.contains('is-renaming')) {
        tabName.textContent = name;
      }
    }

    // Update classes (toggle rather than overwrite — overwriting .className
    // would clear .is-running and restart the CSS pulse animation).
    tab.classList.toggle('active', isActive);
    tab.classList.add('has-close');
    if (isActive) {

      // Scroll active tab into view (preserving overall scroll position for other tabs)
      // Use requestAnimationFrame to ensure DOM has updated before scrolling
      requestAnimationFrame(() => {
        tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
    }

    // The trailing slot holds two mutually-exclusive elements at the same size:
    // the activity blob (pulsing green circle, shown while the LLM loop runs)
    // and the bin button. CSS shows whichever fits the tab's state —
    // archiving is suppressed mid-loop, so the layout never shifts.
    let activity = tab.querySelector('.conversation-tab-activity');
    if (!activity) {
      activity = document.createElement('span');
      activity.className = 'conversation-tab-activity';
      activity.setAttribute('aria-hidden', 'true');
      tab.appendChild(activity);
    }

    // Every tab carries a "move to bin" button (the last one included —
    // binning to an empty session is allowed). It's hover-only (see CSS); the
    // Bin entry at the bottom of the bar keeps the feature discoverable
    // without per-tab visual clutter.
    let binButton = /** @type {HTMLButtonElement|null} */ (tab.querySelector('.conversation-tab-bin'));
    if (!binButton) {
      binButton = document.createElement('button');
      binButton.className = 'conversation-tab-bin';
      binButton.title = 'Move conversation to bin';
      // The tooltip-manager appends the platform-correct combo (e.g. " (⌘⌫)")
      // from this shortcut id — no hard-coded key text in the markup.
      binButton.setAttribute('data-shortcut-id', 'bin-conversation');
      binButton.setAttribute('aria-label', `Move ${name} to bin`);
      binButton.innerHTML = BIN_ICON_SVG;
      tab.appendChild(binButton);

      binButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._binConversation(conv.id);
      });
    } else {
      binButton.setAttribute('aria-label', `Move ${name} to bin`);
    }

    // Sync the running / awaiting-approval indicator classes for this tab.
    this._refreshTabStatus(conv.id);
  }

  /**
   * Toggle status indicator classes (.is-running / .is-awaiting) on a single
   * tab based on the current LLMState. Targeted update — no full re-render.
   * @param {string} convId
   * @private
   */
  _refreshTabStatus(convId) {
    const tab = this._cachedElements.get(convId);
    if (!tab) return;
    const { awaiting, running } = this._conversationActivity(convId);
    tab.classList.toggle('is-awaiting', awaiting);
    tab.classList.toggle('is-running', running);
  }

  /**
   * Single source of truth for a conversation's live activity, split into the
   * two visually-distinct states a tab can be in. `awaiting` trumps `running`:
   * while a turn is parked on a tool approval the worker keeps publishing
   * processing_tools, so isConversationProcessing() stays true — we report
   * `awaiting` and subtract it back out of `running`. Both consumers read from
   * here so they can never drift:
   *  - _refreshTabStatus paints .is-awaiting (orange) / .is-running (green).
   *  - _isConversationBusy gates binning on `running` ALONE — an awaiting tab is
   *    parked on the user, executes nothing, and bins reversibly, so it is
   *    deliberately NOT busy for the purpose of the bin guard.
   *
   * "Awaiting" comes from Yjs (tool-action state === PENDING / AWAITING_APPROVAL
   * anywhere in the tree) — the shared source of truth across the engine and
   * every viewer. The whole tree is searched so an approval parked deep inside a
   * sub-thread still counts.
   * @param {string} convId
   * @returns {{awaiting: boolean, running: boolean}} The tab's two activity flags.
   * @private
   */
  _conversationActivity(convId) {
    const conv = this._session?.conversations.get(convId);
    const llm = conv?._llmState;
    if (!conv || !llm) return { awaiting: false, running: false };
    const rootThread = /** @type {any} */ (conv).rootMessageThread;
    const awaiting = !!rootThread && hasPendingApprovalInTree(rootThread.items);
    return { awaiting, running: !awaiting && llm.isConversationProcessing(convId) };
  }

  /**
   * Attach event listeners to a tab element (called once per tab on creation)
   * @param {HTMLElement} tab - The tab element
   * @param {string} id - The conversation ID
   * @private
   */
  _attachTabEventListeners(tab, id) {
    // Click to switch or rename
    tab.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (target?.closest('.conversation-tab-bin')) return;

      this._exitTabListFocus();

      // Prevent click after drag
      if (this._dragJustOccurred) return;

      if (tab.classList.contains('is-renaming')) return;

      if (id === this._session?.visibleConversationId) {
        this._enterRenameMode(id);
      } else {
        this._switchConversation(id, { focusInput: true });
      }
    });

    // Rename rides on click, not dblclick (WebKit/touch misfires dblclick for
    // rapid taps across different elements): first click switches to the tab, a
    // second click on the now-active tab renames it.

    // Drag to reorder — touch/pen must start on the drag handle;
    // mouse can drag from anywhere on the tab.
    tab.addEventListener('pointerdown', (e) => {
      const event = /** @type {PointerEvent} */ (e);
      if (event.button !== 0) return;
      const target = /** @type {HTMLElement|null} */ (event.target);
      if (target?.closest('.conversation-tab-bin')) return;
      if (target?.closest('.conversation-tab-rename')) return;
      if (event.pointerType !== 'mouse' && !target?.closest('.tab-drag-handle')) return;
      this._startDrag(event, tab);
    });
  }

  /**
   * Switch to a different conversation.
   * @param {string} conversationId
   * @param {{focusInput?: boolean}} [options]
   * @private
   */
  _switchConversation(conversationId, options = {}) {
    const { focusInput = false } = options;
    if (!this._session) {
      return;
    }

    const success = this._session.switchConversation(conversationId);
    if (!success) {
      console.error('[ConversationBar] Failed to switch conversation:', conversationId);
      return;
    }

    if (focusInput) {
      requestAnimationFrame(() => {
        const activeTab = /** @type {any} */ (this._tabElements.get(conversationId));
        activeTab?._focusInput?.();
      });
    }
  }

  /**
   * Move a conversation to the bin (.juggler/bin/). No confirmation:
   * binning is reversible from the Bin modal at any time. Plays a
   * brief fly-into-Bin animation in parallel with the backend call,
   * honoring prefers-reduced-motion.
   * @param {string} conversationId
   * @private
   * @async
   */
  async _binConversation(conversationId) {
    if (!this._session) {
      return;
    }
    // Refuse only while a turn is genuinely in flight (.is-running): binning
    // mid-stream would orphan it at the turn boundary. An awaiting-approval tab
    // is parked on the user and executes nothing, so it bins reversibly and is
    // intentionally allowed through. The per-tab bin button is already hidden by
    // CSS while .is-running, but that's cosmetic and races the
    // just-sent→is-running transition, and the context-menu "Move to Bin" has no
    // CSS gate at all — so this guard backstops every affordance at the single
    // action site they all route through.
    if (this._isConversationBusy(conversationId)) {
      return;
    }
    this._flyTabToBin(conversationId);
    await this._session.binConversation(conversationId);
  }

  /**
   * Whether a conversation has a turn genuinely in flight — i.e. the .is-running
   * (green) state: actively streaming or executing, NOT merely parked on a tool
   * approval. Reads the shared _conversationActivity predicate so this can never
   * disagree with the tab's status light. An awaiting-approval tab returns false
   * here on purpose: it executes nothing and bins reversibly. Pure read; safe to
   * call from action handlers.
   * @param {string} conversationId
   * @returns {boolean} True only while a turn is actively running.
   * @private
   */
  _isConversationBusy(conversationId) {
    return this._conversationActivity(conversationId).running;
  }

  /**
   * Duplicate a specific conversation and switch to the clone. Mirrors the
   * Cmd-shortcut path in app.js but targets an explicit conversation id (the
   * right-clicked tab), not necessarily the visible one.
   * @param {string} conversationId
   * @private
   * @async
   */
  async _duplicateConversation(conversationId) {
    if (!this._session) return;
    if (this._session.conversations.size >= MAX_CONVERSATIONS) {
      await /** @type {WindowWithModals} */ (/** @type {any} */ (window)).showAlert(
        CONVERSATION_LIMIT_MESSAGE,
        'Too many conversations'
      );
      return;
    }
    const newId = await this._session.duplicateConversation(conversationId);
    if (newId) {
      this._session.switchConversation(newId);
    }
  }

  /**
   * Detach the tab from layout and fly it toward the Bin button.
   * No-op if motion is reduced or either element is missing. The tab is
   * removed from `_cachedElements` so the next render() cleanup pass
   * leaves it alone; the animation removes the DOM node itself.
   * @param {string} conversationId
   * @private
   */
  _flyTabToBin(conversationId) {
    const tabEl = this._cachedElements.get(conversationId);
    const binBtn = this._cachedElements.get('bin-button');
    if (!tabEl || !binBtn) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const from = tabEl.getBoundingClientRect();
    const to = binBtn.getBoundingClientRect();
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);

    // Detach from layout so neighbouring tabs collapse smoothly.
    this._cachedElements.delete(conversationId);
    tabEl.style.position = 'fixed';
    tabEl.style.left = `${from.left}px`;
    tabEl.style.top = `${from.top}px`;
    tabEl.style.width = `${from.width}px`;
    tabEl.style.margin = '0';
    tabEl.style.pointerEvents = 'none';
    tabEl.style.zIndex = '1000';
    document.body.appendChild(tabEl);

    const anim = tabEl.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.15)`, opacity: 0 }
      ],
      { duration: 280, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
    );
    anim.onfinish = () => tabEl.remove();
    anim.oncancel = () => tabEl.remove();
  }

  /**
   * Open the Bin modal listing binned conversations.
   * @private
   * @async
   */
  async _openBinModal() {
    if (!this._session) return;
    let modal = /** @type {any} */ (document.querySelector('bin-modal'));
    if (!modal) {
      modal = document.createElement('bin-modal');
      document.body.appendChild(modal);
    }
    modal.open(this._session);
  }

  /**
   * Create a new conversation with smart numbering
   * Finds the smallest unused number for "Task N"
   * @private
   */
  async _createConversation() {
    if (!this._session) {
      return;
    }

    // Debounce accidental double-activation (notably a double-click on the "+"
    // button): the create is async, so the second click lands before the first
    // `createConversation` resolves and would spawn a second tab. Leading edge —
    // the first activation acts immediately, repeats within the window are
    // swallowed. Stamped before the cap check so a double-click at the cap
    // raises only one alert, and covers every path that funnels here (the "+"
    // click, the new-conversation shortcut/event), not just the button.
    const now = Date.now();
    if (now - this._lastCreateAt < NEW_CONVERSATION_DEBOUNCE_MS) {
      return;
    }
    this._lastCreateAt = now;

    // Cap reached: don't create — point the user at archiving instead. The
    // model enforces the same limit (so duplicate/other paths can't exceed it);
    // pre-checking here keeps the "+" UX side-effect-free (no rename popover).
    if (this._session.conversations.size >= MAX_CONVERSATIONS) {
      await /** @type {WindowWithModals} */ (/** @type {any} */ (window)).showAlert(
        CONVERSATION_LIMIT_MESSAGE,
        'Too many conversations'
      );
      return;
    }

    // Empty name → the session assigns the canonical "Task N" and, because this
    // is an activated unnamed create, asks the bar to open inline rename (see the
    // 'conversation:rename-requested' branch in setSession). The /new command
    // creates the same way, so both share one "name it now" behaviour.
    await this._session.createConversation('', { activate: true, origin: 'plus-button' });
  }


  /**
   * Enter inline rename mode on the tab for the given conversation. Builds a
   * rename block inside the tab `<li>`, hides the normal tab button via the
   * `.is-renaming` class, and wires Enter/Escape/blur to commit or cancel.
   *
   * The rename block reserves a `.conversation-tab-rename-actions` slot under
   * the input for a future auto-name button. When the rename editor closes
   * (commit, cancel, or blur), keyboard focus moves to the visible
   * conversation's message input so the user can type straight after naming.
   * @param {string} conversationId
   * @param {object} [options]
   * @param {string} [options.initialValue] - Seed value for the input,
   *   overriding `conv.name`. The new-tab flow passes the canonical name to
   *   avoid a refresh race where the input briefly shows the wrong value.
   * @private
   */
  _enterRenameMode(conversationId, { initialValue } = {}) {
    if (!this._session) return;

    const conv = this._session.getConversation(conversationId);
    if (!conv) return;

    // Renaming a stub would race the worker's metadata: the rename writes to
    // the doc, then the worker's first metadata observer fires and clobbers
    // the new name with the disk-loaded one. Force the user to wait until
    // hydration finishes (panel spinner makes this state visible).
    if (conv.loadState !== 'loaded') return;

    const tab = /** @type {HTMLElement|null} */ (this._cachedElements.get(conversationId));
    if (!tab) return;

    // Idempotent: if already renaming, refocus the existing input.
    if (tab.classList.contains('is-renaming')) {
      const existing = /** @type {HTMLInputElement|null} */ (tab.querySelector('.conversation-tab-rename-input'));
      existing?.focus();
      existing?.select();
      return;
    }

    const original = initialValue ?? conv.name;

    const block = document.createElement('div');
    block.className = 'conversation-tab-rename';
    block.innerHTML = `
      <input class="conversation-tab-rename-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
      <div class="conversation-tab-rename-error" hidden></div>
      <div class="conversation-tab-rename-actions"></div>
    `;
    const input = /** @type {HTMLInputElement} */ (block.querySelector('.conversation-tab-rename-input'));
    const errorEl = /** @type {HTMLElement} */ (block.querySelector('.conversation-tab-rename-error'));
    // UI-level enforcement of the shared name-length cap: the browser blocks
    // further typed input at the limit. This input backs both rename and the
    // "name a new conversation" flow, so both paths are covered here. The data
    // level (Session.renameConversation) is the backstop for paste/programmatic
    // input that can exceed maxlength.
    input.maxLength = MAX_CONVERSATION_NAME_LENGTH;
    input.value = original;

    // Stop clicks inside the rename block from bubbling to the tab's click
    // handler (which would re-trigger rename) and from initiating a drag.
    block.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    block.addEventListener('click', (e) => { e.stopPropagation(); });

    // `done` blocks any further commit/cancel work once teardown has run —
    // covers the blur that fires when teardown() removes the focused input,
    // and any double-commit from rapid Enter+blur sequences.
    let done = false;

    const showError = (/** @type {string} */ msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      input.focus();
      input.select();
    };

    const teardown = () => {
      if (done) return;
      done = true;
      tab.classList.remove('is-renaming');
      if (block.parentNode) block.parentNode.removeChild(block);
      // Hand off to the visible conversation's input-box so the user can type
      // straight after naming. We look it up through the conversation-tab
      // element registered with the bar rather than a global query, so the
      // lookup stays correct even when multiple conversation-tabs are mounted
      // side-by-side.
      const tabEl = this._tabElements.get(conversationId);
      const textarea = /** @type {HTMLTextAreaElement|null} */ (
        tabEl?.querySelector('input-box textarea') || null
      );
      textarea?.focus();
    };

    const commit = async () => {
      if (done) return;
      const newName = input.value.trim();
      // Garbage input (empty/whitespace, unchanged, or rejected by the
      // server as INVALID) silently cancels. Only a real collision warrants
      // keeping the editor open with a message.
      if (newName === '' || newName === original) {
        teardown();
        return;
      }
      try {
        await /** @type {NonNullable<typeof this._session>} */ (this._session).renameConversation(conv.id, newName);
        teardown();
        this.render();
      } catch (e) {
        const code = /** @type {any} */ (e)?.code;
        if (code === 'COLLISION') {
          showError(`“${newName}” is already used by another conversation.`);
          return;
        }
        if (code === 'INVALID') {
          teardown();
          return;
        }
        teardown();
        await /** @type {WindowWithModals} */ (/** @type {any} */ (window)).showAlert(
          `Failed to rename conversation: ${/** @type {any} */ (e)?.message || e}`,
          'Rename failed'
        );
      }
    };

    const cancel = () => {
      teardown();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => {
      if (done) return;
      commit();
    });

    tab.classList.add('is-renaming');
    tab.appendChild(block);
    input.focus();
    input.select();
  }


  /**
   * Start drag operation
   * @param {PointerEvent} e
   * @param {HTMLElement} tab
   * @private
   */
  _startDrag(e, tab) {
    const order = Array.from(this.querySelectorAll('.conversation-tab:not(.drag-ghost)'))
      .map(t => /** @type {HTMLElement} */ (t).dataset.conversationId || '');
    const startIdx = order.indexOf(tab.dataset.conversationId || '');

    this._drag = { tab, startY: e.clientY, startOrder: order, startIdx, dropIdx: startIdx, pointerId: e.pointerId, active: false, ghost: null };
    tab.setPointerCapture(e.pointerId);

    /** @type {HTMLElement|null} */
    const scrollContainer = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tabs'));

    /** @type {number} Track latest pointer Y for auto-scroll loop */
    let lastClientY = e.clientY;
    const EDGE_HOTZONE = 30;
    const MAX_SCROLL_STEP = 18;
    // Only auto-scroll a genuinely overflowing list. A hair of sub-pixel overflow
    // (the menu's bottom padding + rounding) must not make a fully-fitting list
    // creep upward while you drag near its bottom edge.
    const SCROLL_OVERFLOW_MIN = 4;

    // Tabs in the list, excluding the floating ghost clone — it lives on the host
    // rather than the scroll container, yet still carries the .conversation-tab class.
    const listTabs = () =>
      /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('.conversation-tab:not(.drag-ghost)')));

    const recomputeDropAndShift = (/** @type {number} */ clientY) => {
      const d = this._drag;
      if (!d) return;
      const tabs = listTabs();
      const draggedId = d.tab.dataset.conversationId;
      let dropIdx = 0;
      for (const t of tabs) {
        if (t.dataset.conversationId === draggedId) continue;
        const rect = t.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (clientY > mid) dropIdx++;
      }
      d.dropIdx = dropIdx;

      // Animate siblings along the Y axis to open a gap at the drop position. The
      // dragged tab keeps its own slot (as an invisible placeholder), so the
      // siblings shift around it.
      const tabHeight = d.tab.getBoundingClientRect().height + 8;
      for (const el of tabs) {
        if (el.dataset.conversationId === draggedId) continue;
        const origIdx = d.startOrder.indexOf(el.dataset.conversationId || '');
        let shift = 0;
        if (d.startIdx < dropIdx && origIdx > d.startIdx && origIdx <= dropIdx) shift = -tabHeight;
        if (d.startIdx > dropIdx && origIdx >= dropIdx && origIdx < d.startIdx) shift = tabHeight;
        el.style.transform = shift ? `translateY(${shift}px)` : '';
      }
    };

    const updateAutoScroll = () => {
      if (!this._drag || !scrollContainer) {
        this._stopAutoScroll();
        return;
      }
      const rect = scrollContainer.getBoundingClientRect();
      const overflow = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const dyTop = lastClientY - rect.top;
      const dyBot = rect.bottom - lastClientY;
      let delta = 0;
      if (overflow > SCROLL_OVERFLOW_MIN) {
        if (dyTop < EDGE_HOTZONE && scrollContainer.scrollTop > 0) {
          delta = -Math.ceil(MAX_SCROLL_STEP * (1 - Math.max(0, dyTop) / EDGE_HOTZONE));
        } else if (dyBot < EDGE_HOTZONE &&
                   scrollContainer.scrollTop + scrollContainer.clientHeight < scrollContainer.scrollHeight) {
          delta = Math.ceil(MAX_SCROLL_STEP * (1 - Math.max(0, dyBot) / EDGE_HOTZONE));
        }
      }
      if (delta !== 0) {
        scrollContainer.scrollTop += delta;
        // The drop index can change when content moves under the (stationary)
        // pointer. The ghost is fixed to the viewport, so it naturally stays under
        // the pointer as the list scrolls beneath it — nothing to reposition here.
        recomputeDropAndShift(lastClientY);
        this._autoScrollRaf = requestAnimationFrame(updateAutoScroll);
      } else {
        this._autoScrollRaf = null;
      }
    };

    const maybeStartAutoScroll = () => {
      if (this._autoScrollRaf === null) {
        this._autoScrollRaf = requestAnimationFrame(updateAutoScroll);
      }
    };

    // Build the floating drag ghost: a clone of the tab positioned `fixed` on the
    // host. No layout ancestor establishes a containing block for fixed elements,
    // so it anchors to the viewport and escapes the tab list's overflow:auto clip,
    // free to travel the full height of the sidebar. Its fixed anchor is the tab's
    // resting rect (captured at grab time), so translating it by the pointer delta
    // keeps it under the finger exactly. The real tab stays in place as an invisible
    // placeholder (.drag-source) that the siblings shift around, so render()
    // reconciliation still finds it where it belongs.
    const createGhost = () => {
      const d = this._drag;
      if (!d) return;
      const rect = d.tab.getBoundingClientRect();
      const ghost = /** @type {HTMLElement} */ (d.tab.cloneNode(true));
      ghost.classList.add('drag-ghost');
      ghost.classList.remove('is-renaming');
      ghost.removeAttribute('data-conversation-id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      this.appendChild(ghost);
      d.ghost = ghost;
      d.tab.classList.add('drag-source');
    };

    const onMove = /** @param {PointerEvent} ev */ (ev) => {
      const d = this._drag;
      if (!d) return;

      const delta = ev.clientY - d.startY;
      if (!d.active && Math.abs(delta) < 5) return;

      // Activate drag mode on the first meaningful movement.
      if (!d.active) {
        d.active = true;
        scrollContainer?.classList.add('is-dragging');
        createGhost();
      }

      lastClientY = ev.clientY;
      if (d.ghost) d.ghost.style.transform = `translateY(${delta}px) scale(1.02)`;

      recomputeDropAndShift(ev.clientY);
      maybeStartAutoScroll();
    };

    const onUp = /** @param {PointerEvent} ev */ (ev) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      this._stopAutoScroll();

      const d = this._drag;
      if (!d) return;

      // Whether an actual drag occurred (not just a click)
      const wasDragging = d.active;

      // Commit if position changed
      if (wasDragging && d.dropIdx !== d.startIdx && this._session) {
        const draggedId = d.tab.dataset.conversationId;
        const filtered = d.startOrder.filter(id => id !== draggedId);
        if (draggedId) {
          if (d.dropIdx >= filtered.length) {
            this._session.moveConversationToEnd(draggedId);
          } else {
            this._session.reorderConversation(draggedId, /** @type {string} */ (filtered[d.dropIdx])); // bounded: dropIdx < filtered.length checked above
          }
        }
      }

      // Cleanup
      if (d.ghost) {
        d.ghost.remove();
        d.ghost = null;
      }
      d.tab.classList.remove('drag-source');
      d.tab.style.transform = '';
      d.tab.releasePointerCapture(ev.pointerId);
      scrollContainer?.classList.remove('is-dragging');
      this.querySelectorAll('.conversation-tab:not(.drag-ghost)').forEach(t => {
        /** @type {HTMLElement} */ (t).style.transform = '';
      });
      this._drag = null;

      // Prevent click/dblclick events if an actual drag occurred
      if (wasDragging) {
        this._dragJustOccurred = true;
        // Clear the flag after a short delay to allow future clicks
        setTimeout(() => {
          this._dragJustOccurred = false;
        }, 100);
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  /** @private */
  _stopAutoScroll() {
    if (this._autoScrollRaf !== null) {
      cancelAnimationFrame(this._autoScrollRaf);
      this._autoScrollRaf = null;
    }
  }

  /**
   * Auto-fit sidebar width to the widest tab (deterministic — measures every
   * tab li in an unbounded off-screen container, so the result doesn't depend
   * on the sidebar's current width).
   *
   * Triggered by double-clicking the resize handle.
   * @private
   */
  _autoFitWidth() {
    const tabs = Array.from(this.querySelectorAll('.conversation-tab:not(.drag-ghost)'))
      .map(el => /** @type {HTMLElement} */ (el));
    const tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabs.length || !tabsMenu) return;

    // Off-screen sizing host appended to the menu so it inherits exactly the
    // same fonts/padding/box-sizing cascade as the real tabs. Each tab is
    // cloned, given an unbounded layout (auto width, no wrapping), measured,
    // then thrown away. The sizing host is hidden and removed before return.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:max-content;display:block;';
    tabsMenu.appendChild(host);

    let maxTabWidth = 0;
    for (const tab of tabs) {
      const clone = /** @type {HTMLElement} */ (tab.cloneNode(true));
      // Strip any drag-related inline transform/state so a tab that happens to be
      // mid-drag (an invisible .drag-source) still measures at its natural size.
      clone.style.transform = '';
      clone.style.visibility = '';
      clone.classList.remove('drag-source');
      // Force natural width on the clone and its name span.
      clone.style.width = 'max-content';
      clone.style.flex = '0 0 auto';
      clone.style.maxWidth = 'none';
      clone.style.whiteSpace = 'nowrap';
      const name = /** @type {HTMLElement|null} */ (clone.querySelector('.conversation-tab-name'));
      if (name) {
        name.style.flex = '0 0 auto';
        name.style.overflow = 'visible';
        name.style.textOverflow = 'clip';
        name.style.maxWidth = 'none';
        name.style.whiteSpace = 'nowrap';
      }
      host.appendChild(clone);
      const cloneWidth = clone.getBoundingClientRect().width;
      host.removeChild(clone);
      if (cloneWidth > maxTabWidth) maxTabWidth = cloneWidth;
    }

    tabsMenu.removeChild(host);

    // Outer chrome that the tab li doesn't include: the menu's own padding +
    // reserved scrollbar gutter + the sidebar's right-edge resize handle.
    const menuStyle = window.getComputedStyle(tabsMenu);
    const menuPadLeft = parseFloat(menuStyle.paddingLeft) || 0;
    const menuPadRight = parseFloat(menuStyle.paddingRight) || 0;
    const scrollbarGutter = Math.max(0, tabsMenu.offsetWidth - tabsMenu.clientWidth);
    const handleEl = /** @type {HTMLElement|null} */ (this.querySelector(':scope > col-resize-handle'));
    const handleWidth = handleEl ? handleEl.getBoundingClientRect().width : 0;

    const remPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    // Extra 1rem of breathing room so descenders/italic glyphs don't ellipsise.
    const target = Math.max(
      8 * remPx,
      Math.min(
        50 * remPx,
        Math.ceil(maxTabWidth + menuPadLeft + menuPadRight + scrollbarGutter + handleWidth + remPx)
      )
    );

    applyColumnWidthPx(this, 'juggler-tab-sidebar-width', target, 8);
  }
}

// Register custom element
customElements.define('conversation-bar', ConversationBar);

// Export for modules
/** @type {WindowWithModals} */ (/** @type {any} */ (window)).ConversationBar = ConversationBar;

// Right-click menu for conversation tabs in the bar. Wired to the active bar's
// own helpers so rename/duplicate/bin behave exactly like the built-in
// affordances. Targets the tab `<li>` carrying the conversation id.
registerContextMenuProvider({
  match: (start) => start?.closest('.conversation-tab[data-conversation-id]') || null,
  build: (subject) => {
    const bar = /** @type {any} */ (_activeBar);
    const convId = /** @type {HTMLElement} */ (subject).dataset.conversationId || '';
    if (!bar || !convId) return null;
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [
      { label: 'Rename', onClick: () => bar._enterRenameMode(convId) },
      { label: 'Duplicate', onClick: () => { void bar._duplicateConversation(convId); } },
    ];
    // Omit "Move to Bin" mid-loop — same intent as the CSS that hides the
    // per-tab bin button while running. _binConversation enforces this too;
    // dropping the entry keeps the menu honest rather than offering a no-op.
    if (!bar._isConversationBusy(convId)) {
      items.push(
        { separator: true },
        { label: 'Move to Bin', danger: true, onClick: () => { void bar._binConversation(convId); } }
      );
    }
    return items;
  },
});

export default ConversationBar;
