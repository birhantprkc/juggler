//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { registerContextMenuProvider } from '../services/context-menu-service.js';
import { copyToClipboard } from '../../sdk/lib/clipboard.js';
import { highlightCode } from '../../sdk/lib/syntax-highlight.js';

/**
 * Code block component with syntax highlighting and copy functionality.
 * Highlighting goes through the shared `highlightCode` engine (Prism-backed,
 * with a safe escaped-text fallback) — the same one used by tile summaries and
 * properties-panel subsections.
 */
class CodeBlock extends HTMLElement {
  constructor() {
    super();
  }

  static get observedAttributes() {
    return ['language', 'code'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  get language() {
    return this.getAttribute('language') || 'plaintext';
  }

  get code() {
    return this.getAttribute('code') || '';
  }

  async copyCode() {
    try {
      await copyToClipboard(this.code);
      this.showCopiedFeedback();
    } catch (error) {
      console.error('[CodeBlock] Failed to copy:', error);
      /** @type {any} */ (window).showAlert?.(/** @type {Error} */ (error).message, 'Copy Failed');
    }
  }

  showCopiedFeedback() {
    const button = /** @type {HTMLElement|null} */(this.querySelector('.copy-btn'));
    if (button) {
      const originalText = button.textContent;
      button.textContent = '✓ Copied!';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = originalText;
        button.classList.remove('copied');
      }, 2000);
    }
  }

  render() {
    const highlightedCode = highlightCode(this.code, this.language);

    this.innerHTML = `
            <header class="code-header">
                <span class="language">${this.language}</span>
                <button class="copy-btn" type="button">Copy</button>
            </header>
            <pre><code class="syntax-highlight language-${this.language}">${highlightedCode}</code></pre>
        `;
    const copyBtn = this.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copyCode());
    }
  }
}

customElements.define('code-block', CodeBlock);

// Right-click menu for code blocks: copy the raw code (and the file path when
// the block carries one). Reads off the <code-block> element's own attributes.
registerContextMenuProvider({
  match: (start) => start?.closest('code-block') || null,
  build: (subject) => {
    const code = subject.getAttribute('code') || '';
    const filePath = subject.getAttribute('data-file-path') || '';
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [{
      label: 'Copy code',
      disabled: !code,
      onClick: () => { void copyToClipboard(code).catch(() => {}); },
    }];
    if (filePath) {
      items.push({
        label: 'Copy file path',
        onClick: () => { void copyToClipboard(filePath).catch(() => {}); },
      });
    }
    return items;
  },
});
