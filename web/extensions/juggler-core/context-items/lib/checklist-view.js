//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared checklist rendering for the `plan` and `todo` context items.
 *
 * Both tools show a status-annotated list of steps; the visual body is
 * identical, so it lives here and each plugin supplies the extras it needs via
 * `opts` (plan adds a title/status badge, per-step result cards, and sub-thread
 * links; todo uses the bare list). This is a RELATIVE import inside the
 * extension — never a `juggler/*` SDK bare specifier — so it works in the engine
 * worker without touching the SDK import-map seams.
 * @module juggler-core/context-items/lib/checklist-view
 */

import { createElement } from 'juggler/ui';
import { renderMarkdown } from 'juggler/ui';

const CHECKLIST_STYLES = `
/* Shared checklist view (plan + todo) */

.checklist-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.checklist-view .checklist-header {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checklist-view .checklist-title {
  font-family: var(--font-sans);
  font-size: 1rem;
  font-weight: 600;
  color: var(--context-item-text, var(--text-primary));
  margin: 0;
}

.checklist-view .checklist-status-badge {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.checklist-view .checklist-status-badge.status-planning {
  background: rgb(88 166 255 / 15%);
  color: #58a6ff;
}

.checklist-view .checklist-status-badge.status-approved {
  background: rgb(63 185 80 / 15%);
  color: #3fb950;
}

.checklist-view .checklist-status-badge.status-executing {
  background: rgb(210 153 34 / 15%);
  color: #d29922;
}

.checklist-view .checklist-status-badge.status-completed {
  background: rgb(63 185 80 / 15%);
  color: #3fb950;
}

/* Items List */

.checklist-view .checklist-items {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.checklist-view .checklist-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.25rem 0;
}

/* Item Indicator */
.checklist-view .checklist-item-indicator {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  color: var(--context-item-text-secondary, var(--text-secondary));
}

.checklist-view .checklist-item-indicator svg {
  width: 1.25rem;
  height: 1.25rem;
}

.checklist-view .checklist-item.status-completed .checklist-item-indicator svg {
  fill: #3fb950;
}

.checklist-view .checklist-item.status-in_progress .checklist-item-indicator svg {
  fill: #58a6ff;
}

.checklist-view .checklist-item.status-failed .checklist-item-indicator svg {
  fill: #f85149;
}

.checklist-view .checklist-item.status-skipped .checklist-item-indicator {
  color: var(--context-item-text-secondary, var(--text-secondary));
  opacity: 0.6;
}

/* Item Content */
.checklist-view .checklist-item-content {
  flex: 1;
  min-width: 0;
}

.checklist-view .checklist-item-text {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--context-item-text, var(--text-primary));
  margin: 0;
}

.checklist-view .checklist-item-text p {
  margin: 0;
}

.checklist-view .checklist-item-text code {
  background: rgb(255 255 255 / 10%);
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.checklist-view .checklist-item.status-completed .checklist-item-text {
  color: var(--context-item-text-secondary, var(--text-secondary));
}

.checklist-view .checklist-item.status-skipped .checklist-item-text {
  color: var(--context-item-text-secondary, var(--text-secondary));
  text-decoration: line-through;
  opacity: 0.6;
}

/* Step result summary — a distinct outcome card, not flowed-on text.
   A left accent bar + inset background separates it from the step
   description above; the accent colour is keyed to the step status. */
.checklist-view .checklist-item-result {
  margin-top: 0.4375rem;
  padding: 0.375rem 0.5rem 0.375rem 0.625rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--context-item-text-secondary, var(--text-secondary));
  background: var(--overlay-light-5, rgb(255 255 255 / 5%));
  border-left: 0.1875rem solid var(--overlay-light-20, rgb(255 255 255 / 20%));
  border-radius: 0 var(--radius-sm, 0.1875rem) var(--radius-sm, 0.1875rem) 0;
}

.checklist-view .checklist-item.status-completed .checklist-item-result {
  border-left-color: var(--accent-green, #3fb950);
}

.checklist-view .checklist-item.status-failed .checklist-item-result {
  border-left-color: var(--accent-red, #f85149);
}

.checklist-view .checklist-item.status-in_progress .checklist-item-result {
  border-left-color: var(--accent-blue, #58a6ff);
}

/* Thread link icon */
.checklist-view .checklist-item-thread-link {
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.checklist-view .checklist-item-thread-link:hover {
  opacity: 1;
}

.checklist-view .checklist-item-thread-link svg {
  width: 0.875rem;
  height: 0.875rem;
  fill: #58a6ff;
}

/* Action Bubble Variant (smaller padding for message context) */

.action-bubble .checklist-view {
  gap: 0.75rem;
}

.action-bubble .checklist-view .checklist-title {
  font-size: 0.875rem;
}

.action-bubble .checklist-view .checklist-item {
  padding: 0.5rem 0.75rem;
}

.action-bubble .checklist-view .checklist-item-text {
  font-size: 0.75rem;
}
`;

// Inject styles once when loaded in a document-owning viewer. Engine workers
// import this module for tool execution and must not touch DOM globals.
if (typeof document !== 'undefined' && !document.getElementById('checklist-view-styles')) {
  const style = document.createElement('style');
  style.id = 'checklist-view-styles';
  style.textContent = CHECKLIST_STYLES;
  document.head.appendChild(style);
}

/** @type {Record<string, string>} */
const INDICATOR_SVG = {
  completed: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M380.1-256.82 168.62-468.31l36-35.74L380.1-328.56l374.87-375.13 36 36L380.1-256.82Z"/></svg>',
  in_progress: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M340-237.64v-487.69l383.07 243.84L340-237.64Zm50.26-243.85Zm0 152 239.59-152-239.59-152v304Z"/></svg>',
  failed: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m256-192.35-63.65-63.65L416.35-480 192.35-704l63.65-63.65L480-543.65l224-224 63.65 63.65L543.65-480l224 224-63.65 63.65L480-416.35l-224 224Z"/></svg>',
};

const THREAD_LINK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-280H280q-83.33 0-141.67-58.33Q80-396.67 80-480t58.33-141.67Q196.67-680 280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83.33 0 141.67 58.33Q880-563.33 880-480t-58.33 141.67Q763.33-280 680-280H520Z"/></svg>';

/**
 * A single checklist step.
 * @typedef {object} ChecklistStep
 * @property {string} content - Step description (markdown)
 * @property {string} [status] - One of pending|in_progress|completed|failed|skipped
 * @property {string|null} [result] - Optional per-step result summary
 * @property {string|null} [threadItemId] - Optional linked sub-thread item id
 */

/**
 * Options controlling which extras the checklist renders.
 * @typedef {object} ChecklistViewOptions
 * @property {string} [title] - Header title (rendered only when present)
 * @property {string} [status] - List-level status for the header badge
 * @property {boolean} [showStatusBadge] - Show the list-level status badge
 * @property {boolean} [showResults] - Render per-step result cards
 * @property {boolean} [showThreadLinks] - Render per-step sub-thread link icons
 */

/**
 * Build the shared checklist view element for a list of steps.
 * @param {ChecklistStep[]} steps - The steps to render
 * @param {ChecklistViewOptions} [opts] - Rendering options
 * @returns {HTMLElement} The checklist view element
 */
export function createChecklistView(steps, opts = {}) {
  const {
    title = '',
    status = '',
    showStatusBadge = false,
    showResults = false,
    showThreadLinks = false,
  } = opts;

  const view = createElement('div', 'checklist-view');

  // Optional header with title and status badge.
  if (title) {
    const header = createElement('div', 'checklist-header');
    const titleRow = createElement('div', 'checklist-title-row');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:0.5rem';

    const titleEl = createElement('h3', 'checklist-title', title);
    titleRow.appendChild(titleEl);

    if (showStatusBadge && status && status !== 'planning') {
      const badge = createElement('span', 'checklist-status-badge');
      badge.classList.add(`status-${status}`);
      badge.textContent = status;
      titleRow.appendChild(badge);
    }

    header.appendChild(titleRow);
    view.appendChild(header);
  }

  const list = createElement('ol', 'checklist-items');

  for (const [i, step] of (steps || []).entries()) {
    const stepStatus = step.status || 'pending';

    const stepEl = createElement('li', 'checklist-item');
    stepEl.classList.add(`status-${stepStatus}`);

    // Step indicator (SVG icon or number).
    const indicator = createElement('div', 'checklist-item-indicator');
    if (INDICATOR_SVG[stepStatus]) {
      indicator.innerHTML = INDICATOR_SVG[stepStatus];
    } else if (stepStatus === 'skipped') {
      indicator.textContent = '\u2014';
    } else {
      indicator.textContent = String(i + 1);
    }
    stepEl.appendChild(indicator);

    // Step content.
    const content = createElement('div', 'checklist-item-content');
    const text = createElement('div', 'checklist-item-text markdown');
    text.innerHTML = renderMarkdown(step.content, { escapeXml: false });
    content.appendChild(text);

    if (showResults && step.result) {
      const resultEl = createElement('div', 'checklist-item-result', step.result);
      content.appendChild(resultEl);
    }

    stepEl.appendChild(content);

    // Optional sub-thread link icon.
    if (showThreadLinks && step.threadItemId) {
      const threadLink = createElement('div', 'checklist-item-thread-link');
      threadLink.innerHTML = THREAD_LINK_SVG;
      threadLink.title = 'Open step thread';
      threadLink.dataset.threadItemId = step.threadItemId;
      threadLink.addEventListener('click', (e) => {
        e.stopPropagation();
        threadLink.dispatchEvent(new CustomEvent('item-selected', {
          bubbles: true,
          composed: true,
          detail: { itemId: step.threadItemId }
        }));
      });
      stepEl.appendChild(threadLink);
    }

    list.appendChild(stepEl);
  }

  view.appendChild(list);
  return view;
}
