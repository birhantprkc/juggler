//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { createErrorArticle } from '../utils/icon-message-renderer.js';

/**
 * Error message component - icon + error text with red icon
 */
class ErrorMessage extends BaseMessage {
  /**
   * Render the message
   * @override
   */
  render() {
    this.replaceChildren(createErrorArticle(this.content));
  }
}

customElements.define('error-message', ErrorMessage);

export default ErrorMessage;
