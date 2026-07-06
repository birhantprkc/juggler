//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderMarkdownWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import '../utils/icon-message-renderer.js';

/**
 * XML tag names used in LLM protocol for tool calls
 * @constant
 */
const XML_TAGS = {
  TOOL: 'tool',
  ACTION: 'action',
  DROP: 'drop'
};

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
   * Format content - strip XML tags and render as markdown
   * @param {string} content
   * @returns {string} Formatted HTML content
   * @private
   */
  _formatContent(content) {
    return renderMarkdownWrapped(this._cleanContent(content), { escapeXml: true });
  }

  /**
   * Strip the protocol XML tags (tool/action/drop/context-item) and
   * thinking tags from raw content, leaving the human-readable markdown
   * source. Used both for rendering and for copy-to-clipboard.
   * @param {string} content
   * @returns {string} Cleaned markdown source
   * @private
   */
  _cleanContent(content) {
    let cleanContent = stripThinkingTags(content);
    let totalCount = 0;

    // Remove tool tags
    const toolResult = this._removeXmlTags(cleanContent, XML_TAGS.TOOL, `<${XML_TAGS.TOOL} use="`, `</${XML_TAGS.TOOL}>`);
    cleanContent = toolResult.content;
    totalCount += toolResult.count;

    // Remove context-item tags
    const contextItemResult = this._removeXmlTags(cleanContent, 'context-item', `<context-item use="`, `</context-item>`);
    cleanContent = contextItemResult.content;
    totalCount += contextItemResult.count;

    // Remove action tags
    const actionResult = this._removeXmlTags(cleanContent, XML_TAGS.ACTION, `<${XML_TAGS.ACTION}`, `</${XML_TAGS.ACTION}>`);
    cleanContent = actionResult.content;
    totalCount += actionResult.count;

    // Remove drop tags
    const dropResult = this._removeXmlTags(cleanContent, XML_TAGS.DROP, `<${XML_TAGS.DROP}>`, `</${XML_TAGS.DROP}>`);
    cleanContent = dropResult.content;
    totalCount += dropResult.count;

    cleanContent = cleanContent.trim();

    // If the message was ONLY tool/action/drop calls (no text content), show indicator
    if (totalCount > 0 && !cleanContent) {
      cleanContent = `[Using ${totalCount} tool${totalCount > 1 ? 's' : ''}...]`;
    }

    return cleanContent;
  }

  /**
   * Remove XML tags (both complete and incomplete during streaming)
   * @param {string} content - Content to process
   * @param {string} _tagName - Tag name (unused, for documentation)
   * @param {string} openPattern - Opening tag pattern to search for
   * @param {string} closeTag - Closing tag to search for
   * @returns {{content: string, count: number}} Cleaned content and count of complete tags
   * @private
   */
  _removeXmlTags(content, _tagName, openPattern, closeTag) {
    let cleanContent = content;
    let count = 0;

    while (true) {
      const openTagStart = cleanContent.indexOf(openPattern);
      if (openTagStart === -1) break;

      const openTagEnd = cleanContent.indexOf('>', openTagStart);
      if (openTagEnd === -1) {
        cleanContent = cleanContent.substring(0, openTagStart);
        break;
      }

      const closeTagStart = cleanContent.indexOf(closeTag, openTagEnd + 1);

      if (closeTagStart === -1) {
        cleanContent = cleanContent.substring(0, openTagStart);
        break;
      } else {
        count++;
        const closeTagEnd = closeTagStart + closeTag.length;
        cleanContent = cleanContent.substring(0, openTagStart) + cleanContent.substring(closeTagEnd);
      }
    }

    return { content: cleanContent, count };
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

    this._appendCopyButton(article, () => this._cleanContent(this.content));

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
