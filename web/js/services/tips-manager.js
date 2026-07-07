//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * TipsManager — the source of truth for onboarding tips: short hints that raise
 * awareness of features a new user is unlikely to stumble on. Presentation lives
 * in {@link module:components/cards/tips-card}; this module just owns the tip list
 * and the persisted "seen" state.
 *
 * Shortcut tips are *derived* from the {@link module:services/key-shortcut-manager
 * KeyShortcutManager} by id, so their title and key glyph can't drift from the
 * real (rebindable) binding. Feature tips are hand-authored for gestures with no
 * key. "Seen" state lives in localStorage, mirroring the other per-window UI
 * prefs; there's no server round-trip. Whether the Tips card is shown at all is
 * a separate concern owned by {@link module:services/info-cards-manager}.
 * @module services/tips-manager
 */

import keyShortcutManager from './key-shortcut-manager.js';

/** localStorage key holding `{ seen: string[] }`. */
const STORAGE_KEY = 'juggler-tips';

/**
 * Fired on `window` whenever a tip is retired (learn-by-doing, or the seen set
 * otherwise changes). The sidebar rail listens so it re-syncs immediately instead
 * of waiting for an unrelated render.
 */
export const TIPS_CHANGED_EVENT = 'juggler:tips-changed';

/**
 * Best-effort broadcast that the tips state changed.
 * @returns {void}
 * @private
 */
function notifyChanged() {
  try {
    window.dispatchEvent(new CustomEvent(TIPS_CHANGED_EVENT));
  } catch {
    /* no window / CustomEvent — nothing to notify */
  }
}

/**
 * A materialized tip ready for display.
 * @typedef {object} Tip
 * @property {string} id - Stable identifier, also the localStorage "seen" key.
 * @property {'shortcut'|'feature'} kind - Shortcut tips render a live key glyph.
 * @property {string} title - Short headline.
 * @property {string} body - One-line explanation.
 * @property {string} [shortcutId] - For `kind:'shortcut'`, the KeyShortcutManager
 *   id — the view formats it live so the glyph stays platform-correct.
 */

/**
 * Shortcut tips, in priority order: `{ id, body }`. The title and key glyph are
 * read live from the shortcut table (an id no longer defined is dropped); the body
 * is authored here so it adds context instead of restating the title.
 * @type {Array<{id: string, body: string}>}
 */
const SHORTCUT_TIPS = [
  { id: 'jump-to-attention', body: 'Jump straight to whichever conversation is waiting on you, landing on its pending approval.' },
  { id: 'new-conversation', body: 'Spin up another conversation and switch to it — run several in parallel.' },
  { id: 'toggle-file-editing', body: 'Flip between letting the agent edit files freely and asking you first.' },
  { id: 'bin-conversation', body: 'Clear a conversation out of the way — you can restore it from the Bin anytime.' },
];

/**
 * Feature tips — hand-authored, for gestures with no keyboard shortcut. Limited to
 * gestures verified to exist in the composer.
 * @type {Tip[]}
 */
const FEATURE_TIPS = [
  {
    id: 'mention-files',
    kind: 'feature',
    title: 'Reference a file',
    body: 'Type @ in the message box to search your project and add a file into the conversation.',
  },
  {
    id: 'slash-commands',
    kind: 'feature',
    title: 'Slash commands',
    body: 'Type / at the start of the message box — or press the / button — for quick actions.',
  },
  {
    id: 'paste-images',
    kind: 'feature',
    title: 'Paste a screenshot',
    body: 'Drag-and-drop or copy-paste an image file into the message box to attach it to your prompt.',
  },
];

/**
 * Read the persisted state, tolerant of a missing/corrupt blob.
 * @returns {{seen: string[]}} The merged state.
 * @private
 */
function readState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    return {
      seen: Array.isArray(raw.seen) ? raw.seen.filter((/** @type {any} */ x) => typeof x === 'string') : [],
    };
  } catch {
    return { seen: [] };
  }
}

/**
 * Persist state, best-effort (a failed write just re-shows the tip next session).
 * @param {{seen: string[]}} state
 * @private
 */
function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/**
 * Every tip in priority order (shortcut tips first), with shortcut copy
 * materialized live from the table. Dangling shortcut ids are dropped.
 * @returns {Tip[]} All displayable tips in priority order.
 */
export function allTips() {
  /** @type {Tip[]} */
  const shortcuts = [];
  for (const entry of SHORTCUT_TIPS) {
    const def = keyShortcutManager.all().find((d) => d.id === entry.id);
    if (def) shortcuts.push({ id: entry.id, kind: 'shortcut', title: def.label, body: entry.body, shortcutId: entry.id });
  }
  return [...shortcuts, ...FEATURE_TIPS];
}

/**
 * @param {string} id
 * @returns {boolean} Whether this tip has been seen.
 */
export function isSeen(id) {
  return readState().seen.includes(id);
}

/**
 * Retire one tip permanently (learn-by-doing: the user performed its action on
 * their own). Idempotent.
 * @param {string} id
 * @returns {void}
 */
export function markSeen(id) {
  const state = readState();
  if (!state.seen.includes(id)) {
    state.seen.push(id);
    writeState(state);
    notifyChanged();
  }
}

/**
 * Clear the "seen" record so every tip plays again from the top. Called when the
 * user re-enables the Tips card — otherwise, once all tips are seen, turning the
 * card back on would show nothing and there'd be no way to replay them.
 * @returns {void}
 */
export function resetSeen() {
  writeState({ seen: [] });
  notifyChanged();
}
