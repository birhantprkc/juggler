//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { createErrorArticle } from '../utils/icon-message-renderer.js';

// Retry icon (Material "refresh") — a circular arrow, distinct from the
// footer's Continue "play" glyph so the affordance reads as "try that turn again".
const RETRY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"/></svg>';

/**
 * Error message component - icon + error text with red icon, plus a Retry
 * action. Many LLM-loop errors (out-of-tokens for the window, a transient
 * network blip) are worth simply trying again, so the error item carries its
 * own retry affordance: clicking it deletes this error item and continues the
 * thread — the same continue the footer button triggers, minus the dead error.
 */
class ErrorMessage extends BaseMessage {
  /**
   * Render the message
   * @override
   */
  render() {
    const article = createErrorArticle(this.content);

    const actions = document.createElement('div');
    actions.className = 'error-message-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'message-action-btn error-retry-btn';
    retryBtn.title = 'Delete this error and continue the conversation';
    retryBtn.innerHTML = `${RETRY_ICON}Retry`;
    retryBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._retry();
    });
    actions.appendChild(retryBtn);
    article.appendChild(actions);

    this.replaceChildren(article);
  }

  /**
   * Delete this error item, then continue the thread. Continue is the footer's
   * exact entry point (`MessageThread.continue()`), whose own guards make it a
   * safe no-op if the thread can't be continued — so we always try after
   * clearing the error rather than duplicating those checks here.
   * @private
   */
  _retry() {
    const thread = this._getMessageThread();
    if (!thread) return;
    const id = this.itemId;
    if (id) thread.removeItemById(id);
    thread.continue();
  }
}

customElements.define('error-message', ErrorMessage);

export default ErrorMessage;
