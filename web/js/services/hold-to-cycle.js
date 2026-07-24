//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import keyShortcutManager, { eventMatchesBinding } from './key-shortcut-manager.js';
import { markSeen } from './tips-manager.js';

/**
 * HoldToCycleController — the shared "Alt-Tab" gesture behind the strategy,
 * model, and thinking-level shortcuts. One phase machine, extracted from the
 * original StrategySwitcher, drives them all:
 *
 *   idle → (trigger keydown: cycle immediately) → press-started
 *        → (still held after 500ms: open the menu HUD) → menu-open
 *
 * While the gesture is in progress (either non-idle phase), pressing the
 * trigger key again cycles again; Escape cancels (menu closed, nothing
 * committed); releasing ANY of the configured modifier keys ends the gesture —
 * closing the menu if open, then committing.
 *
 * The trigger binding is looked up live from the KeyShortcutManager by
 * `shortcutId` (the definition is marked `external` there), so a future user
 * rebinding is honoured without touching this controller. Clients supply only
 * the actions; all key listening (capture phase, so the gesture wins over
 * component-level handlers) lives here.
 * @typedef {object} HoldToCycleConfig
 * @property {string} shortcutId - KeyShortcutManager definition id of the trigger.
 * @property {string[]} modifierKeys - `KeyboardEvent.key` names of the binding's
 *   modifiers (e.g. `['Shift']` or `['Meta', 'Alt']`); releasing any of them
 *   ends the gesture. Callers must resolve the platform meaning of `mod`
 *   themselves ('Meta' on macOS, 'Control' elsewhere — see `isMac()`).
 * @property {(e: KeyboardEvent) => boolean} [shouldHandle] - Focus/context gate
 *   for starting a gesture. Defaults to the composer rule the strategy switcher
 *   always used: focus in a textarea inside `input-box`, no modal dialog open.
 * @property {() => boolean} [canCycle] - Whole-gesture applicability. When it
 *   returns false the trigger press falls through untouched (no preventDefault),
 *   so an inapplicable shortcut is a transparent no-op. Defaults to always-on.
 * @property {() => void} [onGestureStart] - Called once per gesture, on the
 *   idle → press-started transition, before the first onCycle. The hook for
 *   snapshotting state the gesture must hold frozen (e.g. the recents list).
 * @property {() => void} onCycle - Apply the next item. Called on the trigger
 *   keydown that starts the gesture and on every re-press while it's active.
 * @property {() => void} onOpenMenu - Long-press reached: open the menu HUD.
 * @property {() => void} onCloseMenu - Close the menu HUD (must be idempotent —
 *   also called on Escape during press-started, before any menu opened).
 * @property {() => void} onCommit - Gesture ended by modifier release: persist
 *   the landing state (e.g. record it to recents). Not called on Escape.
 * @property {() => void} [onCancel] - Gesture ended by Escape: discard the
 *   landing state and restore what was committed before the gesture (e.g. a
 *   client that holds its live write until commit uses this to drop the
 *   preview). Optional; runs after onCloseMenu on the Escape path, never on a
 *   modifier-release commit.
 * @class
 */
class HoldToCycleController {
  /** @type {number} Threshold in ms for long press detection */
  static LONG_PRESS_THRESHOLD = 5;

  /**
   * @param {HoldToCycleConfig} config
   */
  constructor(config) {
    /** @type {HoldToCycleConfig} @private */
    this._config = config;
    /** @type {'idle'|'press-started'|'menu-open'} @private */
    this._phase = 'idle';
    /** @type {number|null} @private */
    this._longPressTimeout = null;

    // Bind handlers to preserve 'this' context
    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleKeyUp = this._handleKeyUp.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
  }

  /**
   * Attach the capture-phase keyboard listeners.
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
    this._endPointerIdle();
  }

  /**
   * Handle keydown events
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyDown(e) {
    const binding = keyShortcutManager.getBinding(this._config.shortcutId);
    if (!binding) return;

    // Phase: IDLE - waiting for the trigger combination
    if (this._phase === 'idle') {
      if (!eventMatchesBinding(binding, e)) return;
      if (!this._shouldHandle(e)) return;
      // Inapplicable right now (no selector, nothing to cycle) — fall through
      // untouched so the keystroke keeps whatever native meaning it has.
      if (this._config.canCycle && !this._config.canCycle()) return;

      e.preventDefault();
      e.stopPropagation();

      if (this._config.onGestureStart) this._config.onGestureStart();

      // Learn-by-doing: engaging the gesture retires its onboarding tip. The tip
      // id equals the shortcut id for every cycler (cycle-model / cycle-thinking
      // / strategy-switch), and we're past the canCycle gate, so this only fires
      // on a real, applicable use. Idempotent; a no-op for ids with no tip.
      markSeen(this._config.shortcutId);

      // Cycle immediately on keydown
      this._config.onCycle();

      this._phase = 'press-started';

      // Start long press timer - opens menu if the modifiers are still held
      this._longPressTimeout = window.setTimeout(() => {
        this._longPressTimeout = null;
        if (this._phase === 'press-started') {
          this._phase = 'menu-open';
          this._config.onOpenMenu();
          this._beginPointerIdle();
        }
      }, HoldToCycleController.LONG_PRESS_THRESHOLD);
      return;
    }

    // Phase: PRESS_STARTED / MENU_OPEN - the trigger key cycles again;
    // Escape cancels the whole gesture without committing.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._clearTimeout();
      this._phase = 'idle';
      this._endPointerIdle();
      this._config.onCloseMenu();
      if (this._config.onCancel) this._config.onCancel();
      return;
    }
    // The modifiers are necessarily still held (their release ends the
    // gesture in keyup), so a re-press of the trigger key satisfies the full
    // binding again — matched the same way as the initial press so the macOS
    // Option-glyph fallback in eventMatchesBinding applies here too.
    if (eventMatchesBinding(binding, e)) {
      e.preventDefault();
      e.stopPropagation();
      this._config.onCycle();
    }
  }

  /**
   * Handle keyup events — releasing any configured modifier ends the gesture:
   * close the menu if it opened, then commit. (During press-started the menu
   * never opened, so only the commit fires.)
   * @param {KeyboardEvent} e
   * @private
   */
  _handleKeyUp(e) {
    if (this._phase === 'idle') return;
    if (!this._config.modifierKeys.includes(e.key)) return;

    this._clearTimeout();
    const menuWasOpen = this._phase === 'menu-open';
    this._phase = 'idle';
    this._endPointerIdle();
    if (menuWasOpen) this._config.onCloseMenu();
    this._config.onCommit();
  }

  /**
   * Menu just opened as a HUD under a held modifier — and the OS has hidden the
   * pointer because the user is "typing". Flag the pointer as idle so the menu's
   * hover/click styling is suppressed (see the `body.hud-pointer-idle` CSS): an
   * item happening to sit under the stationary invisible cursor must not light
   * up as if hovered. The flag is cleared on the first real pointer motion, at
   * which point normal hover resumes.
   * @private
   */
  _beginPointerIdle() {
    document.body.classList.add('hud-pointer-idle');
    document.addEventListener('pointermove', this._handlePointerMove, { capture: true });
  }

  /**
   * Clear the pointer-idle flag and stop listening for motion. Idempotent — the
   * class removal and listener removal are both no-ops when never armed, so it
   * is safe to call on every gesture-end path.
   * @private
   */
  _endPointerIdle() {
    document.body.classList.remove('hud-pointer-idle');
    document.removeEventListener('pointermove', this._handlePointerMove, { capture: true });
  }

  /**
   * First pointer motion after the HUD opened: the cursor is live again, so
   * restore normal hover/click on the menu.
   * @private
   */
  _handlePointerMove() {
    this._endPointerIdle();
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
   * Check if a gesture may start on this event — the config's gate, defaulting
   * to {@link defaultShouldHandle}.
   * @param {KeyboardEvent} e
   * @returns {boolean} True if the gesture should start
   * @private
   */
  _shouldHandle(e) {
    return (this._config.shouldHandle || defaultShouldHandle)(e);
  }
}

/**
 * The default gesture gate, extracted verbatim from the original
 * StrategySwitcher: only handle when focus is in the main composer textarea
 * (inside `input-box`) and no modal dialog is open.
 * @param {KeyboardEvent} e
 * @returns {boolean} True if the gesture may start.
 */
export function defaultShouldHandle(e) {
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

  return true;
}

export default HoldToCycleController;
