//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/ui` — DOM, rendering and formatting helpers for an extension's
 * properties panel and result rendering.
 *
 * Curated re-export façade: only the symbols built-ins actually depend on are
 * surfaced, so the public UI surface is decoupled from the internal util layout.
 */

// DOM construction / escaping
export {
  createElement,
  escapeHtml,
  escapeAttr,
  getToggleIcons,
  renderResultStatusMessage,
  createSummaryRow,
  createSummaryWithSubtitle,
  createLlmDescription,
} from './lib/html.js';

// One-shot stylesheet injection for modules that ship their own CSS
export { injectStylesOnce } from './lib/inject-styles.js';

// Output truncation / token budgets
export { smartTruncate, getBudgetForCallCount } from './lib/smart-truncate.js';

// Error formatting
export {
  extractErrorMessage,
  extractUserMessage,
  extractErrorInfo,
} from './lib/error-utils.js';

// Dropdown positioning
export { positionDropdown } from './lib/dropdown-positioning.js';

// Popup presentation (anchored dropdown ↔ phone bottom sheet)
export { presentPopup } from '../js/utils/popup-surface.js';

// Properties-panel building blocks
export {
  createCopyButton,
  createCopyableText,
  addSubsection,
  labeledSubsection,
  addFilePath,
  addDiffViewer,
} from '../js/utils/properties-panel-helpers.js';

// Syntax highlighting (Prism-backed, safe fallback)
export { highlightCode, createHighlightedCode } from './lib/syntax-highlight.js';

// Markdown rendering
export {
  renderMarkdown,
  renderMarkdownWrapped,
  decorateCodeBlocks,
  escapeXmlTagsForMarkdown,
} from './lib/markdown.js';

// Task-list markers (the `[ ]`/`[/]`/`[x]`/`[!]`/`[-]` vocabulary)
export { taskMarker, taskStatusWord } from './lib/task-markers.js';

// Misc formatting helpers
export { FormattingHelpers } from './lib/formatting-helpers.js';

// Full-screen image overlay (shared by the image viewer and attachment thumbs)
export { openImageLightbox, createImageThumb } from '../js/utils/image-lightbox.js';

// Project-picker panel (used by file/path-selecting items)
export { buildPickerPanel } from '../js/components/project-picker.js';
