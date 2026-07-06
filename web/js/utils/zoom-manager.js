//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Zoom Manager - Handles UI zoom via root font-size scaling
 * Persists zoom preference in localStorage
 */

const ZOOM_KEY = 'juggler-zoom';
const ZOOM_STEP = 10;
const ZOOM_MIN = 60;
const ZOOM_MAX = 160;
const ZOOM_DEFAULT = 110;

/**
 * Get current zoom level from localStorage or default
 * @returns {number} Current zoom level (percentage)
 */
function getZoom() {
  const stored = localStorage.getItem(ZOOM_KEY);
  if (stored === null) return ZOOM_DEFAULT;
  const parsed = parseInt(stored, 10);
  return Number.isNaN(parsed) ? ZOOM_DEFAULT : parsed;
}

/**
 * Apply zoom level to document
 * @param {number} level - Zoom percentage
 * @private
 */
function applyZoom(level) {
  document.documentElement.style.fontSize = level + '%';
}

/**
 * Set zoom level, persist, and apply
 * @param {number} level - Zoom percentage (clamped to min/max)
 */
function setZoom(level) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  localStorage.setItem(ZOOM_KEY, clamped.toString());
  applyZoom(clamped);
}

/**
 * Increase zoom by one step
 */
export function zoomIn() {
  setZoom(getZoom() + ZOOM_STEP);
}

/**
 * Decrease zoom by one step
 */
export function zoomOut() {
  setZoom(getZoom() - ZOOM_STEP);
}

/**
 * Initialize zoom on page load
 */
function initZoom() {
  applyZoom(getZoom());
}

// Auto-initialize when module loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initZoom);
} else {
  initZoom();
}
