//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';
import { formatTokens } from '../utils/format.js';

/**
 * Thinking message component - compact summary line with yellow icon and streaming support.
 * Full content is shown in the properties panel.
 */
class ThinkingMessage extends BaseMessage {
  _supportsStreaming() {
    return true;
  }


  /**
   * Returns "Thinking · N tokens" label, or just "Thinking" when content is empty.
   * @param {string} content
   * @returns {string} Summary label for the thread display
   * @private
   */
  _tokenLabel(content) {
    const clean = stripThinkingTags(content);
    if (!clean.length) return 'Thinking';
    const n = Math.ceil(clean.length / 4);
    return `Thinking · ${formatTokens(n)} tokens`;
  }

  render() {
    const article = document.createElement('article');
    article.className = 'thinking';

    const contentDiv = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'thinking-summary';
    span.textContent = this._tokenLabel(this.content);
    contentDiv.appendChild(span);

    article.appendChild(wrapWithIcon(contentDiv, iconOptionsForItem(null, { fallbackType: 'thinking' })));

    this.replaceChildren(article);
  }

  _updateContent() {
    const span = this.querySelector('.thinking-summary');
    if (span) {
      span.textContent = this._tokenLabel(this.content);
    } else {
      this.render();
    }
  }

  /**
   * Update from Yjs item data (called by conversation-area)
   * @param {any} item - The Yjs item
   */
  updateFromItem(item) {
    if (!item) return;
    this._setStreamContent(item.get('content') || '');
  }
}

customElements.define('thinking-message', ThinkingMessage);

export default ThinkingMessage;
