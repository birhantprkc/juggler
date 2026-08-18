//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';

/**
 * Notice message component — a durable record of something that happened to a
 * turn and is worth reading after the fact: a provider rebuilding its context
 * cache, say. It stands in the transcript where the event occurred, so the
 * explanation is still there when the user gets round to looking at it.
 *
 * Amber triangle, no action button: a notice reports, it does not ask. The
 * hover delete control every transcript row carries is the only affordance —
 * a reader who does not care can tidy it away.
 */
class NoticeMessage extends BaseMessage {
  static get observedAttributes() {
    return ['content', 'notice-title'];
  }

  /** @returns {string} The notice's terse title */
  get title() {
    return this.getAttribute('notice-title') || '';
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'notice';

    const body = document.createElement('div');

    if (this.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'notice-message-title';
      titleEl.textContent = this.title;
      body.appendChild(titleEl);
    }

    // The detail carries the provider's own reason on its own line below the
    // plain-English lead, so `white-space: pre-wrap` (see .notice-message-detail)
    // keeps the two apart without parsing the text here.
    const detail = document.createElement('div');
    detail.className = 'notice-message-detail';
    detail.textContent = this.content;
    body.appendChild(detail);

    // The `error` glyph is a warning triangle; amber rather than the error
    // component's red, and distinct from thinking's yellow.
    article.appendChild(wrapWithIcon(body, {
      color: 'amber',
      iconSvg: TYPE_ICONS.error
    }));

    this.replaceChildren(article);
  }
}

customElements.define('notice-message', NoticeMessage);

export default NoticeMessage;
