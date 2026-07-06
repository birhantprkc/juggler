//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/** Worker-safe `juggler/item-utils` facade. */

export {
  formatFileSize,
  formatDisplayPath,
  formatFileContentForLLM,
  normalizeFilePath,
} from './lib/context-item-utils.js';

/** @param {string} name */
function domUnavailable(name) {
  throw new Error(`juggler/item-utils.${name} is viewer-only and unavailable in an engine worker`);
}

// Viewer-only DOM helpers — present so plugin imports resolve in the engine
// worker, but they throw if actually called off the main thread.
export const createEmptyState = () => domUnavailable('createEmptyState');
export const createTextBlock = () => domUnavailable('createTextBlock');
export const createCodeBlock = () => domUnavailable('createCodeBlock');
// Style injection is a no-op without a document, not an error: context items
// call it defensively during construction.
export const injectFileContentStyles = () => {};
