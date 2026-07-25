//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import HoldToCycleController from './hold-to-cycle.js';
import { isMac } from './key-shortcut-manager.js';
import recentModels from './recent-models.js';
import providersCache from './providers-cache.js';
import { isForeignPopupOpen } from '../utils/popup-manager.js';

/**
 * Hold-to-cycle clients for the model shortcuts: {@link ModelCycler}
 * (`cycle-model`, ⌥⌘M / Ctrl+Alt+M — Alt-Tab over the Recent models list) and
 * {@link ThinkingCycler} (`cycle-thinking`, ⌥⌘T / Ctrl+Alt+T — cycle the
 * current model's thinking level). Both own only the cycling logic; the
 * gesture mechanics live in the shared controller, and the applied state is
 * written through public ModelSelector methods that deliberately do NOT
 * record to recents — the landing pair is recorded once, on commit.
 * @module services/model-cycler
 */

/**
 * The `KeyboardEvent.key` name of the primary command modifier — resolves the
 * `mod` in the shortcut bindings the same way `eventMatchesBinding` does:
 * ⌘ (Meta) on macOS, Ctrl elsewhere.
 * @returns {string} 'Meta' on macOS, 'Control' elsewhere.
 */
function commandModifierKey() {
  return isMac() ? 'Meta' : 'Control';
}

/**
 * Get the model selector element the shortcut should act on: the one inside
 * the active conversation tab (so sub-thread columns' selectors are governed
 * by which tab is active), with a document-wide fallback — mirrors
 * StrategySwitcher's target resolution.
 * @returns {any} The model-selector element, or null.
 */
function getModelSelector() {
  const activeTab = document.querySelector('conversation-tab.active');
  if (activeTab) {
    const selector = activeTab.querySelector('model-selector');
    if (selector) return selector;
  }

  // Fallback: try to find any visible model selector
  return document.querySelector('model-selector');
}

/**
 * Popup ids the model shortcuts OWN — the model dropdown and the mini thinking
 * popover, both surfaces of the model-selector the cyclers drive. Allow-listed
 * in {@link modelGestureShouldHandle} so the window-wide gate never stands the
 * gesture down for its own cycling HUD.
 * @type {string[]}
 */
const OWN_POPUP_IDS = ['model-selector', 'thinking-mini'];

/**
 * The gesture gate for the model/thinking cyclers. Unlike the strategy
 * switcher's composer-focus gate (`defaultShouldHandle` in hold-to-cycle), these fire from
 * ANYWHERE in the window: their ⌥⌘M / ⌥⌘T chords carry no native in-app meaning
 * to protect, and being lost to the OS when focus sits outside the composer
 * (bare ⌘M minimises the app) is the very bug this gate fixes. The controller
 * already resolves its target from the ACTIVE conversation tab, so the gesture
 * still reaches the right thread no matter where focus is — the whole-window
 * capture just stops the keystroke leaking to the OS first.
 *
 * It stands down only while a FOREIGN overlay is open (a modal dialog, another
 * component's dropdown) — never for the cyclers' own HUD popups. That exception
 * is load-bearing: holding to open the model menu, or a re-press to keep
 * cycling, must never be gated out by the very popup the gesture just opened.
 * (Re-presses during an active gesture bypass this gate anyway; the allow-list
 * covers the idle case where the HUD was already opened by a click.)
 * @param {KeyboardEvent} _e - Trigger event; focus is intentionally ignored.
 * @returns {boolean} True when the gesture may start.
 */
export function modelGestureShouldHandle(_e) {
  return !isForeignPopupOpen(OWN_POPUP_IDS);
}

/**
 * ModelCycler - the `cycle-model` hold-to-cycle client. Alt-Tab semantics over
 * the Recent models list: the gesture snapshots the list once at gesture start
 * (frozen, minus entries whose provider is currently unavailable), so cycling
 * can never reorder the list it is walking; each press applies the next
 * `{provider, model, thinking?}` pair immediately (without recording it);
 * holding opens the model menu as a HUD; releasing the modifiers commits,
 * recording only the landing pair. The first cycle goes to snapshot index 1 —
 * the previous pair — since index 0 is the current one (or to index 0 when the
 * current config isn't in the snapshot at all). With fewer than two entries
 * there is nothing to switch between, so taps no-op while holding still opens
 * the menu.
 * @class
 */
class ModelCycler {
  constructor() {
    /** @type {import('./recent-models.js').RecentModel[]} @private - Frozen recents snapshot for the active gesture. */
    this._snapshot = [];
    /** @type {number} @private - Snapshot index of the last-applied pair; -1 = current pair absent from the snapshot. */
    this._cursor = -1;
    /** @type {boolean} @private - Whether this gesture applied at least one pair. */
    this._cycled = false;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'cycle-model',
      modifierKeys: [commandModifierKey(), 'Alt'],
      // Window-wide: ⌥⌘M must not leak to the OS (bare ⌘M minimises) when focus
      // sits outside the composer — the controller redirects to the active tab.
      shouldHandle: modelGestureShouldHandle,
      canCycle: () => getModelSelector() !== null,
      onGestureStart: () => this._startGesture(),
      onCycle: () => this._cycle(),
      onOpenMenu: () => { getModelSelector()?.open(); },
      onCloseMenu: () => { getModelSelector()?.close(); },
      onCommit: () => this._commit(),
      onCancel: () => this._cancel(),
    });
  }

  /**
   * Initialize the model cycler
   * Attaches keyboard event listeners
   */
  init() {
    this._controller.init();
    // Pre-warm the recents cache that `_startGesture` snapshots SYNCHRONOUSLY.
    // Recents are otherwise loaded lazily on menu-open, so the very first ⌥⌘M
    // after a page load would snapshot an empty list and cycle over nothing
    // until a menu-open refresh populated it (repeated presses no-op, but the
    // long-press HUD still shows — "it appears but does nothing the first
    // time"). Best-effort: refresh() never rejects and leaves the cache empty
    // on failure, exactly as before.
    recentModels.refresh().catch(() => {});
  }

  /**
   * Cleanup event listeners
   */
  destroy() {
    this._controller.destroy();
  }

  /**
   * Freeze the gesture's working set: the recents list minus entries whose
   * provider is currently unavailable (those are skipped, per the design's
   * edge-case rules), and the cursor pointing at the current pair within it.
   * @private
   */
  _startGesture() {
    // Hold the model write until commit: hops update the selector's display and
    // its dropdown HUD, but a running turn never sees an intermediate model.
    getModelSelector()?.beginCycle();
    const available = new Set(providersCache.get().filter(p => p.available).map(p => p.name));
    this._snapshot = recentModels.get().filter(r => available.has(r.provider));
    const current = getModelSelector()?.currentConfigPair();
    this._cursor = current
      ? this._snapshot.findIndex(r => r.provider === current.provider
        && r.model === current.model && (r.thinking || '') === (current.thinking || ''))
      : -1;
    this._cycled = false;
  }

  /**
   * Apply the next snapshot pair (wrapping), skipping any that fail to apply
   * (e.g. a provider that lost availability mid-gesture).
   * @private
   */
  _cycle() {
    // 0/1-entry snapshot: nothing to switch between — taps no-op, but the
    // gesture stays engaged so a hold still opens the menu.
    if (this._snapshot.length < 2) return;
    const selector = getModelSelector();
    if (!selector) return;

    for (let i = 0; i < this._snapshot.length; i++) {
      const next = (this._cursor + 1 + i) % this._snapshot.length;
      if (next === this._cursor) break; // wrapped all the way around
      if (selector.applyConfigPair(this._snapshot[next])) {
        this._cursor = next;
        this._cycled = true;
        return;
      }
    }
  }

  /**
   * Commit the gesture: record the landing pair to recents (moving it to the
   * front) — but only when the gesture actually cycled, so a pure
   * hold-to-peek at the menu never reorders the list.
   * @private
   */
  _commit() {
    // Flush the buffered landing model to the doc first (once), then record it.
    getModelSelector()?.commitCycle();
    if (this._cycled) {
      const pair = getModelSelector()?.currentConfigPair();
      if (pair) recentModels.record(pair.provider, pair.model, pair.thinking);
    }
    this._snapshot = [];
    this._cursor = -1;
    this._cycled = false;
  }

  /**
   * Abandon the gesture (Escape): drop the buffered model write so the doc
   * keeps its pre-gesture value, and clear the snapshot without recording.
   * @private
   */
  _cancel() {
    getModelSelector()?.cancelCycle();
    this._snapshot = [];
    this._cursor = -1;
    this._cycled = false;
  }
}

/**
 * ThinkingCycler - the `cycle-thinking` hold-to-cycle client. Cycles the
 * CURRENT model's thinking level: Default → the supported levels in canonical
 * order → wrap. Each press applies immediately (without recording) and
 * refreshes the level displays in place so the HUD visibly tracks; holding
 * opens the mini thinking popover anchored to the button chip; releasing the
 * modifiers commits, recording the landing pair. On a model without thinking
 * levels the whole gesture is a transparent no-op (the press falls through).
 * @class
 */
class ThinkingCycler {
  constructor() {
    /** @type {boolean} @private - Whether this gesture applied at least one level. */
    this._cycled = false;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      shortcutId: 'cycle-thinking',
      modifierKeys: [commandModifierKey(), 'Alt'],
      // Window-wide, same as ⌥⌘M — see modelGestureShouldHandle.
      shouldHandle: modelGestureShouldHandle,
      canCycle: () => {
        const selector = getModelSelector();
        return !!selector && !!selector.currentConfigPair()
          && selector.supportedThinkingLevels().length > 0;
      },
      onGestureStart: () => { this._cycled = false; getModelSelector()?.beginCycle(); },
      onCycle: () => this._cycle(),
      onOpenMenu: () => { getModelSelector()?.openThinkingMini(); },
      onCloseMenu: () => { getModelSelector()?.closeThinkingMini(); },
      onCommit: () => this._commit(),
      onCancel: () => this._cancel(),
    });
  }

  /**
   * Initialize the thinking cycler
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
   * Apply the next thinking level in the cycle Default → supported levels in
   * advertised order → wrap, then refresh the chip/popover so the HUD tracks.
   * @private
   */
  _cycle() {
    const selector = getModelSelector();
    if (!selector) return;
    const levels = selector.supportedThinkingLevels();
    if (levels.length === 0) return;

    // '' = Default first, then the supported levels in advertised order.
    const order = ['', ...levels];
    const current = selector.currentConfigPair()?.thinking || '';
    const next = order[(order.indexOf(current) + 1) % order.length];
    if (selector.applyThinkingLevel(next, { record: false })) {
      selector.refreshThinkingDisplay();
      this._cycled = true;
    }
  }

  /**
   * Commit the gesture: record the landing model+level pair to recents — only
   * when a level was actually cycled, so a pure hold-to-peek never records.
   * @private
   */
  _commit() {
    // Flush the buffered landing level to the doc first (once), then record it.
    getModelSelector()?.commitCycle();
    if (this._cycled) {
      const pair = getModelSelector()?.currentConfigPair();
      if (pair) recentModels.record(pair.provider, pair.model, pair.thinking);
    }
    this._cycled = false;
  }

  /**
   * Abandon the gesture (Escape): drop the buffered level write so the doc
   * keeps its pre-gesture value.
   * @private
   */
  _cancel() {
    getModelSelector()?.cancelCycle();
    this._cycled = false;
  }
}

export { ModelCycler, ThinkingCycler };
