//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { escapeHtml } from '../../sdk/lib/html.js';

/**
 * Thinking Block Component
 * Displays Claude's extended thinking/reasoning in a collapsible panel.
 */
class ThinkingBlock extends HTMLElement {
  connectedCallback() {
    const thinking = this.getAttribute('thinking') || '';
    const signature = this.getAttribute('signature') || '';
    const expanded = this.hasAttribute('expanded');

    this.innerHTML = `
            <div class="thinking-block ${expanded ? 'expanded' : 'collapsed'}">
                <button class="thinking-block-header" type="button" aria-expanded="${expanded}">
                    <span class="thinking-block-icon">${expanded ? '▼' : '▶'}</span>
                    <span class="thinking-block-title">Extended Thinking</span>
                    ${signature ? `<span class="thinking-block-signature">${escapeHtml(signature)}</span>` : ''}
                </button>
                <div class="thinking-block-content ${expanded ? '' : 'hidden'}">
                    <pre class="thinking-block-text">${escapeHtml(thinking)}</pre>
                </div>
            </div>
        `;

    // Add click handler for expand/collapse
    const header = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-block-header'));
    const content = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-block-content'));
    const icon = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-block-icon'));
    const container = /** @type {HTMLElement|null} */ (this.querySelector('.thinking-block'));

    header?.addEventListener('click', () => {
      const isExpanded = container?.classList.contains('expanded');

      if (isExpanded) {
        container?.classList.remove('expanded');
        container?.classList.add('collapsed');
        content?.classList.add('hidden');
        if (icon) icon.textContent = '▶';
        header.setAttribute('aria-expanded', 'false');
      } else {
        container?.classList.remove('collapsed');
        container?.classList.add('expanded');
        content?.classList.remove('hidden');
        if (icon) icon.textContent = '▼';
        header.setAttribute('aria-expanded', 'true');
      }
    });
  }

}

// Register the custom element
customElements.define('thinking-block', ThinkingBlock);
