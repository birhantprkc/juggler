//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-shell> — the pinboard's attached surface: the scrim, and the panel
 * that slides over the working area. The control that opens it is the header
 * bar's own button, which this element adopts rather than builds — the board is
 * one of the window's surfaces, so its toggle stands with the window's controls
 * at every width.
 *
 * The board OVERLAYS the workspace rather than taking width from it. The
 * conversation columns are wide, horizontally scrolling and full of held scroll
 * positions; narrowing them every time the board opens would reflow and jump the
 * thing the user was reading, to show them something beside it.
 *
 * Opening is latched — a click, or the shortcut. Clicking inside the board never
 * closes it, and neither does the pointer leaving: file previews, text selection
 * and drags all need to survive a wandering mouse. There is no hover peek.
 *
 * The chord is dispatched here rather than by the shortcut manager: an open board
 * holds a popup token, and the manager stands every command down behind an
 * overlay — which is right for every command except the one that closes this one.
 * @module components/pinboard-shell
 */

import JugglerElement from './juggler-element.js';
import pinboardStore from '../services/pinboard-store.js';
import pinboardView from '../services/pinboard-view.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import keyShortcutManager, { eventMatchesBinding } from '../services/key-shortcut-manager.js';
import { markPopupOpen, isAnyPopupOpen } from '../utils/popup-manager.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isPinboardView } from '../utils/view-mode.js';
import './pinboard-panel.js';

/** localStorage key holding the panel's width, in rem. */
const WIDTH_KEY = 'juggler-pinboard-width';

/**
 * Panel width bounds, in rem. Wide, on purpose: what the board is for changes
 * with what is on it — a task list wants a strip, a file wants half the display
 * — so the bounds are the extremes of usefulness rather than a house opinion,
 * and `_applyWidth` clamps to the viewport on top of them.
 */
const MIN_WIDTH_REM = 20;
const MAX_WIDTH_REM = 80;
const DEFAULT_WIDTH_REM = 34;

class PinboardShell extends JugglerElement {
  constructor() {
    super();
    /** @type {HTMLElement|null} @private The header bar's toggle, adopted on build. */
    this._toggleButton = null;
    /** @type {HTMLElement|null} @private */
    this._scrim = null;
    /** @type {any} @private */
    this._panel = null;
    /** @type {(() => void)|null} @private Popup-manager token held while open. */
    this._releasePopup = null;
    /** @type {HTMLElement|null} @private Where focus was when the board opened. */
    this._focusReturn = null;
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {boolean} @private Whether the board has been fetched for this project. */
    this._loadStarted = false;
    /** @type {number} @private The panel's width in rem, after clamping. */
    this._widthRem = DEFAULT_WIDTH_REM;
  }

  connectedCallback() {
    this._build();
    this.addCleanup(pinboardStore.subscribe(() => this._syncVisibility()));
    this.addCleanup(pinboardView.subscribe(() => this._syncOpen()));
    // Enabling or disabling an extension can be what gives the board its first
    // item type, or takes its last one away.
    this.onDocument(REGISTRIES_RELOADED, () => this._syncVisibility());
    this.onDocument('keydown', (e) => this._onKeyDown(/** @type {KeyboardEvent} */ (e)));
    this._syncVisibility();
    this._syncOpen();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._releasePopup?.();
    this._releasePopup = null;
  }

  /**
   * Supply the session, and fetch the board once there is a project to have one.
   * @param {import('../model/session.js').default} session - The viewer's session.
   * @returns {void}
   */
  setSession(session) {
    this._session = session;
    this._panel?.setSession(session);
    this._syncVisibility();
    if (!session) return;
    this.addCleanup(/** @type {() => void} */ (
      session.subscribe(/** @param {{type: string}} event */ (event) => {
        if (event.type === 'session:loaded' || event.type === 'project:changed') this._syncVisibility();
      })
    ));
  }

  /**
   * Build the surface once: scrim, panel and its resize handle, and adopt the
   * header bar's toggle.
   * @private
   */
  _build() {
    if (this._panel) return;
    if (isPinboardView()) {
      this._buildDetached();
      return;
    }

    const scrim = document.createElement('div');
    scrim.className = 'pinboard-scrim';
    // Dimming is decoration; the click it catches is the outside-click dismissal.
    scrim.setAttribute('aria-hidden', 'true');
    this.on(scrim, 'click', () => pinboardView.close());

    const panel = document.createElement('pinboard-panel');
    panel.id = 'pinboard-panel';
    panel.className = 'pinboard-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Pinboard');

    const handle = document.createElement('div');
    handle.className = 'pinboard-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    this.on(handle, 'pointerdown', (e) => this._beginResize(/** @type {PointerEvent} */ (e)));
    panel.appendChild(handle);

    this.append(scrim, panel);
    this._scrim = scrim;
    this._panel = panel;

    this._applyWidth(loadWidth());

    // The toggle belongs to the header bar, beside the window's other controls,
    // and is written in the markup there — the shell only wires it up and keeps
    // its expanded state honest.
    const toggle = document.getElementById('pinboard-header-button');
    if (toggle) {
      this._toggleButton = toggle;
      this.on(toggle, 'click', () => this._toggle());
    }
  }

  /**
   * Build the board as the whole window rather than as an overlay in one: the
   * panel and nothing else. There is no toggle to adopt because there is nothing
   * to open, no scrim because there is no workspace behind to dim, and no resize
   * handle because the window itself is the width control.
   * @private
   */
  _buildDetached() {
    const panel = document.createElement('pinboard-panel');
    panel.id = 'pinboard-panel';
    panel.className = 'pinboard-panel';
    panel.setAttribute('role', 'main');
    panel.setAttribute('aria-label', 'Pinboard');
    this.append(panel);
    this._panel = panel;
  }

  /**
   * Open or close the board, remembering where focus was so closing can put it
   * back.
   * @private
   */
  _toggle() {
    if (pinboardView.isOpen()) {
      pinboardView.close();
      return;
    }
    const focused = document.activeElement;
    this._focusReturn = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    pinboardView.open();
  }

  /**
   * Reflect the view state: the class the CSS animates from, the popup token
   * Escape and Back dismiss through, and where focus goes.
   * @private
   */
  _syncOpen() {
    const open = pinboardView.isOpen();
    if (open === this.classList.contains('open')) return;
    this.classList.toggle('open', open);
    this._toggleButton?.setAttribute('aria-expanded', String(open));

    // A detached board is the window's only content, so it holds no popup token
    // — Escape dismisses the topmost surface, and here that would be everything
    // the window has — and there is nowhere to return focus to on close.
    if (isPinboardView()) return;

    if (open) {
      // Escape and the browser/mobile Back button dismiss via popup-manager. The
      // token is id-less, so the board is not closed by the add picker (or any
      // other menu) opening over it.
      this._releasePopup = markPopupOpen(() => pinboardView.close());
      this._panel?.focusInto();
      return;
    }

    this._releasePopup?.();
    this._releasePopup = null;
    const back = this._focusReturn?.isConnected ? this._focusReturn : this._toggleButton;
    this._focusReturn = null;
    // Scrolling is the workspace's business, not focus's: the element focus goes
    // back to may have been scrolled away while the board was up, and hauling
    // the columns to it would move what the reader was reading.
    back?.focus({ preventScroll: true });
  }

  /**
   * Show the board only when it is worth having: a project to own it, and either
   * an item type that can fill a tab or a pin already on the board. A toggle that
   * opens an empty board with nothing to put in it is worse than no toggle — so
   * with no pinboard extension enabled, the surface stays away rather than
   * advertising itself.
   *
   * A pin whose extension has been disabled still counts: it is the only way
   * back to a board holding pins nothing can currently render.
   * @private
   */
  _syncVisibility() {
    const hasProject = !!this._session?.projectPath;
    if (hasProject && !this._loadStarted) {
      this._loadStarted = true;
      void pinboardStore.load().catch((err) => {
        pinboardView.setStatus(`Couldn't load the pinboard. ${extractErrorMessage(err)}`);
      });
    }
    const usable = pinboardItemRegistry.getEnabledTypes().length > 0 || pinboardStore.get().length > 0;
    this.hidden = !hasProject || !usable;
    // The toggle lives in the header rather than in here, so it does not go away
    // with the shell and has to be told.
    if (this._toggleButton) this._toggleButton.hidden = this.hidden;
    if (this.hidden) {
      pinboardView.close();
      return;
    }
    // Open is the detached board's only state, and this is the moment it can
    // first be in it: the shell is built before the session arrives, so at build
    // time there is no project yet and nothing to show.
    if (isPinboardView()) pinboardView.open();
  }

  /**
   * The board's own chord. Dispatched here rather than through the shortcut
   * manager's loop: while the board is open it holds a popup token, and the
   * manager suppresses every command behind an overlay — including this one.
   * @param {KeyboardEvent} e - The keydown.
   * @private
   */
  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (this.hidden) return;
    // Nothing to toggle when the board is the window: closing it would mean
    // closing the window, which is what the window's own controls are for.
    if (isPinboardView()) return;
    const bindings = keyShortcutManager.getBindings('toggle-pinboard');
    if (!bindings.some((binding) => eventMatchesBinding(binding, e))) return;
    // Opening the board over a modal would put it behind that modal's own
    // dismissal; closing it from inside is the whole reason this lives here.
    if (!pinboardView.isOpen() && isAnyPopupOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    this._toggle();
  }

  /**
   * Drag the panel's left edge. Dragging left widens it, so the delta is the
   * opposite way round from a column handle.
   * @param {PointerEvent} start - The pointerdown on the handle.
   * @private
   */
  _beginResize(start) {
    if (start.button !== 0) return;
    start.preventDefault();
    const handle = /** @type {HTMLElement} */ (start.currentTarget);
    handle.setPointerCapture(start.pointerId);
    handle.classList.add('dragging');
    const startX = start.clientX;
    const startWidth = /** @type {HTMLElement} */ (this._panel).getBoundingClientRect().width;

    const onMove = (/** @type {PointerEvent} */ move) => {
      this._applyWidth((startWidth + (startX - move.clientX)) / remPx());
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', /** @type {any} */ (onMove));
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      saveWidth(this._widthRem);
    };
    handle.addEventListener('pointermove', /** @type {any} */ (onMove));
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /**
   * Set the panel width, clamped to its bounds and to a viewport that may be
   * narrower than either of them.
   * @param {number} rem - The requested width in rem.
   * @private
   */
  _applyWidth(rem) {
    const viewportRem = window.innerWidth / remPx();
    const max = Math.min(MAX_WIDTH_REM, Math.max(MIN_WIDTH_REM, viewportRem - 2));
    this._widthRem = Math.max(MIN_WIDTH_REM, Math.min(max, rem));
    this.style.setProperty('--pinboard-width', `${this._widthRem}rem`);
  }
}

/**
 * @returns {number} The root font size in CSS pixels.
 */
function remPx() {
  return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * The width this viewer last chose. Viewer-local by design: a laptop and a large
 * display must not argue about how wide the board is.
 * @returns {number} A width in rem.
 */
function loadWidth() {
  try {
    const saved = parseFloat(localStorage.getItem(WIDTH_KEY) || '');
    if (Number.isFinite(saved) && saved > 0) return saved;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WIDTH_REM;
}

/**
 * Remember a width for next time.
 * @param {number} rem - The width to store.
 * @returns {void}
 */
function saveWidth(rem) {
  try {
    localStorage.setItem(WIDTH_KEY, String(rem));
  } catch {
    // localStorage unavailable
  }
}

customElements.define('pinboard-shell', PinboardShell);

export default PinboardShell;
