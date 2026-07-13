//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup } from '../utils/popup-surface.js';

/**
 * @typedef {object} EventListener
 * @property {HTMLElement|Document|Window} element - Element with listener
 * @property {string} event - Event type
 * @property {function} handler - Event handler function
 * @property {object} [options] - Event listener options
 */

import { toggleTheme } from '../utils/theme-manager.js';
import { toggleSound, isSoundEnabled, ATTENTION_PREFS_EVENT } from '../utils/attention-manager.js';
import { zoomIn, zoomOut } from '../utils/zoom-manager.js';
import keyShortcutManager from './key-shortcut-manager.js';

/**
 * UIEventManager
 *
 * Manages all DOM event listeners with proper cleanup tracking.
 * Centralizes event handling and ensures no memory leaks.
 * @class
 */
class UIEventManager {
  /**
   * @param {object} options - Configuration options
   * @param {function(string, string|null, *, Array<*>=): void} options.onSendMessage - Callback when user sends message (message, threadItemId, messageThread, attachments)
   * @param {function(object): Promise<void>} options.onContextItemAction - Callback for context item actions
   * UI elements (conversationControls, contextPanel, conversationArea, inputBox) are per-tab.
   */
  constructor(options) {
    this._onSendMessage = options.onSendMessage;
    this._onContextItemAction = options.onContextItemAction;

    /** @type {Array<{element: EventTarget, event: string, handler: EventListenerOrEventListenerObject, options?: boolean|AddEventListenerOptions}>} @private */
    this._listeners = [];

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {(() => void)|null} @private */
    this._unregisterZoomIn = null;

    /** @type {(() => void)|null} @private */
    this._unregisterZoomOut = null;
  }

  /**
   * Setup all event handlers
   */
  setupAll() {
    this._setupInputHandler();
    this._setupContextItemActions();
    this._setupZoomButtons();
    this._setupThemeButton();
    this._setupBellButton();
    this._setupNetworkButton();
    this._setupHelpButton();
    this._setupSettingsButton();
    this._setupSidebarToggle();
  }

  /**
   * Setup input handler for sending messages.
   * Listen at document level since input-box is per-tab.
   * @private
   */
  _setupInputHandler() {
    // Listen for send-message event from input-box (bubbles up)
    /** @param {Event} event */
    const handler = (event) => {
      const detail = /** @type {any} */ (event).detail;
      this._onSendMessage(detail.message, detail.threadItemId || null, detail.messageThread || null, detail.attachments || []);
    };

    document.addEventListener('send-message', handler);
    this._listeners.push({
      element: document,
      event: 'send-message',
      handler: handler
    });
  }

  /**
   * Setup context item action handlers.
   * Listen at document level since properties-panel is per-tab.
   * @private
   */
  _setupContextItemActions() {
    // Listen for context item actions from properties-panel (bubbles up)
    /** @param {Event} event */
    const contextItemActionHandler = (event) => {
      this._onContextItemAction(/** @type {any} */ (event).detail);
    };

    document.addEventListener('context-item-action', contextItemActionHandler);
    this._listeners.push({
      element: document,
      event: 'context-item-action',
      handler: contextItemActionHandler
    });

    // Listen for context-item-add-requested event from context panel (bubbles up)
    /** @param {Event} event */
    const contextItemAddRequestedHandler = async (event) => {
      await this._handleContextItemAddRequested(/** @type {any} */ (event).detail);
    };

    document.addEventListener('context-item-add-requested', contextItemAddRequestedHandler);
    this._listeners.push({
      element: document,
      event: 'context-item-add-requested',
      handler: contextItemAddRequestedHandler
    });

  }

  /**
   * Setup zoom in/out handlers.
   *
   * Three entry points drive the same font-size zoom:
   *   - the header bar's −/+ buttons (click),
   *   - the native View ▸ Zoom In/Out menu items, which dispatch the
   *     `juggler:zoom-in` / `juggler:zoom-out` CustomEvents (the menu owns the
   *     Cmd +/− accelerators in the desktop app), and
   *   - browser-style Cmd/Ctrl +/− keypresses, for windows with no native menu
   *     (a plain browser tab). preventDefault stops the browser's own page zoom.
   * @private
   */
  _setupZoomButtons() {
    const zoomInButton = document.getElementById('zoom-in-button');
    const zoomOutButton = document.getElementById('zoom-out-button');

    if (zoomInButton) {
      const handler = () => zoomIn();
      zoomInButton.addEventListener('click', handler);
      this._listeners.push({ element: zoomInButton, event: 'click', handler });
    }

    if (zoomOutButton) {
      const handler = () => zoomOut();
      zoomOutButton.addEventListener('click', handler);
      this._listeners.push({ element: zoomOutButton, event: 'click', handler });
    }

    const zoomInEvent = () => zoomIn();
    window.addEventListener('juggler:zoom-in', zoomInEvent);
    this._listeners.push({ element: window, event: 'juggler:zoom-in', handler: zoomInEvent });

    const zoomOutEvent = () => zoomOut();
    window.addEventListener('juggler:zoom-out', zoomOutEvent);
    this._listeners.push({ element: window, event: 'juggler:zoom-out', handler: zoomOutEvent });

    // Cmd/Ctrl +/− keypresses (for windows with no native menu — a plain browser
    // tab). Bindings + platform handling live in the KeyShortcutManager; the
    // binding's '='/'-' keys fold in the shifted '+'/'_' and layout variants, and
    // returning truthy makes the manager preventDefault the browser's page zoom.
    this._unregisterZoomIn = keyShortcutManager.register('zoom-in', () => { zoomIn(); return true; });
    this._unregisterZoomOut = keyShortcutManager.register('zoom-out', () => { zoomOut(); return true; });
  }

  /**
   * Setup theme button handler
   * @private
   */
  _setupThemeButton() {
    const themeButton = document.getElementById('theme-button');

    if (!themeButton) {
      console.error('[UIEventManager] Theme button not found');
      return;
    }

    // Toggle theme when clicked
    const handler = () => {
      toggleTheme();
    };
    themeButton.addEventListener('click', handler);
    this._listeners.push({
      element: themeButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup the bell button — the header on/off for notification sounds. Mirrors
   * the theme button: a header toggle backed by a per-window localStorage pref.
   * The click toggles the `sound` pref (and unlocks audio for the session); the
   * crossed-bell styling stays in sync with the settings panel's checkbox via
   * the shared prefs-changed event. Crossed bell = sounds off.
   * @private
   */
  _setupBellButton() {
    const bellButton = document.getElementById('bell-button');
    if (!bellButton) {
      console.error('[UIEventManager] Bell button not found');
      return;
    }

    const reflect = () => {
      const on = isSoundEnabled();
      bellButton.classList.toggle('is-muted', !on);
      bellButton.setAttribute('title', 'Toggle notification sounds on/off');
      bellButton.setAttribute('aria-pressed', String(on));
    };

    const handler = () => {
      toggleSound();
      reflect();
    };
    bellButton.addEventListener('click', handler);
    this._listeners.push({ element: bellButton, event: 'click', handler });

    // Keep in sync when the settings panel (or another control) changes the pref.
    const prefsHandler = () => reflect();
    window.addEventListener(ATTENTION_PREFS_EVENT, prefsHandler);
    this._listeners.push({ element: window, event: ATTENTION_PREFS_EVENT, handler: prefsHandler });

    reflect();
  }

  /**
   * Setup network button handler
   * @private
   */
  _setupNetworkButton() {
    const networkButton = document.getElementById('network-button');

    if (!networkButton) {
      console.error('[UIEventManager] Network button not found');
      return;
    }

    // Open settings panel with connectivity tab when clicked
    const handler = () => {
      if ('openSettings' in window && typeof window.openSettings === 'function') {
        /** @type {any} */ (window).openSettings('connectivity');
      }
    };
    networkButton.addEventListener('click', handler);
    this._listeners.push({
      element: networkButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup help button handler — opens the Settings panel on its Keyboard
   * shortcuts tab, the passive reference surface for the onboarding tips.
   * @private
   */
  _setupHelpButton() {
    const helpButton = document.getElementById('help-button');

    if (!helpButton) {
      console.error('[UIEventManager] Help button not found');
      return;
    }

    const handler = () => {
      if ('openSettings' in window && typeof window.openSettings === 'function') {
        /** @type {any} */ (window).openSettings('shortcuts');
      }
    };
    helpButton.addEventListener('click', handler);
    this._listeners.push({
      element: helpButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup settings button handler
   * @private
   */
  _setupSettingsButton() {
    const settingsButton = document.getElementById('settings-button');

    if (!settingsButton) {
      console.error('[UIEventManager] Settings button not found');
      return;
    }

    // Open settings panel when clicked
    const handler = () => {
      if ('openSettings' in window && typeof window.openSettings === 'function') {
        /** @type {any} */ (window).openSettings();
      }
    };
    settingsButton.addEventListener('click', handler);
    this._listeners.push({
      element: settingsButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Setup the conversation-sidebar drawer toggle (narrow viewports only).
   *
   * On wide screens the sidebar is a static column and the hamburger button
   * is CSS-hidden, so this is inert there. On narrow screens the sidebar
   * becomes an off-canvas drawer driven entirely by the `sidebar-open` class
   * on <body>: the hamburger toggles it, the backdrop and selecting a
   * conversation close it. Pure ephemeral view state — no domain/Yjs state.
   * @private
   */
  _setupSidebarToggle() {
    const toggleButton = document.getElementById('sidebar-toggle-button');
    const backdrop = document.getElementById('sidebar-backdrop');
    const sidebar = document.getElementById('conversation-bar');

    /** @param {boolean} open */
    const setOpen = (open) => {
      document.body.classList.toggle('sidebar-open', open);
      toggleButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const isOpen = () => document.body.classList.contains('sidebar-open');
    const close = () => setOpen(false);

    if (toggleButton) {
      const handler = () => setOpen(!isOpen());
      toggleButton.addEventListener('click', handler);
      this._listeners.push({ element: toggleButton, event: 'click', handler });
    }

    if (backdrop) {
      backdrop.addEventListener('click', close);
      this._listeners.push({ element: backdrop, event: 'click', handler: close });
    }

    // Selecting a conversation inside the drawer should dismiss it, just like a
    // tap on the backdrop. But any tap that enters inline rename must keep the
    // drawer OPEN: the rename editor is a body-level overlay anchored to the
    // tab's on-screen rect, so closing the drawer slides that tab off-canvas and
    // the overlay lands clipped at the viewport edge (and tearing the editor down
    // with the drawer would make rename impossible). Two taps enter rename:
    // creating a conversation (the "+") and tapping the ALREADY-active tab — both
    // are exempt. So only dismiss on a real navigation: a tap on a non-active
    // tab. Taps on "+", the active tab, or inside the rename editor keep it open.
    //
    // CAPTURE PHASE is load-bearing: the tab's own bubble-phase click handler
    // calls switchConversation(), which synchronously notifies the bar and
    // re-renders, flipping `.active` onto the tapped tab. A bubble-phase listener
    // here would therefore always see the tapped tab as already-active and never
    // close. Running in capture, before that switch, lets `.active` still report
    // the pre-tap state the logic below assumes.
    if (sidebar) {
      /** @param {Event} e */
      const handler = (e) => {
        if (!isOpen()) return;
        const target = /** @type {HTMLElement|null} */ (e.target);
        if (target?.closest('.conversation-add-item')) return;
        if (target?.closest('.conversation-tab-rename')) return;
        const tab = target?.closest('.conversation-tab');
        if (tab && !tab.classList.contains('active')) close();
      };
      sidebar.addEventListener('click', handler, true);
      this._listeners.push({ element: sidebar, event: 'click', handler, options: true });
    }

    // A keyboard Escape closes the drawer too.
    /** @param {Event} ev */
    const keyHandler = (ev) => {
      const e = /** @type {KeyboardEvent} */ (ev);
      if (e.key === 'Escape' && isOpen()) close();
    };
    document.addEventListener('keydown', keyHandler);
    this._listeners.push({ element: document, event: 'keydown', handler: keyHandler });
  }

  /**
   * Handle context item add requested event
   * @param {{button: HTMLElement, threadItemId?: string|null}} detail - Event detail
   * @private
   */
  async _handleContextItemAddRequested(detail) {
    const { button, threadItemId } = detail;

    // Remove any existing dropdown
    const existingDropdown = document.querySelector('.context-item-add-dropdown');
    if (existingDropdown) {
      existingDropdown.remove();
      return;
    }

    // CRITICAL: Validate button element exists and has valid dimensions
    // This prevents the bug where document.getElementById() returns a button from a hidden tab
    if (!button) {
      console.error('[UIEventManager] context-item-add-requested event missing button element');
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    if (buttonRect.width === 0 || buttonRect.height === 0) {
      console.error('[UIEventManager] Button has zero dimensions - likely from hidden tab', button);
      return;
    }

    // Create dropdown menu
    const dropdown = document.createElement('nav');
    dropdown.className = 'dropdown-menu context-item-add-dropdown show';

    // presentPopup (wired at the end of this method) returns the single
    // teardown; `close` runs it from every dismissal path (selection, outside
    // click, Escape). Declared up front so the item handlers below can call it.
    /** @type {(() => void)|null} */
    let release = null;
    const close = () => { if (release) { release(); release = null; } };

    const menu = document.createElement('menu');

    // Add heading
    const heading = document.createElement('li');
    heading.className = 'menu-item category-header';
    heading.textContent = 'Add context item:';
    menu.appendChild(heading);

    // Divider
    const divider = document.createElement('li');
    divider.className = 'menu-divider';
    divider.setAttribute('role', 'separator');
    menu.appendChild(divider);

    // "AI assistant files" special action
    const aiFilesItem = document.createElement('li');
    aiFilesItem.className = 'menu-item';
    aiFilesItem.textContent = 'AI assistant files';
    aiFilesItem.addEventListener('click', async () => {
      await this._addAIAssistantFiles(threadItemId);
      close();
    });
    menu.appendChild(aiFilesItem);

    // Get all user-addable context items
    const contextItemRegistry = (await import('../registries/context-item-registry.js')).default;
    const allItemTypeIds = contextItemRegistry.getIds();

    for (const itemTypeId of allItemTypeIds) {
      const ItemClass = contextItemRegistry.get(itemTypeId);
      if (ItemClass && ItemClass.MANIFEST && ItemClass.MANIFEST.userAddable === true) {
        const manifest = ItemClass.MANIFEST;

        const item = document.createElement('li');
        item.className = 'menu-item';
        item.textContent = manifest.name;

        item.addEventListener('click', async () => {
          // Get session and conversation
          const session = this._getSession();
          if (!session) {
            console.error('[UIEventManager] Cannot add context item: no session');
            close();
            return;
          }

          const conversation = session.getVisibleConversation();
          if (!conversation) {
            console.error('[UIEventManager] Cannot add context item: no visible conversation');
            close();
            return;
          }

          // If the item class requires upfront user input, collect it now
          let params = {};
          if (typeof /** @type {any} */ (ItemClass).showAddDialog === 'function') {
            params = await /** @type {any} */ (ItemClass).showAddDialog();
            if (params === null) {
              close();
              return;
            }
          }

          // Create context item in the thread the footer belongs to
          const messageThread = threadItemId
            ? conversation.resolveMessageThread(threadItemId)
            : conversation.rootMessageThread;
          try {
            await messageThread.executeContextItem(itemTypeId, params);
          } catch (err) {
            console.error(`[UIEventManager] Error adding context item:`, err);
          }

          close();
        });

        menu.appendChild(item);
      }
    }

    dropdown.appendChild(menu);

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape + mutual exclusion), the reposition observer,
    // and the anchored-vs-sheet decision. Its release is the single teardown.
    release = presentPopup({
      surface: dropdown,
      anchor: button,
      id: 'context-item-add-dropdown',
      onClose: close,
      insideSelectors: ['.context-item-add-dropdown'],
    });
  }

  /**
   * Detect and add AI assistant files (CLAUDE.md, .cursorrules, etc.)
   * @param {string|null} [threadItemId] - Target thread; null means root thread
   * @private
   * @async
   */
  async _addAIAssistantFiles(threadItemId = null) {
    const session = this._getSession();
    if (!session) {
      console.error('[UIEventManager] Cannot add AI files: no session');
      return;
    }

    const conversation = session.getVisibleConversation();
    if (!conversation) {
      console.error('[UIEventManager] Cannot add AI files: no visible conversation');
      return;
    }

    const messageThread = threadItemId
      ? conversation.resolveMessageThread(threadItemId)
      : conversation.rootMessageThread;
    const addedCount = await session.addAIAssistantFiles(conversation, messageThread);
    await session.seedAutoContextItems(conversation, messageThread);
    if (addedCount === 0) {
      console.log('[UIEventManager] No AI assistant files found in project');
    }
  }

  /**
   * The current session, or null before one is set. Populated via setSession()
   * (called by JugglerApp once the session exists).
   * @returns {import('../model/session.js').default|null} Session instance or null if not set
   * @private
   */
  _getSession() {
    return this._session || null;
  }

  /**
   * Set session reference for event handlers
   * @param {import('../model/session.js').default} session - Session instance
   */
  setSession(session) {
    this._session = session;
  }

  /**
   * Remove all event listeners for cleanup
   */
  destroy() {
    for (const listener of this._listeners) {
      listener.element.removeEventListener(
        listener.event,
        /** @type {EventListenerOrEventListenerObject} */(listener.handler),
        listener.options
      );
    }
    this._listeners = [];
    this._unregisterZoomIn?.();
    this._unregisterZoomOut?.();
  }
}

export default UIEventManager;
