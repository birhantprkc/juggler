//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * tool-grouping-pref — the "collapse tool runs" display preference.
 *
 * When on, a run of adjacent tool-use rows in a column is drawn as ONE group
 * tile; selecting it opens the run's rows in the next column. This is purely a
 * display choice — nothing about it is written to the conversation document —
 * so it lives beside the other per-window UI prefs (bell, tips, info cards) in
 * localStorage rather than in the session. It applies to every project and
 * every tab in this window.
 * @module utils/tool-grouping-pref
 */

import { readPref, writePref, notifyPrefChanged } from '../services/ui-pref-store.js';

const PREF_KEY = 'juggler-tool-grouping';

/** Fired on window whenever the preference changes, so open views re-render. */
export const TOOL_GROUPING_EVENT = 'juggler:tool-grouping-changed';

/**
 * Whether adjacent tool-use rows should be collapsed into group tiles.
 * Defaults to off: the flat transcript is what a new user should see first.
 * @returns {boolean} True when grouping is enabled.
 */
export function isToolGroupingEnabled() {
  return readPref(PREF_KEY, false) === true;
}

/**
 * Set the preference and notify listeners.
 * @param {boolean} enabled - True to collapse tool runs into group tiles.
 * @returns {void}
 */
export function setToolGroupingEnabled(enabled) {
  writePref(PREF_KEY, !!enabled);
  notifyPrefChanged(TOOL_GROUPING_EVENT);
}

/**
 * Flip the preference.
 * @returns {boolean} The new state.
 */
export function toggleToolGrouping() {
  const next = !isToolGroupingEnabled();
  setToolGroupingEnabled(next);
  return next;
}
