//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Append standard Delete / Delete up to here / Delete from here buttons to a container.
 * Buttons use properties-panel-btn danger styling, matching other properties panels.
 * The span deletes resolve the item to an index when they are CLICKED, not when
 * they are built. A properties panel is not rebuilt for changes to items other
 * than the one it describes, and the worker reorders items on its own
 * initiative (a tool action moves to the end of the list when its context item
 * changes), so an index captured at build time goes stale while these buttons
 * sit on screen — and a stale index deletes a row the user never pointed at.
 * @param {HTMLElement} container
 * @param {import('../model/message-thread.js').default} parentThread
 * @param {string} itemId - id of the item in parentThread these buttons act on
 * @param {(e: MouseEvent) => void} onDelete - called when Delete is clicked
 */
export function appendDeleteControls(container, parentThread, itemId, onDelete) {
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
  if (parentThread.findIndexByItemId(itemId) > 0) {
    const upBtn = makeBtn('Delete up to here');
    upBtn.addEventListener('click', () => {
      const index = parentThread.findIndexByItemId(itemId);
      if (index > 0) parentThread.conversation.deleteUpToWithCleanup(parentThread, index);
    });
    container.appendChild(upBtn);
  }

  const fromBtn = makeBtn('Delete from here');
  fromBtn.addEventListener('click', () => {
    const index = parentThread.findIndexByItemId(itemId);
    if (index >= 0) parentThread.conversation.deleteAfterWithCleanup(parentThread, index);
  });
  container.appendChild(fromBtn);
}
