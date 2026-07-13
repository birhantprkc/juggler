//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ui-pref-store — the shared primitives behind the per-window UI-preference
 * managers (tips, info-cards). Each such pref is a single JSON blob in
 * localStorage, read and written best-effort (a corrupt or unwritable store just
 * falls back to the default / re-shows next session), plus a best-effort `window`
 * CustomEvent so live views re-sync immediately. There's no server round-trip.
 * @module services/ui-pref-store
 */

/**
 * Read a JSON blob from localStorage, tolerant of a missing/corrupt value.
 * @param {string} key - localStorage key.
 * @param {any} fallback - Returned on any miss/parse error.
 * @returns {any} The parsed value, or `fallback`.
 */
export function readPref(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

/**
 * Persist a JSON-serializable value to localStorage, best-effort.
 * @param {string} key - localStorage key.
 * @param {any} value - The value to store.
 * @returns {void}
 */
export function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort broadcast of a named UI-pref change on `window`, so live views can
 * re-sync without waiting for an unrelated render.
 * @param {string} eventName - The CustomEvent name to dispatch.
 * @returns {void}
 */
export function notifyPrefChanged(eventName) {
  try {
    window.dispatchEvent(new CustomEvent(eventName));
  } catch {
    /* no window / CustomEvent — nothing to notify */
  }
}
