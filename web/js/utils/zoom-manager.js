//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Zoom Manager - Handles UI zoom via root font-size scaling.
 *
 * Zoom is per-window, and remembered per project: the authoritative store is the
 * project's session (server-side), so reopening a project restores the size you
 * left it at even though each window is a separate process on its own port (a
 * fresh, empty localStorage). The precedence when a window opens is:
 *
 *   1. this project's saved session zoom  (window.__sessionZoom, server-injected)
 *   2. an inherited ?zoom= seed           (from the window that opened this one)
 *   3. this window's localStorage cache   (a no-project window's own last value)
 *   4. the default
 *
 * The session value is authoritative, and the inherited seed outranks
 * localStorage, because every project's server reuses the same origin — so a
 * bare localStorage value may belong to a DIFFERENT project. On change we persist
 * to the session (the server no-ops for a no-project window), cache in
 * localStorage, and report to the native host so the next window it opens
 * inherits this (last-active) size.
 *
 * The synchronous pre-paint block in index.html applies the same precedence
 * before first paint (a font-size change reflows everything, so a late
 * correction is a visible jump); this module is the authoritative reconciler and
 * owns persistence.
 */

import { onDocumentReady } from './document-ready.js';
import { postWindowControl } from '../../sdk/lib/window-control.js';
import { fetchJson } from '../services/http.js';

const ZOOM_KEY = 'juggler-zoom';
const ZOOM_STEP = 10;
const ZOOM_MIN = 60;
const ZOOM_MAX = 160;
const ZOOM_DEFAULT = 110;

/** The live applied zoom level, resolved at init and updated on every change. */
let current = ZOOM_DEFAULT;

/**
 * Clamp a level to the supported range.
 * @param {number} level - Raw zoom percentage.
 * @returns {number} Clamped percentage.
 */
function clamp(level) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
}

/**
 * Parse and clamp a stored/param string; null when absent or not a number.
 * @param {string|null} raw - Candidate value.
 * @returns {number|null} A valid clamped level, or null.
 */
function parseLevel(raw) {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : clamp(n);
}

/**
 * The project session's saved zoom, injected pre-paint by the server. Absent
 * (null) for a no-project window or a project that has never saved a zoom.
 * @returns {number|null} The authoritative session zoom, or null.
 */
function sessionZoom() {
  const z = Number(window.__sessionZoom);
  return z > 0 ? clamp(z) : null;
}

/** @returns {number|null} This window's cached level, or null. */
function storedZoom() {
  return parseLevel(localStorage.getItem(ZOOM_KEY));
}

/**
 * The inherited seed from the window that opened this one (a ?zoom= param the
 * native host bakes into the URL).
 * @returns {number|null} The seed level, or null.
 */
function seedZoom() {
  try {
    return parseLevel(new URL(window.location.href).searchParams.get('zoom'));
  } catch (_e) {
    return null;
  }
}

/**
 * Apply a zoom level to the document root.
 * @param {number} level - Zoom percentage.
 * @private
 */
function applyZoom(level) {
  document.documentElement.style.fontSize = level + '%';
}

/**
 * Persist the current zoom into this project's session (best-effort). The token
 * fetch shim authorises the request; the server no-ops for a no-project window.
 * @param {number} level - Zoom percentage.
 * @private
 */
function persistToSession(level) {
  // Best-effort — a missing/blocked fetch just skips session persistence.
  void fetchJson('/api/session/ui-zoom', { method: 'PUT', body: { uiZoom: level }, fallback: null });
}

/**
 * Report the current zoom to the native host so the next window it opens
 * inherits this (last-active) size. A no-op in a plain browser tab.
 * @param {number} level - Zoom percentage.
 * @private
 */
function reportToHost(level) {
  postWindowControl('zoom', '?zoom=' + level);
}

/**
 * The live applied zoom level.
 * @returns {number} Current zoom percentage.
 */
export function getCurrentZoom() {
  return current;
}

/**
 * Set zoom level, apply, persist (session + localStorage cache), and report to
 * the native host so new windows inherit it.
 * @param {number} level - Zoom percentage (clamped to min/max).
 */
function setZoom(level) {
  current = clamp(level);
  applyZoom(current);
  try {
    localStorage.setItem(ZOOM_KEY, current.toString());
  } catch (_e) {
    /* localStorage may be full or unavailable — the session copy still holds */
  }
  persistToSession(current);
  reportToHost(current);
}

/**
 * Increase zoom by one step.
 */
export function zoomIn() {
  setZoom(current + ZOOM_STEP);
}

/**
 * Decrease zoom by one step.
 */
export function zoomOut() {
  setZoom(current - ZOOM_STEP);
}

/**
 * Initialize zoom on page load. Resolves the level by precedence, adopts it
 * (idempotent with the pre-paint block), caches it, and reports it to the host.
 * When the window inherited a seed into a session that had none of its own, the
 * inherited size is persisted so the project remembers it next time — never
 * overriding a saved session value, and never stamping the plain default.
 * @private
 */
function initZoom() {
  const session = sessionZoom();
  const stored = storedZoom();
  const seed = seedZoom();

  current = session ?? seed ?? stored ?? ZOOM_DEFAULT;
  applyZoom(current);
  try {
    localStorage.setItem(ZOOM_KEY, current.toString());
  } catch (_e) {
    /* cache write is best-effort */
  }
  // Report to the host so its inheritance seed tracks this window's size.
  reportToHost(current);
  // Remember an inherited seed against the project so a later reopen (with no
  // live inheritance) still restores it. Only when the session had nothing —
  // i.e. this window inherited its size — so a saved session zoom is never
  // overwritten and the plain default is never stamped.
  if (session === null && seed !== null) {
    persistToSession(current);
  }
}

// Auto-initialize when module loads. Zoom is a viewer affordance; onDocumentReady
// skips off the main thread (the engine worker has no document).
onDocumentReady(initZoom);
