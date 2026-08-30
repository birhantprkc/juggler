//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The pinboard as *this viewer* sees it: whether the board is open, which tab is
 * active, and what the last edit had to say for itself. None of that is shared —
 * {@link module:services/pinboard-store} holds the composition every viewer
 * agrees on, and a laptop and a detached display must not fight over which tab
 * either of them is reading.
 *
 * It is also the host service the rest of the UI calls to act on the board:
 * `toggle()`, `reveal()`, `addSource()`. A properties panel that wants to pin a
 * file describes the file and asks here; it never names a pin class, and it never
 * reaches into the board's components.
 *
 * The active pin is reconciled here rather than in the panel, because the board
 * changes for reasons this viewer had nothing to do with: another viewer removing
 * the pin you were reading must land you on its neighbour, not on the empty state.
 * @module services/pinboard-view
 */

import pinboardStore from './pinboard-store.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import { initialPinId } from '../utils/view-mode.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/** @typedef {import('./pinboard-store.js').Pin} Pin */

/** @type {boolean} */
let _open = false;

/** @type {string|null} */
let _activePinId = null;

/**
 * Where the active pin sat in the board the last time it was there. The board is
 * shared, so the pin being read can be removed by someone else; this is what lets
 * the tab to its right take over instead of the selection collapsing.
 * @type {number}
 */
let _activeIndex = 0;

/**
 * Whether the pin a board window was opened on has had its chance. The seed is
 * spent on the first board that arrives, found or not: a board is shared, so a
 * pin that has been removed since the window opened is a stale selection like
 * any other, and holding the seed for a later load would jump the user back to
 * it long after they had moved on.
 * @type {boolean}
 */
let _seedSpent = false;

/** @type {string} */
let _status = '';

/** @type {Set<() => void>} */
const _subscribers = new Set();

/**
 * Tell everyone the view changed. Subscribers re-read state rather than being
 * handed it: there are three fields and they are always read together.
 * @returns {void}
 */
function notify() {
  for (const fn of _subscribers) {
    try {
      fn();
    } catch (err) {
      console.error('[Pinboard] View subscriber failed:', err);
    }
  }
}

/**
 * Settle the active pin against a board. Keeps the current pin if it survived;
 * otherwise takes the one that slid into its place, and failing that the last one.
 * @param {Pin[]} pins - The board.
 * @returns {boolean} True when the active pin changed.
 */
function reconcileActive(pins) {
  const index = pins.findIndex((p) => p.id === _activePinId);
  if (index >= 0) {
    _activeIndex = index;
    return false;
  }
  if (!pins.length) {
    const had = _activePinId !== null;
    _activePinId = null;
    _activeIndex = 0;
    return had;
  }
  // A board window opens on the pin the user was reading, which is knowable
  // before its first board arrives and forgotten the moment it does.
  if (!_seedSpent) {
    _seedSpent = true;
    const seeded = pins.findIndex((p) => p.id === initialPinId());
    if (seeded >= 0) {
      _activePinId = /** @type {Pin} */ (pins[seeded]).id;
      _activeIndex = seeded;
      return true;
    }
  }
  const next = Math.min(_activeIndex, pins.length - 1);
  _activePinId = /** @type {Pin} */ (pins[next]).id;
  _activeIndex = next;
  return true;
}

pinboardStore.subscribe((pins) => {
  if (reconcileActive(pins)) notify();
});

/**
 * The pin already on the board that a new one of this type and config would
 * duplicate, if any. A singleton type collides with itself whatever its config;
 * a multiple-instance type collides only with a pin describing the same thing.
 * @param {string} typeId - Item-type id.
 * @param {Record<string, any>} config - Normalized config for the new pin.
 * @returns {Pin|null} The existing pin to reveal instead, or null.
 */
function findDuplicate(typeId, config) {
  const type = pinboardItemRegistry.getType(typeId);
  for (const pin of pinboardStore.get()) {
    if (pin.type !== typeId) continue;
    // Without a provider there is no isSameConfig to ask, so fall back to the
    // same shallow comparison the SDK defaults to.
    if (!type) {
      if (JSON.stringify(pin.config) === JSON.stringify(config)) return pin;
      continue;
    }
    if (!type.allowsMultiple) return pin;
    try {
      if (type.isSameConfig(pin.config, config)) return pin;
    } catch (err) {
      console.error(`[Pinboard] Item type "${typeId}" failed to compare configs:`, err);
    }
  }
  return null;
}

/**
 * Run a board edit, reporting a failure as the panel's status line rather than
 * throwing at a click handler. A successful edit clears whatever the last one
 * left behind.
 * @param {string} lead - Plain-English lead, e.g. 'Couldn't remove that pin.'
 * @param {() => Promise<any>} edit - The store call.
 * @returns {Promise<any>} What the edit returned, or null if it failed.
 */
async function attempt(lead, edit) {
  try {
    const result = await edit();
    pinboardView.setStatus('');
    return result;
  } catch (err) {
    pinboardView.setStatus(`${lead} ${extractErrorMessage(err)}`);
    return null;
  }
}

const pinboardView = {
  /**
   * Subscribe to view changes — open/closed, active pin, status. Fires after the
   * change, and callers should seed themselves from the getters first.
   * @param {() => void} fn - Called on every change.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  },

  /** @returns {boolean} True while the board is open in this viewer. */
  isOpen() {
    return _open;
  },

  /**
   * Open the board. Selects the last active pin if it is still there, otherwise
   * the first one.
   * @returns {void}
   */
  open() {
    const pins = pinboardStore.get();
    if (!pins.some((p) => p.id === _activePinId)) reconcileActive(pins);
    if (_open) return;
    _open = true;
    notify();
  },

  /**
   * Close the board. Pins are untouched: this is a viewer putting a panel away.
   * @returns {void}
   */
  close() {
    if (!_open) return;
    _open = false;
    notify();
  },

  /**
   * Toggle the board.
   * @returns {boolean} True if the board is now open.
   */
  toggle() {
    if (_open) this.close();
    else this.open();
    return _open;
  },

  /** @returns {string|null} The active pin's id, or null when nothing is active. */
  getActivePinId() {
    return _activePinId;
  },

  /**
   * Make a pin the active tab in this viewer, without opening the board.
   * @param {string|null} pinId - The pin to select.
   * @returns {void}
   */
  setActivePin(pinId) {
    if (_activePinId === pinId) return;
    _activePinId = pinId;
    const index = pinboardStore.get().findIndex((p) => p.id === pinId);
    if (index >= 0) _activeIndex = index;
    notify();
  },

  /**
   * Open the board on a particular pin.
   * @param {string} pinId - The pin to show.
   * @returns {void}
   */
  reveal(pinId) {
    this.setActivePin(pinId);
    this.open();
  },

  /** @returns {string} The last edit's complaint, or '' when there is nothing to say. */
  getStatus() {
    return _status;
  },

  /**
   * Set (or clear) the panel's status line.
   * @param {string} message - What to say; '' clears it.
   * @returns {void}
   */
  setStatus(message) {
    if (_status === message) return;
    _status = message;
    notify();
  },

  /**
   * Add a pin of a type, revealing the pin that already says the same thing
   * rather than adding a second one.
   * @param {string} typeId - Item-type id.
   * @param {Record<string, any>} [config] - Provider config.
   * @returns {Promise<Pin|null>} The pin now showing, or null if the add failed.
   */
  async add(typeId, config = {}) {
    const type = pinboardItemRegistry.getType(typeId);
    let normalized = config;
    if (type) {
      try {
        normalized = type.normalizeConfig(config) ?? config;
      } catch (err) {
        console.error(`[Pinboard] Item type "${typeId}" failed to normalize a config:`, err);
      }
    }
    const existing = findDuplicate(typeId, normalized);
    if (existing) {
      this.reveal(existing.id);
      return existing;
    }
    const pin = await attempt("Couldn't add that pin.", () => pinboardStore.add(typeId, normalized));
    if (pin) this.reveal(pin.id);
    return pin;
  },

  /**
   * Whether anything enabled could pin this source. For a surface deciding
   * whether to offer the action at all: a "Pin to Pinboard" button that does
   * nothing when clicked is worse than no button, so ask first and leave it out.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What would be pinned.
   * @returns {boolean} True when some enabled item type would take it.
   */
  canPin(source) {
    return !!pinboardItemRegistry.resolveSource(source);
  },

  /**
   * Pin something the user pointed at elsewhere in the UI — a file in a
   * properties panel, say. The registry decides which enabled type can take it,
   * so the caller describes what it has instead of naming a provider.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What to pin.
   * @returns {Promise<Pin|null>} The pin now showing, or null if nothing could pin it.
   */
  async addSource(source) {
    const resolved = pinboardItemRegistry.resolveSource(source);
    if (!resolved) return null;
    return this.add(resolved.typeId, resolved.config);
  },

  /**
   * Remove a pin from the shared board. Removing the panel never touches what it
   * was showing.
   * @param {string} pinId - The pin to remove.
   * @returns {Promise<void>}
   */
  async remove(pinId) {
    await attempt("Couldn't remove that pin.", () => pinboardStore.remove(pinId));
  },

  /**
   * Move a pin in the shared board order.
   * @param {string} pinId - The pin to move.
   * @param {number} index - Where to put it.
   * @returns {Promise<void>}
   */
  async move(pinId, index) {
    await attempt("Couldn't move that pin.", () => pinboardStore.move(pinId, index));
  },

  /**
   * Drop the view state without touching the board. For tests and teardown.
   * @returns {void}
   */
  reset() {
    _open = false;
    _activePinId = null;
    _activeIndex = 0;
    _seedSpent = false;
    _status = '';
  },
};

export default pinboardView;
