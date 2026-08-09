//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker-safe `juggler/ui` facade.
 *
 * Engine/plugin workers may import modules that reference UI helpers for
 * viewer-only methods, but those helpers must not pull DOM modules into the
 * worker at import time. Pure formatting helpers are re-exported; DOM helpers
 * are present as throwing stubs so accidental engine-side use fails clearly.
 */

export { smartTruncate, getBudgetForCallCount } from './lib/smart-truncate.js';
export {
  extractErrorMessage,
  extractUserMessage,
  extractErrorInfo,
} from './lib/error-utils.js';
export { FormattingHelpers } from './lib/formatting-helpers.js';

// Pure (DOM-free): highlightCode returns escaped/highlighted HTML as a string
// and no-ops to escaped text when `window.Prism` is absent — which it always is
// off the main thread — so it is safe to surface for real in the worker.
export { highlightCode } from './lib/syntax-highlight.js';

/**
 * @param {string} text
 * @returns {string} HTML-escaped text
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {string} text
 * @returns {string} Attribute-escaped text
 */
export function escapeAttr(text) {
  return String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {string} text
 * @returns {string} JSON-content-escaped text
 */
export function escapeJsonContent(text) {
  return escapeHtml(JSON.stringify(String(text)).slice(1, -1));
}

/** @param {string} name */
function domUnavailable(name) {
  throw new Error(`juggler/ui.${name} is viewer-only and unavailable in an engine worker`);
}

// Viewer-only DOM helpers — present so plugin imports resolve in the engine
// worker, but they throw if actually called off the main thread. Arrow consts
// (not function declarations) keep require-jsdoc quiet without per-stub noise.
export const createElement = () => domUnavailable('createElement');
export const getToggleIcons = () => domUnavailable('getToggleIcons');
export const renderResultStatusMessage = () => domUnavailable('renderResultStatusMessage');
export const positionDropdown = () => domUnavailable('positionDropdown');
export const presentPopup = () => domUnavailable('presentPopup');
export const createCopyButton = () => domUnavailable('createCopyButton');
export const createCopyableText = () => domUnavailable('createCopyableText');
export const addSubsection = () => domUnavailable('addSubsection');
export const addFilePath = () => domUnavailable('addFilePath');
export const addDiffViewer = () => domUnavailable('addDiffViewer');
export const openImageLightbox = () => domUnavailable('openImageLightbox');
export const createImageThumb = () => domUnavailable('createImageThumb');
export const renderMarkdown = () => domUnavailable('renderMarkdown');
export const renderMarkdownWrapped = () => domUnavailable('renderMarkdownWrapped');
export const decorateCodeBlocks = () => domUnavailable('decorateCodeBlocks');
export const escapeXmlTagsForMarkdown = () => domUnavailable('escapeXmlTagsForMarkdown');
export const buildPickerPanel = () => domUnavailable('buildPickerPanel');
export const createHighlightedCode = () => domUnavailable('createHighlightedCode');
export const createSummaryRow = () => domUnavailable('createSummaryRow');
export const createSummaryWithSubtitle = () => domUnavailable('createSummaryWithSubtitle');
export const createLlmDescription = () => domUnavailable('createLlmDescription');
