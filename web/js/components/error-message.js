//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { createErrorArticle } from '../utils/icon-message-renderer.js';

/**
 * Signatures that identify an error as a failure to reach the provider at all,
 * rather than something the provider itself reported. Deliberately specific: a
 * bare "timeout" is not enough, because plenty of non-network failures say it.
 * @type {RegExp}
 */
const UNREACHABLE_SIGNATURE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection refused|connection reset|no such host|dial tcp|socket hang up|fetch failed|network error|tls handshake|getaddrinfo)\b/i;

/**
 * Plain-English lead for an unreachable provider. Rendered above the provider's
 * own text, never in place of it, so nothing needed to diagnose the failure is
 * lost.
 * @type {string}
 */
const UNREACHABLE_LEAD = 'Couldn’t reach the model. Could be problems at their end, or your network.';

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

    const contentBox = article.querySelector('.message-content-box');
    if (contentBox && this.content && UNREACHABLE_SIGNATURE.test(this.content)) {
      const leadEl = document.createElement('div');
      leadEl.className = 'error-message-lead';
      leadEl.textContent = UNREACHABLE_LEAD;
      contentBox.prepend(leadEl);
    }

    const actions = document.createElement('div');
    actions.className = 'error-message-actions message-row-body';

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
   * safe no-op if the thread can't be continued — so we always try rather than
   * duplicating those checks here.
   *
   * The deletion rides along as `beforeContinue` so it happens only if the
   * continue does. Deleting first was not safe: while the conversation is busy
   * driving any thread — a parent that has already been handed this error as a
   * sub-thread's result, most often — the continue is a silent no-op, and the
   * error would be gone with nothing started in its place, taking the Retry
   * button with it.
   * @private
   */
  _retry() {
    const thread = this._getMessageThread();
    if (!thread) return;
    const id = this.itemId;
    thread.continue(() => {
      if (id) thread.removeItemById(id);
    });
  }
}

customElements.define('error-message', ErrorMessage);

export default ErrorMessage;
