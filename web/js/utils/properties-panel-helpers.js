//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Properties-panel rendering helpers.
 *
 * Plugin-neutral DOM utilities for building tool-action detail views.
 * Used by PropertiesPanel itself and by ContextItem.renderToolActionDetails
 * implementations in plugin classes — so plugins can render rich UI
 * without coupling to the PropertiesPanel component.
 */

import { revealLabel } from '../components/reveal-button.js';
import { registerContextMenuProvider } from '../services/context-menu-service.js';
import { osOpenPath, osRevealPath } from '../services/ops-api.js';
import { applyAnsi, stripAnsi } from '../../sdk/lib/ansi.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { createCopyButton } from '../../sdk/lib/copy-button.js';
import { highlightCode } from '../../sdk/lib/syntax-highlight.js';
import { yGet } from '../model/item-accessor.js';

// Re-exported so existing importers keep their `properties-panel-helpers`
// import path; the button itself is now a plugin-neutral primitive.
export { createCopyButton };

/**
 * Create a copyable text container with inline copy button.
 * @param {string} text - Text to copy
 * @param {string} [className] - CSS class for the text element
 * @param {{ansi?: boolean, language?: string}} [options] - When `ansi` is set,
 *   render the text as terminal output (parse ANSI colour codes into styled
 *   spans) and copy the escape-stripped visible text to the clipboard. When
 *   `language` is set (e.g. 'bash'), syntax-highlight the text via Prism; the
 *   copy button always yields the raw, un-highlighted text. `ansi` takes
 *   precedence over `language`.
 * @returns {HTMLElement} Wrapper element containing text and copy button
 */
export function createCopyableText(text, className = 'properties-panel-text', { ansi = false, language = '' } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'properties-panel-copyable';

  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';

  copyHeader.appendChild(createCopyButton(() => (ansi ? stripAnsi(text) : text)));
  wrapper.appendChild(copyHeader);

  const textEl = document.createElement('pre');
  textEl.className = className;
  if (ansi) {
    applyAnsi(textEl, text);
  } else if (language) {
    textEl.classList.add('syntax-highlight', `language-${language}`);
    textEl.innerHTML = highlightCode(text, language);
  } else {
    textEl.textContent = text;
  }
  wrapper.appendChild(textEl);

  return wrapper;
}

/**
 * Add a labeled subsection containing copyable text.
 * @param {HTMLElement} wrapper
 * @param {string} label
 * @param {string} text
 * @param {string} [className]
 * @param {{ansi?: boolean, language?: string}} [options] - Forwarded to
 *   {@link createCopyableText} (e.g. `{ language: 'bash' }` to syntax-highlight).
 */
export function addSubsection(wrapper, label, text, className = 'properties-panel-code', options = {}) {
  const section = labeledSubsection(label);
  section.appendChild(createCopyableText(text, className, options));
  wrapper.appendChild(section);
}

/**
 * Build a `<properties-panel-subsection>` with a leading `.properties-panel-subtitle`
 * heading, ready for the caller to append its body.
 *
 * Shared scaffolding for the labeled-subsection variants here, and exported for
 * the panels whose body is an element rather than text — {@link addSubsection}
 * only takes a string, so anything richer would otherwise hand-roll this.
 * @param {string} label - Heading text
 * @returns {HTMLElement} The subsection element (label already appended).
 */
export function labeledSubsection(label) {
  const section = document.createElement('properties-panel-subsection');
  const labelEl = document.createElement('h4');
  labelEl.className = 'properties-panel-subtitle';
  labelEl.textContent = label;
  section.appendChild(labelEl);
  return section;
}

/**
 * Add a labeled subsection rendering LLM-provided descriptive text (e.g. a
 * tool call's `description` field) in the shared `.llm-description` style, so
 * the properties panel matches the italic-accent typography used for the same
 * text on the item tile — rather than boxing it as preformatted text.
 * @param {HTMLElement} wrapper
 * @param {string} label
 * @param {string} text
 */
export function addLlmDescription(wrapper, label, text) {
  const section = labeledSubsection(label);

  const textEl = document.createElement('div');
  textEl.className = 'llm-description';
  textEl.textContent = text;
  section.appendChild(textEl);

  wrapper.appendChild(section);
}

/**
 * Add a bare file path display (no heading) with copy + reveal buttons.
 * The path fills the full available width of its row, with the copy + reveal
 * buttons pinned to the right. If `info` is provided, it renders as a small
 * annotation (e.g. file size, line count) on its own line below the path row.
 * @param {HTMLElement} wrapper
 * @param {string} path
 * @param {string} [info] - Optional annotation (e.g. "1.2 KB | 42 lines")
 */
export function addFilePath(wrapper, path, info) {
  const row = document.createElement('div');
  row.className = 'properties-panel-filepath-row';

  const el = document.createElement('div');
  el.className = 'properties-panel-filepath';
  el.textContent = path;
  // Expose the path for the right-click menu (Open / Reveal / Copy path) —
  // see the provider registered at the bottom of this module.
  if (path) el.dataset.filePath = path;
  row.appendChild(el);

  if (path) {
    const actions = document.createElement('div');
    actions.className = 'properties-panel-filepath-actions';

    actions.appendChild(createCopyButton(path, 'properties-panel-filepath-btn', 'Copy path to clipboard'));

    const reveal = document.createElement('reveal-button');
    reveal.setAttribute('path', path);
    actions.appendChild(reveal);

    row.appendChild(actions);
  }

  wrapper.appendChild(row);

  if (info) {
    const infoEl = document.createElement('div');
    infoEl.className = 'properties-panel-filepath-info';
    infoEl.textContent = info;
    wrapper.appendChild(infoEl);
  }
}

/**
 * Append a diff viewer if the tool-action has a diffData snapshot.
 * @param {HTMLElement} wrapper
 * @param {any} toolAction - Y.Map for the tool action
 * @param {string} fallbackPath
 * @returns {boolean} True if a diff viewer was added
 */
export function addDiffViewer(wrapper, toolAction, fallbackPath) {
  const diffData = yGet(toolAction, 'displayData')?.diffData;
  if (!diffData?.oldContent || !diffData?.newContent) return false;

  const diffViewer = document.createElement('diff-viewer');
  diffViewer.classList.add('properties-panel-diff');
  /** @type {any} */ (diffViewer).setDiff(
    diffData.oldContent,
    diffData.newContent,
    diffData.path || fallbackPath,
    diffData.startLineNumber || 1
  );
  wrapper.appendChild(diffViewer);
  return true;
}

// Right-click menu for file references (pinned @files, read-file results, any
// path rendered via addFilePath). Open / Reveal go through the host-OS `os` op;
// Copy path is local. When the path sits inside a removable context item that
// attached an unpin hook (see FileContentContextItem), a "Remove from context"
// row is appended.
registerContextMenuProvider({
  match: (start) => start?.closest('[data-file-path]') || null,
  build: (subject) => {
    const path = subject.getAttribute('data-file-path') || '';
    if (!path) return null;
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [
      { label: 'Open file', onClick: () => { void osOpenPath({ path }).catch(() => {}); } },
      { label: revealLabel(), onClick: () => { void osRevealPath({ path }).catch(() => {}); } },
      { label: 'Copy path', onClick: () => { void copyToClipboard(path).catch(() => {}); } },
    ];
    const host = subject.closest('[data-context-item-id]');
    const unpin = host && /** @type {any} */ (host)._jugglerRemoveFromContext;
    if (typeof unpin === 'function') {
      items.push({ separator: true });
      items.push({ label: 'Remove from context', danger: true, onClick: () => unpin() });
    }
    return items;
  },
});
