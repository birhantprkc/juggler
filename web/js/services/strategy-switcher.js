//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import keyShortcutManager, { eventMatchesBinding } from './key-shortcut-manager.js';

/**
 * StrategySwitcher - Handles the strategy-switch keyboard shortcut (Shift+Tab by
 * default). Alt-tab UX: short press cycles, hold shift to open dropdown menu.
 * While menu open + Shift held, Tab cycles through strategies.
 *
 * The trigger binding is sourced from the KeyShortcutManager (id
 * `strategy-switch`, marked `external` there) rather than hard-coded; this
 * controller owns only the hold-to-cycle gesture mechanics.
 * @class
 */
class StrategySwitcher {
  /** @type {number} Threshold in ms for long press detection */
  static LONG_PRESS_THRESHOLD = 500;

  constructor() {
    /** @type {'idle'|'press-started'|'menu-open'} @private */
    this._phase = 'idle';
    /** @type {number|null} @private */
    this._pressStartTime = null;
    /** @type {number|null} @private */
    this._longPressTimeout = null;

    // Bind handlers to preserve 'this' context
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleKeyUp = this._handleKeyUp.bind(this);
  }

  /**
   * Initialize the strategy switcher
   * Attaches keyboard event listeners
   */
  init() {
    document.addEventListener('keydown', this._handleKeyDown, { capture: true });
    document.addEventListener('keyup', this._handleKeyUp, { capture: true });
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    document.removeEventListener('keydown', this._handleKeyDown, { capture: true });
    document.removeEventListener('keyup', this._handleKeyUp, { capture: true });
    this._clearTimeout();
  }

  /**
   * Handle keydown events
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyDown(e) {
    // Phase: IDLE - waiting for the strategy-switch trigger (Shift+Tab default)
    if (this._phase === 'idle') {
      const binding = keyShortcutManager.getBinding('strategy-switch');
      if (binding && eventMatchesBinding(binding, e)) {
        if (!this._shouldHandle(e)) return;

        e.preventDefault();
        e.stopPropagation();

        // Cycle immediately on keydown
        this._cycleStrategy();

        this._phase = 'press-started';
        this._pressStartTime = Date.now();

        // Start long press timer - opens menu if Shift still held
        this._longPressTimeout = window.setTimeout(() => {
          if (this._phase === 'press-started') {
            this._handleLongPress();
          }
        }, StrategySwitcher.LONG_PRESS_THRESHOLD);
      }
      return;
    }

    // Phase: MENU_OPEN - Tab cycles through strategies
    if (this._phase === 'menu-open') {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        this._cycleStrategy();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._closeDropdown();
        this._phase = 'idle';
      }
      return;
    }
  }

  /**
   * Handle keyup events
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyUp(e) {
    // Phase: PRESS_STARTED - Shift release cancels long press
    if (this._phase === 'press-started') {
      if (e.key === 'Shift') {
        this._clearTimeout();
        this._phase = 'idle';
      }
      return;
    }

    // Phase: MENU_OPEN - Shift release closes menu
    if (this._phase === 'menu-open') {
      if (e.key === 'Shift') {
        this._closeDropdown();
        this._phase = 'idle';
      }
      return;
    }
  }

  /**
   * Handle long press - open the dropdown menu
   * @private
   */
  _handleLongPress() {
    this._longPressTimeout = null;
    this._phase = 'menu-open';

    const selector = this._getStrategySelector();
    if (selector) {
      selector.open();
    }
  }

  /**
   * Cycle to the next strategy
   * @private
   */
  _cycleStrategy() {
    const selector = this._getStrategySelector();
    if (selector) {
      selector.cycleNext();
    }
  }

  /**
   * Close the dropdown
   * @private
   */
  _closeDropdown() {
    const selector = this._getStrategySelector();
    if (selector) {
      selector.close();
    }
  }

  /**
   * Clear any pending timeout
   * @private
   */
  _clearTimeout() {
    if (this._longPressTimeout !== null) {
      clearTimeout(this._longPressTimeout);
      this._longPressTimeout = null;
    }
  }

  /**
   * Check if the shortcut should be handled
   * @param {KeyboardEvent} e
   * @returns {boolean} True if shortcut should be handled
   * @private
   */
  _shouldHandle(e) {
    // Only handle when focus is in the main input textarea (inside input-box)
    const target = e.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    // Must be a textarea inside input-box
    if (target.tagName !== 'TEXTAREA' || !target.closest('input-box')) {
      return false;
    }

    // Don't handle if a modal dialog is open
    const modalOpen = document.querySelector('modal-dialog.show');
    if (modalOpen) {
      return false;
    }

    // Don't handle if no strategy selector available
    const selector = this._getStrategySelector();
    if (!selector) {
      return false;
    }

    return true;
  }

  /**
   * Get the strategy selector element from the active conversation tab
   * @returns {import('../components/strategy-selector.js').StrategySelector|null} The selector or null
   * @private
   */
  _getStrategySelector() {
    // Find strategy selector in the visible conversation tab
    // The active tab uses the .active class
    const activeTab = document.querySelector('conversation-tab.active');
    if (activeTab) {
      const selector = activeTab.querySelector('strategy-selector');
      if (selector) {
        return /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector);
      }
    }

    // Fallback: try to find any visible strategy selector
    const selector = document.querySelector('strategy-selector');
    return selector ? /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector) : null;
  }
}

export default StrategySwitcher;
