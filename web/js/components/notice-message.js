//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseMessage from './base-message.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import { wrapWithIcon, TYPE_ICONS } from '../utils/icon-message-renderer.js';
import { NOTICE_TYPE_NAME } from '../utils/item-badge.js';

/**
 * Notice message component — a durable record of something that happened to a
 * turn and is worth reading after the fact: a provider rebuilding its context
 * cache, say. It stands in the transcript where the event occurred, so the
 * explanation is still there when the user gets round to looking at it.
 *
 * Amber triangle, no action button: a notice reports, it does not ask. The row
 * is one line — icon, a "Warning" lozenge and a sentence saying what happened —
 * because nothing failed and nothing needs doing. The lozenge says only what
 * kind of item this is; a reader who cannot see why it is there has been told
 * nothing, so the sentence beside it carries the meaning. The rest (the
 * measured values, the provider's verbatim reason) is read by selecting the
 * row, in the properties panel.
 */
class NoticeMessage extends BaseMessage {
  static get observedAttributes() {
    return ['notice-text'];
  }

  /** @returns {string} The notice's one-line explanation */
  get text() {
    return this.getAttribute('notice-text') || '';
  }

  /**
   * Render the message
   * @override
   */
  render() {
    const article = document.createElement('article');
    article.className = 'notice';

    // A fixed lozenge and the explanation beside it, in the type-name/summary
    // shape every other one-line item uses — so the row is the same height as
    // its neighbours and the sentence truncates rather than wrapping.
    const body = renderResultStatusMessage({ typeName: NOTICE_TYPE_NAME, summary: this.text });

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
