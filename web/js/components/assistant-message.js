//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderAssistantContentWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import '../utils/icon-message-renderer.js';

/**
 * Assistant message component - icon + markdown content with streaming support
 */
class AssistantMessage extends BaseMessage {
  /**
   * Whether this component supports streaming updates
   * @returns {boolean} True, this component supports streaming
   * @protected
   * @override
   */
  _supportsStreaming() {
    return true;
  }

  /**
   * Format content - strip thinking sections and render as markdown
   * @param {string} content
   * @returns {string} Formatted HTML content
   * @private
   */
  _formatContent(content) {
    return renderAssistantContentWrapped(stripThinkingTags(content));
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'assistant';

    const formattedContent = this._formatContent(this.content);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content-box';
    contentDiv.innerHTML = formattedContent;
    decorateCodeBlocks(contentDiv);

    article.appendChild(contentDiv);

    this._appendCopyButton(article, () => stripThinkingTags(this.content));

    this.replaceChildren(article);
  }

  /**
   * Efficient content update for streaming - only updates content, not entire element
   * @protected
   * @override
   */
  _updateContent() {
    const contentBox = this.querySelector('.message-content-box');
    if (contentBox) {
      const formattedContent = this._formatContent(this.content);
      contentBox.innerHTML = formattedContent;
      decorateCodeBlocks(/** @type {HTMLElement} */ (contentBox));
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
    const newContent = item.get('content') || '';
    if (this.getAttribute('content') === newContent) return;
    this.setAttribute('content', newContent);
    // Hide when the message has no visible text (e.g. a turn that was only tool calls)
    const hasVisible = newContent.trim().length > 0;
    this.style.display = hasVisible ? '' : 'none';
  }
}

customElements.define('assistant-message', AssistantMessage);

export default AssistantMessage;
