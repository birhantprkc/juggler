//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * DOM animation helpers. Pure UI affordances — no-ops when there's no document
 * (e.g. the headless engine worker).
 * @module services/animation-service
 */

/**
 * Spin the refresh icon for a context item to acknowledge a manual refresh.
 * @param {string} itemId - Context item ID
 * @returns {void}
 */
export function animateContextItemRefresh(itemId) {
  // Pure UI affordance — the engine worker has no document to animate.
  if (typeof document === 'undefined') return;
  const wrapper = document.getElementById(`wrapper-${itemId}`);
  if (!wrapper) {
    console.warn('[AnimationService] Context item wrapper not found for animation:', itemId);
    return;
  }

  const refreshBtn = wrapper.querySelector('.context-item-refresh-btn svg');
  if (!refreshBtn || !(refreshBtn instanceof HTMLElement || refreshBtn instanceof SVGElement)) {
    console.warn('[AnimationService] Refresh button not found for:', itemId);
    return;
  }

  // Remove any existing animation
  refreshBtn.style.animation = 'none';
  // Force reflow to restart animation
  if (refreshBtn instanceof HTMLElement) {
    void refreshBtn.offsetWidth;
  }
  // Apply spin animation (2 full rotations over 0.6s)
  refreshBtn.style.animation = 'spin 0.6s ease-in-out';

  // Clean up animation after it completes
  setTimeout(() => {
    if (refreshBtn instanceof HTMLElement || refreshBtn instanceof SVGElement) {
      refreshBtn.style.animation = '';
    }
  }, 600);
}
