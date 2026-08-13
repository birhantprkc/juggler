//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Append standard Delete / Delete up to here / Delete from here buttons to a container.
 * Buttons use properties-panel-btn danger styling, matching other properties panels.
 * @param {HTMLElement} container
 * @param {import('../model/message-thread.js').default} parentThread
 * @param {number} itemIndex - index of the item in parentThread
 * @param {(e: MouseEvent) => void} onDelete - called when Delete is clicked
 */
export function appendDeleteControls(container, parentThread, itemIndex, onDelete) {
  const makeBtn = (/** @type {string} */ label) => {
    const btn = document.createElement('button');
    btn.className = 'properties-panel-btn danger';
    btn.innerHTML = `<span class="icon-trashcan"></span> ${label}`;
    return btn;
  };

  const deleteBtn = makeBtn('Delete');
  deleteBtn.addEventListener('click', (e) => onDelete(e));
  container.appendChild(deleteBtn);

  // Both span deletes go through the conversation rather than straight to the
  // thread: a span delete has to cancel pending approvals and stop the turn
  // (the items it removes may be the ones the turn is waiting on), and it is
  // what offers the footer's undo.
  if (itemIndex > 0) {
    const upBtn = makeBtn('Delete up to here');
    upBtn.addEventListener('click',
      () => parentThread.conversation.deleteUpToWithCleanup(parentThread, itemIndex));
    container.appendChild(upBtn);
  }

  const fromBtn = makeBtn('Delete from here');
  fromBtn.addEventListener('click',
    () => parentThread.conversation.deleteAfterWithCleanup(parentThread, itemIndex));
  container.appendChild(fromBtn);
}
