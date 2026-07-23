//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import HoldToCycleController from './hold-to-cycle.js';

/**
 * StrategySwitcher - Handles the strategy-switch keyboard shortcut (Shift+Tab by
 * default). Alt-tab UX: short press cycles, hold shift to open dropdown menu.
 * While menu open + Shift held, Tab cycles through strategies.
 *
 * A thin client of the shared {@link HoldToCycleController}, which owns the
 * gesture mechanics (phase machine, long-press timer, capture-phase key
 * listeners) and sources the trigger binding from the KeyShortcutManager (id
 * `strategy-switch`, marked `external` there). This class supplies only the
 * strategy-selector actions; committing on Shift release is a no-op because
 * each cycle already applied the strategy.
 * @class
 */
class StrategySwitcher {
  constructor() {
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'strategy-switch',
      modifierKeys: ['Shift'],
      canCycle: () => this._getStrategySelector() !== null,
      onCycle: () => { this._getStrategySelector()?.cycleNext(); },
      onOpenMenu: () => { this._getStrategySelector()?.open(); },
      onCloseMenu: () => { this._getStrategySelector()?.close(); },
      onCommit: () => { /* cycling already applied the strategy */ },
    });
  }

  /**
   * Initialize the strategy switcher
   * Attaches keyboard event listeners
   */
  init() {
    this._controller.init();
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    this._controller.destroy();
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
