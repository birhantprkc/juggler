//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';

/**
 * Notice message component — a durable record of something that happened to a
 * turn and is worth reading after the fact: a provider rebuilding its context
 * cache, say. It stands in the transcript where the event occurred, so the
 * explanation is still there when the user gets round to looking at it.
 *
 * Amber triangle, no action button: a notice reports, it does not ask. The row
 * is one line — icon and title lozenge, the same tile every other one-liner
 * builds — because nothing failed and nothing needs doing. The detail (the
 * plain-English lead and the provider's verbatim reason) is read by selecting
 * the row, in the properties panel.
 */
class NoticeMessage extends BaseMessage {
  static get observedAttributes() {
    return ['notice-title'];
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

    // Title-as-lozenge and no summary text: the title alone says what happened,
    // and wrapWithIcon hoists the lozenge up beside the icon, leaving a row the
    // height of any other single-line item.
    const body = renderResultStatusMessage({ typeName: this.title || 'Notice', summary: '' });

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
