//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { markPopupOpen } from './popup-manager.js';

/**
 * Minimal click-to-expand image lightbox. Opens the given image full-size,
 * centered over a dimmed backdrop; click anywhere or press Escape to dismiss.
 *
 * Styling lives in `web/css/components.css` (`.image-lightbox`). Only one
 * lightbox is open at a time — opening a second dismisses the first.
 */

/** @type {(() => void)|null} The active lightbox's close fn, or null. */
let activeClose = null;

/**
 * Open a full-size image lightbox.
 * @param {string} src - Image URL to display.
 * @param {string} [alt] - Alt text for the enlarged image.
 * @returns {() => void} A function that closes this lightbox (idempotent).
 */
export function openImageLightbox(src, alt) {
  // Single-instance: replace any lightbox already open.
  if (activeClose) activeClose();

  const backdrop = document.createElement('div');
  backdrop.className = 'image-lightbox';

  const img = document.createElement('img');
  img.className = 'image-lightbox-img';
  img.src = src;
  img.alt = alt || '';
  backdrop.appendChild(img);

  document.body.appendChild(backdrop);

  // Mark a popup open so Escape (and the browser/mobile Back button) dismiss the
  // lightbox via popup-manager instead of cancelling a running turn behind it.
  const releasePopupOpen = markPopupOpen(() => close());

  const close = () => {
    if (activeClose !== close) return;
    activeClose = null;
    releasePopupOpen();
    backdrop.remove();
  };
  activeClose = close;

  // Click anywhere on the overlay (backdrop or image) closes it.
  backdrop.addEventListener('click', close);

  return close;
}
