//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Edit-family plugins' permission-controls UI fragment.
 * @module juggler-core/context-items/edit/permission-section
 */

import {
  WRITE_FILE_ITEM_TYPE as ITEM_TYPE,
  isFileEditingAllowed,
  toggleFileEditing,
} from '../../../../js/services/file-editing-permission.js';

/**
 * @param {import('../../../../js/model/message-thread.js').MessageThread} messageThread Owning thread
 * @returns {{id: string, element: HTMLElement, dispose: () => void}} Permission section
 */
export function renderWriteFilePermissionSection(messageThread) {
  const section = document.createElement('section');
  section.className = 'permission-section permission-section-write-file';
  section.dataset.itemType = ITEM_TYPE;

  /** Render the toggle. Edit permission is intentionally scoped to this tab only. */
  function render() {
    const allowed = isFileEditingAllowed(messageThread);
    section.innerHTML = `
      <button class="permission-btn input-ctrl-btn write-file-btn ${allowed ? 'allowed' : 'ask'}"
              role="switch" aria-checked="${allowed}"
              title="Toggle file write permission for this tab. Writes outside the project and allowed paths always prompt." data-shortcut-id="toggle-file-editing">
        ${allowed ? 'File editing allowed in allowed paths' : 'Ask before editing files'}
      </button>
    `;
    const btn = section.querySelector('.write-file-btn');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFileEditing(messageThread); });
  }

  /** @param {any} event */
  const observer = (event) => {
    if (event.keysChanged.has('permissionRules') || event.keysChanged.has('conversationPermissionRules')) render();
  };
  messageThread.conversation.observeMetadata(observer);

  render();
  return {
    id: ITEM_TYPE,
    element: section,
    dispose: () => {
      messageThread.conversation.unobserveMetadata(observer);
    }
  };
}
