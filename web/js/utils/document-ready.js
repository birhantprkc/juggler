//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Run `fn` once the DOM is ready: immediately if the document has already
 * finished parsing, otherwise on `DOMContentLoaded`. No-ops entirely off the
 * main thread (the engine worker has no `document`), so viewer-only auto-init
 * side effects can call this unconditionally at module load.
 * @param {() => void} fn - Callback to invoke when the document is ready.
 * @module utils/document-ready
 */
export function onDocumentReady(fn) {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}
