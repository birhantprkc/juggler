//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import JugglerElement from './juggler-element.js';
import { createCopyButton } from '../utils/properties-panel-helpers.js';

/**
 * Base class for message components with shared functionality:
 * - Common attribute getters (itemId, itemIndex, content)
 * - Lifecycle management with proper cleanup (inherited from JugglerElement)
 * - Streaming support hooks
 * @abstract
 */
class BaseMessage extends JugglerElement {
  // === Lifecycle ===

  connectedCallback() {
    this.classList.add('conversation-item');
    this.render();
  }

  /**
   * @param {string} name
   * @param {string|null} oldValue
   * @param {string|null} newValue
   */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'content' && this._supportsStreaming()) {
      this._updateContent();
    } else {
      this.render();
    }
  }

  static get observedAttributes() {
    return ['content'];
  }

  // === Common Getters ===

  /** @returns {string|null} The message ID attribute value */
  get itemId() {
    return this.getAttribute('message-id');
  }

  /** @returns {number|null} The item index as a number, or null if not set */
  get itemIndex() {
    const index = this.getAttribute('item-index');
    return index !== null ? parseInt(index, 10) : null;
  }

  /** @returns {string} The content attribute value */
  get content() {
    return this.getAttribute('content') || '';
  }

  /**
   * Get conversation reference from parent conversation-area
   * @returns {import('../model/conversation.js').default|null} The conversation instance or null
   * @protected
   */
  _getConversation() {
    const conversationArea = this.closest('conversation-area');
    if (!conversationArea) return null;
    // @ts-ignore - conversation property exists on conversation-area
    return conversationArea.conversation || null;
  }

  /**
   * Get message thread from parent conversation-area
   * @returns {import('../model/message-thread.js').default|null} Message thread or null
   * @protected
   */
  _getMessageThread() {
    const conversationArea = /** @type {any} */ (this.closest('conversation-area'));
    return conversationArea?.getMessageThread?.() || null;
  }

  // === Override Points ===

  /**
   * Render the message. Subclasses must implement this.
   * @abstract
   */
  render() {
    throw new Error('Subclass must implement render()');
  }

  /**
   * Whether this component supports streaming updates.
   * If true, content attribute changes will call _updateContent() instead of render().
   * @returns {boolean} True if streaming is supported
   * @protected
   */
  _supportsStreaming() {
    return false;
  }

  /**
   * Update content efficiently during streaming (called when _supportsStreaming() returns true).
   * Default implementation falls back to full render.
   * @protected
   */
  _updateContent() {
    this.render();
  }

  /**
   * Append a hover-reveal copy-to-clipboard button to a message's root
   * `<article>`. The button sits in the upper-right and is revealed by CSS
   * when the pointer hovers the message (see `.message-copy-button`).
   * @param {HTMLElement} article - The message's root element (must be a
   *   positioning context — `position: relative` or similar).
   * @param {() => string} getText - Resolves the text to copy at click time.
   * @protected
   */
  _appendCopyButton(article, getText) {
    article.appendChild(createCopyButton(getText, 'message-copy-button'));
  }

  /**
   * Get the busy state for this message item.
   * Override in subclasses to declare custom busy states.
   * The footer aggregates these to show status without type-specific knowledge.
   * @returns {null|{message: string, spinner: boolean}} null if not busy
   */
  getBusyState() {
    return null;
  }
}

export default BaseMessage;
