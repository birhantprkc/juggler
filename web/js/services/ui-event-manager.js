//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { presentPopup } from '../utils/popup-surface.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { openSettings } from './settings-launcher.js';

/**
 * @typedef {object} EventListener
 * @property {HTMLElement|Document|Window} element - Element with listener
 * @property {string} event - Event type
 * @property {function} handler - Event handler function
 * @property {object} [options] - Event listener options
 */

import { cycleTheme, getMode, MODES } from '../utils/theme-manager.js';

/**
 * Header theme-button presentation per mode: the Material Symbols glyph
 * (brightness_auto / light_mode / dark_mode, viewBox 0 -960 960 960) and the
 * tooltip, which names the current mode and the one a click moves to.
 * @type {Record<string, {path: string, title: string}>}
 */
const THEME_BUTTON_UI = {
  [MODES.SYSTEM]: {
    path: 'M310-305h55l37-109h159l38 109h53L505-697h-48L310-305Zm107-157 61-163h5l62 163H417Zm64 433L346-160H160v-186L26-480l134-134v-186h186l135-134 133 134h186v186l134 134-134 134v186H614L481-29Zm0-84 108-107h151v-151l109-109-109-109v-151H589L481-849 371-740H220v151L111-480l109 109v151h150l111 107Zm0-368Z',
    title: 'Theme: System — click for Light'
  },
  [MODES.LIGHT]: {
    path: 'M579-381q41-41 41-99t-41-99q-41-41-99-41t-99 41q-41 41-41 99t41 99q41 41 99 41t99-41Zm-240.5 42.5Q280-397 280-480t58.5-141.5Q397-680 480-680t141.5 58.5Q680-563 680-480t-58.5 141.5Q563-280 480-280t-141.5-58.5ZM200-450H40v-60h160v60Zm720 0H760v-60h160v60ZM450-760v-160h60v160h-60Zm0 720v-160h60v160h-60ZM262-658l-100-97 43-44 96 100-39 41Zm494 496-98-100 41-41 99 98-42 43Zm-99-537 98-99 44 42-99 98-43-41ZM162-205l99-98 42 42-98 99-43-43Zm318-275Z',
    title: 'Theme: Light — click for Dark'
  },
  [MODES.DARK]: {
    path: 'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q8 0 17 .5t23 1.5q-36 32-56 79t-20 99q0 90 63 153t153 63q52 0 99-18.5t79-51.5q1 12 1.5 19.5t.5 14.5q0 150-105 255T480-120Zm0-60q109 0 190-67.5T771-406q-25 11-53.67 16.5Q688.67-384 660-384q-114.69 0-195.34-80.66Q384-545.31 384-660q0-24 5-51.5t18-62.5q-98 27-162.5 109.5T180-480q0 125 87.5 212.5T480-180Zm-4-297Z',
    title: 'Theme: Dark — click for System'
  }
};
import { toggleSound, isSoundEnabled, ATTENTION_PREFS_EVENT } from '../utils/attention-manager.js';
import { isToolGroupingEnabled, toggleToolGrouping, TOOL_GROUPING_EVENT } from '../utils/tool-grouping-pref.js';
import { zoomIn, zoomOut } from '../utils/zoom-manager.js';
import { isAutoNameEnabled } from './auto-name-setting.js';
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
   * @param {function(string, string|null, *, Array<*>=, string[]=): void} options.onSendMessage - Callback when user sends message (message, threadItemId, messageThread, attachments, skills)
   * @param {function(object): Promise<void>} options.onContextItemAction - Callback for context item actions
   * UI elements (conversationControls, contextPanel, conversationArea, composer) are per-tab.
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

    /** @type {(() => void)|null} @private */
    this._unregisterShowShortcuts = null;

    /** @type {(() => void)|null} @private */
    this._unregisterToolGrouping = null;

    /**
     * Popup-manager token, held for as long as the sidebar drawer is open.
     * @type {(() => void)|null} @private
     */
    this._releaseSidebarPopup = null;
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
    this._setupToolGroupingButton();
    this._setupNetworkButton();
    this._setupHelpButton();
    this._setupSettingsButton();
    this._setupSidebarToggle();
  }

  /**
   * Setup input handler for sending messages.
   * Listen at document level since composer-box is per-tab.
   * @private
   */
  _setupInputHandler() {
    // Listen for send-message event from composer-box (bubbles up)
    /** @param {Event} event */
    const handler = (event) => {
      const detail = /** @type {any} */ (event).detail;
      this._onSendMessage(detail.message, detail.threadItemId || null, detail.messageThread || null, detail.attachments || [], detail.skills || []);
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
    this._unregisterShowShortcuts = keyShortcutManager.register('show-shortcuts', () => {
      openSettings('shortcuts');
      return true;
    });
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

    // Show the current mode's icon + tooltip, then cycle
    // System → Light → Dark → System on each click.
    this._renderThemeButton(themeButton, getMode());
    const handler = () => {
      this._renderThemeButton(themeButton, cycleTheme());
    };
    themeButton.addEventListener('click', handler);
    this._listeners.push({
      element: themeButton,
      event: 'click',
      handler: handler
    });
  }

  /**
   * Paint the theme button's icon and tooltip for a mode.
   * @param {HTMLElement} button - The theme button element.
   * @param {string} mode - One of MODES.
   * @private
   */
  _renderThemeButton(button, mode) {
    const ui = THEME_BUTTON_UI[mode] || THEME_BUTTON_UI[MODES.SYSTEM];
    if (!ui) return;
    button.querySelector('path')?.setAttribute('d', ui.path);
    button.title = ui.title;
    button.setAttribute('aria-label', ui.title);
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
   * Setup the tool-grouping button — the header on/off for collapsing a run of
   * adjacent tool-use rows into one group tile. Mirrors the bell button: a
   * header toggle backed by a localStorage pref, re-reflected from the shared
   * pref-changed event so any other control that flips it stays in sync. The
   * open columns re-render themselves off the same event (conversation-tab).
   * The keyboard shortcut flips the same pref; the button reflects it either
   * way, since both routes go through the pref's change event.
   * @private
   */
  _setupToolGroupingButton() {
    const groupingButton = document.getElementById('tool-grouping-button');
    if (!groupingButton) {
      console.error('[UIEventManager] Tool grouping button not found');
      return;
    }

    const reflect = () => {
      const on = isToolGroupingEnabled();
      // `is-active` also swaps which of the button's two glyphs is shown (see
      // .tool-grouping-button in styles.css): each depicts the action a click
      // would perform — fold the rows together, or unfold them again.
      groupingButton.classList.toggle('is-active', on);
      groupingButton.setAttribute('title', on
        ? 'Consecutive tool uses are grouped — click to show them individually'
        : 'Group consecutive tool uses');
      groupingButton.setAttribute('aria-pressed', String(on));
    };

    const handler = () => {
      toggleToolGrouping();
      reflect();
    };
    groupingButton.addEventListener('click', handler);
    this._listeners.push({ element: groupingButton, event: 'click', handler });

    const prefsHandler = () => reflect();
    window.addEventListener(TOOL_GROUPING_EVENT, prefsHandler);
    this._listeners.push({ element: window, event: TOOL_GROUPING_EVENT, handler: prefsHandler });

    this._unregisterToolGrouping = keyShortcutManager.register('toggle-tool-grouping', () => {
      toggleToolGrouping();
      return true;
    });

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
      openSettings('connectivity');
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
      openSettings('shortcuts');
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
      openSettings();
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
   * on <body>: the hamburger toggles it, and the backdrop, a swipe, Escape, the
   * Back button and selecting a conversation close it. Pure ephemeral view
   * state — no domain/Yjs state.
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
      // The open drawer is one of the overlays a phone puts over the page, so it
      // holds a popup token for as long as it is up. That is what makes the
      // mobile/browser Back button dismiss it instead of navigating away from
      // the conversation, and what gives it its Escape — both route through
      // popup-manager's closeAllPopups, which calls the handler below.
      //
      // Releasing before re-taking keeps this at one token even if the drawer is
      // set to a state it already holds; the single sentinel history entry
      // survives that swap, since its retraction is deferred a macrotask and
      // re-checks whether anything is open.
      this._releaseSidebarPopup?.();
      this._releaseSidebarPopup = open ? markPopupOpen(close) : null;
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
    // tapping the ALREADY-active tab, and creating a conversation ("+") while
    // auto-naming is OFF. With auto-naming ON the "+" opens no editor — it names
    // the tab "Untitled N" and focuses the composer — so the drawer must get out
    // of the way, otherwise it covers the composer it just focused. So only
    // dismiss on a tap that leaves nothing to edit here: a non-active tab, or a
    // "+" that won't prompt for a name.
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
        if (target?.closest('.conversation-tab-rename')) return;
        if (target?.closest('.conversation-add-item')) {
          if (isAutoNameEnabled()) close();
          return;
        }
        const tab = target?.closest('.conversation-tab');
        if (tab && !tab.classList.contains('active')) close();
      };
      sidebar.addEventListener('click', handler, true);
      this._listeners.push({ element: sidebar, event: 'click', handler, options: true });
      this._setupSidebarSwipe(sidebar, isOpen, close);
    }
  }

  /**
   * Swipe the drawer away — a leftward drag anywhere on it (touch/pen only).
   *
   * The drawer tracks the finger and, released past the threshold, dismisses;
   * anything short snaps back. It is the horizontal twin of the drag-to-dismiss
   * every phone bottom sheet gets from `presentPopup` (see popup-surface.js), so
   * the two kinds of overlay a phone puts over the page go away the same way.
   *
   * The first decisive movement claims an axis and keeps it: a vertical drag is
   * the tab list scrolling and must stay the browser's — which is also why the
   * drawer declares `touch-action: pan-y` rather than `none`. Drags starting on
   * the resize grip, a tab's drag handle or the rename editor belong to those,
   * and a mouse never swipes at all: inside the bar a mouse drag already means
   * tab reorder, and a mouse has the backdrop, Escape and the hamburger.
   *
   * `pan-y` alone is not enough to keep the gesture, though. A real finger drifts
   * vertically on its way left, and a browser is entitled to read that drift as
   * the start of a scroll — which cancels the pointer and leaves the drawer
   * springing back mid-swipe. Cancelling the touchmove once the swipe owns the
   * gesture is what actually holds it (see `onTouchMove`).
   * @param {HTMLElement} sidebar - The conversation-bar element.
   * @param {() => boolean} isOpen - Whether the drawer is currently open.
   * @param {() => void} close - Closes the drawer.
   * @private
   */
  _setupSidebarSwipe(sidebar, isOpen, close) {
    /** Leftward distance (px) past which releasing the drag dismisses. */
    const DISMISS_PX = 60;
    /** Movement (px) before a drag commits to an axis. */
    const SLOP_PX = 10;

    /** @type {number|null} The pointer being tracked, if any. */
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    /** Whether the drag has won the horizontal axis and owns the transform. */
    let swiping = false;
    /** Set briefly after a real swipe, to swallow the click it leaves behind. */
    let swipeJustOccurred = false;

    /** Drop the tracked pointer and hand the transform back to CSS. */
    const release = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      pointerId = null;
      swiping = false;
      dx = 0;
      // Dropping the inline transition restores the CSS one, so the drawer
      // glides from wherever the finger left it: back open, or the rest of the
      // way out once close() takes the class off.
      sidebar.style.removeProperty('transition');
      sidebar.style.removeProperty('transform');
    };

    /** @param {Event} ev */
    const onMove = (ev) => {
      const e = /** @type {PointerEvent} */ (ev);
      if (e.pointerId !== pointerId) return;
      const moveX = e.clientX - startX;
      const moveY = e.clientY - startY;
      if (!swiping) {
        if (Math.abs(moveX) < SLOP_PX && Math.abs(moveY) < SLOP_PX) return;
        // Anything but a decisively leftward move is someone else's gesture —
        // a scroll, a tap that wandered — so the pointer is dropped for good
        // rather than reconsidered as the finger travels.
        if (-moveX <= Math.abs(moveY)) {
          release();
          return;
        }
        swiping = true;
        sidebar.style.transition = 'none'; // track the finger 1:1
      }
      dx = Math.min(0, moveX);
      sidebar.style.transform = `translateX(${dx}px)`;
    };

    /**
     * End the gesture: dismiss if it travelled far enough, snap back otherwise.
     * @param {boolean} leavesClick - Whether a click will follow. A finger lifted
     *   off a tab leaves one; a cancelled gesture doesn't.
     */
    const finish = (leavesClick) => {
      const dismiss = swiping && -dx >= DISMISS_PX;
      if (swiping && leavesClick) {
        swipeJustOccurred = true;
        setTimeout(() => { swipeJustOccurred = false; }, 100);
      }
      release();
      if (dismiss) close();
    };

    /** @param {Event} ev */
    const onUp = (ev) => {
      if (/** @type {PointerEvent} */ (ev).pointerId === pointerId) finish(true);
    };

    /** @param {Event} ev */
    const onCancel = (ev) => {
      // Something upstream took the touch. Past the threshold the intent was
      // already unambiguous, so honour it rather than springing back.
      if (/** @type {PointerEvent} */ (ev).pointerId === pointerId) finish(false);
    };

    // Once the swipe owns the gesture, no scroll may start from it. Only
    // cancelling the touchmove says so — `touch-action: pan-y` still leaves the
    // browser free to read the drag's vertical drift as a scroll, and a scroll
    // starting cancels the pointer out from under the swipe. The listener is
    // registered up front and non-passive because a browser decides whether a
    // touch can be blocked when the finger lands, not once it has moved.
    /** @param {Event} ev */
    const onTouchMove = (ev) => {
      if (swiping) ev.preventDefault();
    };

    /** @param {Event} ev */
    const onDown = (ev) => {
      const e = /** @type {PointerEvent} */ (ev);
      if (pointerId !== null || e.pointerType === 'mouse' || !isOpen()) return;
      // Drawer mode only: on a wide viewport the bar is a static column
      // (`position: relative`), with nothing to slide out of the way.
      if (window.getComputedStyle(sidebar).position !== 'absolute') return;
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (target?.closest('col-resize-handle, .tab-drag-handle, .conversation-tab-rename')) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      // Track on the document: a tab re-render mid-drag would take the
      // pointerdown target — and with it the implicit touch capture — out of
      // the DOM, stranding the gesture. Tab-reorder drags listen there too.
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
    };

    // A swipe leaves behind a click on whatever it started over, usually a tab
    // — which would switch conversation on the way out. Swallow that one click.
    // Document capture runs before any listener inside the bar whatever the
    // order they were added in; the 100ms window matches the equivalent guard
    // on tab-reorder drags (`_dragJustOccurred` in conversation-bar.js).
    /** @param {Event} ev */
    const onClickCapture = (ev) => {
      if (!swipeJustOccurred) return;
      ev.stopPropagation();
      ev.preventDefault();
    };

    sidebar.addEventListener('pointerdown', onDown);
    sidebar.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('click', onClickCapture, true);
    this._listeners.push({ element: sidebar, event: 'pointerdown', handler: onDown });
    this._listeners.push({ element: sidebar, event: 'touchmove', handler: onTouchMove });
    this._listeners.push({ element: document, event: 'click', handler: onClickCapture, options: true });
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
    this._unregisterShowShortcuts?.();
    this._unregisterToolGrouping?.();
    this._releaseSidebarPopup?.();
    this._releaseSidebarPopup = null;
  }
}

export default UIEventManager;
