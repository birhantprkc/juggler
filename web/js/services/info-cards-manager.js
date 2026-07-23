//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * InfoCardsManager — the source of truth for the ambient "info cards" that fill
 * the empty sidebar space above the Bin: which cards exist, in what priority
 * order, and which the user has enabled. Presentation lives in
 * {@link module:components/info-rail}; each card's content and metadata live with
 * its own provider module (see `components/cards/`). This module just owns the
 * ordered registry and the persisted on/off state.
 *
 * Enabled state is stored as a sparse map of *user overrides* in localStorage —
 * a card the user has never touched falls back to its provider's `defaultEnabled`,
 * so shipping a new card on-by-default doesn't require migrating everyone's blob.
 * Mirrors the other per-window UI prefs; there's no server round-trip.
 * @module services/info-cards-manager
 */

import { tipsCard } from '../components/cards/tips-card.js';
import { usageCard } from '../components/cards/usage-card.js';
import { gitStatusCard } from '../components/cards/git-status-card.js';
import { readPref, writePref, notifyPrefChanged } from './ui-pref-store.js';

/**
 * Every info-card provider, in priority order — the info rail stacks them from
 * the top and drops the tail first when the sidebar runs out of room.
 * @type {import('../components/info-rail.js').InfoCardProvider[]}
 */
const PROVIDERS = [tipsCard, usageCard, gitStatusCard];

/** localStorage key holding `{ overrides: { [id]: boolean } }`. */
const STORAGE_KEY = 'juggler-info-cards';

/**
 * Fired on `window` whenever a card is enabled or disabled (the Settings toggle,
 * or the × on a card). The info rail and any open Settings panel listen so they
 * re-sync immediately instead of waiting for an unrelated render.
 */
export const INFO_CARDS_CHANGED_EVENT = 'juggler:info-cards-changed';

/**
 * Read the persisted override map, tolerant of a missing/corrupt blob.
 * @returns {Record<string, boolean>} id → user-chosen enabled state.
 * @private
 */
function readOverrides() {
  const raw = readPref(STORAGE_KEY, {});
  const overrides = raw && typeof raw.overrides === 'object' && raw.overrides ? raw.overrides : {};
  /** @type {Record<string, boolean>} */
  const clean = {};
  for (const [id, on] of Object.entries(overrides)) {
    if (typeof on === 'boolean') clean[id] = on;
  }
  return clean;
}

/**
 * Persist the override map, best-effort.
 * @param {Record<string, boolean>} overrides
 * @private
 */
function writeOverrides(overrides) {
  writePref(STORAGE_KEY, { overrides });
}

/**
 * The card providers, in priority order. Used by the info rail to render.
 * @returns {import('../components/info-rail.js').InfoCardProvider[]} The providers.
 */
export function providers() {
  return PROVIDERS;
}

/**
 * @param {string} id - A card id.
 * @returns {boolean} Whether that card is currently enabled (override, else the
 *   provider default). Unknown ids are treated as disabled.
 */
export function isCardEnabled(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) return false;
  const override = readOverrides()[id];
  return typeof override === 'boolean' ? override : !!provider.defaultEnabled;
}

/**
 * Turn a card on or off. Persisted as a user override and broadcast. On a genuine
 * off→on transition the provider's optional `onEnabled` hook runs first (the Tips
 * card uses it to replay all tips).
 * @param {string} id - A card id.
 * @param {boolean} on
 * @returns {void}
 */
export function setCardEnabled(id, on) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) return;
  const wasEnabled = isCardEnabled(id);
  const overrides = readOverrides();
  overrides[id] = !!on;
  writeOverrides(overrides);
  if (on && !wasEnabled && typeof provider.onEnabled === 'function') provider.onEnabled();
  notifyPrefChanged(INFO_CARDS_CHANGED_EVENT);
}

/**
 * Metadata for every card, in priority order — for the Settings page to render a
 * toggle per card.
 * @returns {Array<{id: string, label: string, description: string, enabled: boolean}>}
 *   One entry per card, in priority order.
 */
export function allInfoCards() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.settingsLabel,
    description: p.settingsDescription,
    enabled: isCardEnabled(p.id),
  }));
}
