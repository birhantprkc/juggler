//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * InfoCardsManager — the per-viewer hide gate (gate 2) for the ambient "info
 * cards" that fill the empty sidebar space above the Bin.
 *
 * Info cards are first-class extension plugins now: which cards *exist* and which
 * are enabled (gate 1) is owned by the {@link module:registries/info-card-registry}
 * and the server-side plugin config, toggled from the Extensions catalog. This
 * module owns only the lightweight, per-window *hide* on top of that: the × on a
 * card, and the info-cards menu that brings a hidden card back. A hidden card is
 * simply not mounted in this window — no server round-trip, no registry change.
 *
 * The hidden set is a single JSON blob in localStorage, mirroring the other
 * per-window UI prefs.
 * @module services/info-cards-manager
 */

import infoCardRegistry from '../registries/info-card-registry.js';
import { readPref, writePref, notifyPrefChanged } from './ui-pref-store.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';

/** localStorage key holding `{ hidden: string[] }` — the per-window hidden set. */
const STORAGE_KEY = 'juggler-info-cards-hidden';

/**
 * Fired on `window` whenever the shown set changes (the × on a card, the
 * info-cards menu) or a gate-1 catalog toggle rebuilds the registry. The info
 * rail and the info-cards button listen so they re-sync immediately instead of
 * waiting for an unrelated render.
 */
export const INFO_CARDS_CHANGED_EVENT = 'juggler:info-cards-changed';

/**
 * Read the persisted hidden set, tolerant of a missing/corrupt blob.
 * @returns {Set<string>} Ids of cards the user has hidden in this window.
 * @private
 */
function readHidden() {
  const raw = readPref(STORAGE_KEY, {});
  /** @type {unknown[]} */
  const list = raw && Array.isArray(raw.hidden) ? raw.hidden : [];
  return new Set(/** @type {string[]} */ (list.filter((id) => typeof id === 'string')));
}

/**
 * Persist the hidden set, best-effort.
 * @param {Set<string>} hidden
 * @private
 */
function writeHidden(hidden) {
  writePref(STORAGE_KEY, { hidden: Array.from(hidden) });
}

/**
 * The gate-1 enabled card instances, highest priority first. Used by the info
 * rail to render and by the info-cards menu to list what can be shown/hidden.
 * @returns {InstanceType<typeof import('juggler/info-card-type').default>[]} The enabled card instances.
 */
export function providers() {
  return infoCardRegistry.getEnabledCards();
}

/**
 * @param {string} id - A card id.
 * @returns {boolean} Whether the card is currently hidden in this window.
 */
export function isHidden(id) {
  return readHidden().has(id);
}

/**
 * Hide a card in this window (the × on the card). Persisted locally and
 * broadcast; never touches the server or the registry.
 * @param {string} id - A card id.
 * @returns {void}
 */
export function hideCard(id) {
  const hidden = readHidden();
  if (hidden.has(id)) return;
  hidden.add(id);
  writeHidden(hidden);
  notifyPrefChanged(INFO_CARDS_CHANGED_EVENT);
}

/**
 * Un-hide a card in this window (the info-cards menu). On the genuine
 * hidden→shown transition the card's optional `onEnabled` hook runs first (the
 * Tips card uses it to replay all tips).
 * @param {string} id - A card id.
 * @returns {void}
 */
export function showCard(id) {
  const hidden = readHidden();
  if (!hidden.has(id)) return;
  hidden.delete(id);
  writeHidden(hidden);
  const card = providers().find((c) => c.id === id);
  if (card && typeof card.onEnabled === 'function') {
    try { card.onEnabled(); } catch { /* hook is best-effort */ }
  }
  notifyPrefChanged(INFO_CARDS_CHANGED_EVENT);
}

/**
 * Every gate-1 enabled card with its per-window shown/hidden state — for the
 * info-cards menu to render a show/hide toggle apiece, in priority order.
 * @returns {Array<{id: string, name: string, hidden: boolean}>} One entry per enabled card.
 */
export function allInfoCards() {
  const hidden = readHidden();
  return providers().map((c) => ({ id: c.id, name: c.name, hidden: hidden.has(c.id) }));
}

// A gate-1 catalog toggle rebuilds the registry (REGISTRIES_RELOADED); re-emit
// the info-cards change so the rail and menu reconcile against the new enabled
// set. Viewer-only: guarded on document so the engine worker never binds it.
if (typeof document !== 'undefined') {
  document.addEventListener(REGISTRIES_RELOADED, () => notifyPrefChanged(INFO_CARDS_CHANGED_EVENT));
}
