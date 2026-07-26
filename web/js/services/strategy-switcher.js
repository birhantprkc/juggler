//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import HoldToCycleController from './hold-to-cycle.js';

/**
 * StrategySwitcher - Handles the strategy-switch keyboard shortcut (Shift+Tab by
 * default). Alt-tab UX: the first press opens the dropdown HUD highlighting the
 * CURRENT strategy (no hop); each further Tab (Shift still held) cycles to the
 * next; releasing Shift commits the highlighted strategy.
 *
 * A thin client of the shared {@link HoldToCycleController}, which owns the
 * gesture mechanics (phase machine, capture-phase key listeners) and sources the
 * trigger binding from the KeyShortcutManager (id `strategy-switch`, marked
 * `external` there). This class supplies only the strategy-selector actions:
 * hops preview through a deferred write and the landing strategy is persisted
 * once on Shift release (see StrategySelector's CycleBuffer).
 * @class
 */
class StrategySwitcher {
  constructor() {
    /**
     * The selector this gesture is driving, snapshotted at gesture start from
     * the focused composer's column and held for the gesture's lifetime (null
     * between gestures). Caching it — rather than re-resolving on every hop —
     * pins one gesture to one thread even if focus drifts when the menu HUD
     * opens or a running turn rebuilds columns underneath us.
     * @type {import('../components/strategy-selector.js').StrategySelector|null} @private
     */
    this._activeSelector = null;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'strategy-switch',
      modifierKeys: ['Shift'],
      // Resolve live here (no gesture is in flight yet) so the applicability
      // check reflects the column the user is actually focused in.
      canCycle: () => this._resolveActiveSelector() !== null,
      // Buffer the strategy write for the whole gesture: hops update the menu
      // HUD's highlight, but a running turn never sees an intermediate strategy
      // (the doc is written once, on commit). Snapshot the target selector here
      // so every subsequent hook drives the SAME thread's selector, enter its
      // deferred-write mode, and open the dropdown HUD — it's the surface from
      // the first press.
      onGestureStart: () => {
        this._activeSelector = this._resolveActiveSelector();
        this._activeSelector?.beginCycle();
        this._activeSelector?.open();
      },
      onCycle: () => { this._activeSelector?.cycleNext(); },
      onCommit: () => {
        this._activeSelector?.close();
        this._activeSelector?.commitCycle();
        this._activeSelector = null;
      },
      onCancel: () => {
        this._activeSelector?.close();
        this._activeSelector?.cancelCycle();
        this._activeSelector = null;
      },
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
   * Resolve the strategy selector this gesture should drive, preferring the
   * column the user is actually focused in. The gesture only starts from a
   * composer textarea (see `defaultShouldHandle`), so the focused element's
   * enclosing `input-box` identifies the intended thread — the root OR any open
   * sub-thread column, each of which has its own selector bound to its own
   * thread. Falling back to the active tab's first selector (its root column's)
   * covers the no-focus edge case.
   *
   * This replaces a plain `activeTab.querySelector('strategy-selector')`, which
   * returned the FIRST selector in DOM order — always the root column's — so
   * Shift+Tab silently drove the root conversation's strategy even when the
   * cursor sat in a sub-thread composer.
   * @returns {import('../components/strategy-selector.js').StrategySelector|null} The selector or null
   * @private
   */
  _resolveActiveSelector() {
    // Prefer the focused composer's own column.
    const focused = /** @type {HTMLElement|null} */ (document.activeElement);
    const box = focused && typeof focused.closest === 'function'
      ? focused.closest('input-box')
      : null;
    if (box) {
      const owned = box.querySelector('strategy-selector');
      if (owned) {
        return /** @type {import('../components/strategy-selector.js').StrategySelector} */ (owned);
      }
    }

    // Fallback: the active conversation tab's (root column's) selector.
    const activeTab = document.querySelector('conversation-tab.active');
    if (activeTab) {
      const selector = activeTab.querySelector('strategy-selector');
      if (selector) {
        return /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector);
      }
    }

    // Last resort: any visible strategy selector.
    const selector = document.querySelector('strategy-selector');
    return selector ? /** @type {import('../components/strategy-selector.js').StrategySelector} */ (selector) : null;
  }
}

export default StrategySwitcher;
