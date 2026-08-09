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
 * Create a click-to-expand image thumbnail.
 *
 * The single place an `<img>` for displayable content is built: the image file
 * viewer, a sent message's attachments, and the composer's staged attachments
 * all render through it, so the intrinsic-size handling and the lightbox wiring
 * exist once rather than in four hand-rolled copies.
 *
 * Intrinsic `width`/`height` let the browser reserve the right box and derive
 * the aspect ratio before the bytes load; CSS caps the displayed size.
 * @param {{src: string, alt?: string, className?: string, width?: number, height?: number, clickable?: boolean}} opts - Image options
 * @returns {HTMLImageElement} The image element (not yet attached to the DOM)
 */
export function createImageThumb(opts) {
  const img = document.createElement('img');
  if (opts.className) img.className = opts.className;
  img.alt = opts.alt || '';
  img.loading = 'lazy';
  if (opts.width) img.width = opts.width;
  if (opts.height) img.height = opts.height;
  if (opts.src) {
    img.src = opts.src;
    if (opts.clickable !== false) {
      img.addEventListener('click', () => openImageLightbox(img.src, img.alt));
    }
  }
  return img;
}

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
