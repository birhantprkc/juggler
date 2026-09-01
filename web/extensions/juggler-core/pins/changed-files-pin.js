//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { basename, formatDisplayPath } from 'juggler/item-utils';
import { createElement, injectStylesOnce } from 'juggler/ui';
import { reconcileRows, setText } from '../lib/reconcile.js';

injectStylesOnce('changed-files-pin-styles', `
.changed-files-pin {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  height: 100%;
}
.changed-files-pin__list {
  display: flex;
  flex-direction: column;
}
.changed-files-pin__row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  padding: 0.25rem;
  border: none;
  border-radius: var(--radius-md, 0.25rem);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.changed-files-pin__row:hover {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
.changed-files-pin__row:focus-visible {
  outline: 0.125rem solid var(--accent-blue);
  outline-offset: 0.125rem;
}
.changed-files-pin__name {
  overflow-wrap: anywhere;
}
.changed-files-pin__dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.changed-files-pin__count,
.changed-files-pin__stat {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}
.changed-files-pin__count {
  color: var(--text-tertiary);
}
.changed-files-pin__added {
  color: var(--success-color, var(--text-secondary));
}
.changed-files-pin__removed {
  color: var(--error-color, var(--text-secondary));
}
.changed-files-pin__empty,
.changed-files-pin__note {
  color: var(--text-tertiary);
}
.changed-files-pin__note {
  margin-top: auto;
  font-size: var(--font-size-sm);
}
`);

/** The tools whose completed actions mean a file was changed. */
const MUTATION_TOOLS = ['write', 'edit'];

/** How many edits to read before grouping. Enough for any real conversation. */
const EDIT_LIMIT = 500;

/**
 * One row per file, newest first, from the flat list of edits. A file edited
 * five times is one thing the user changed, not five — but how many times is
 * worth knowing, so it is counted rather than collapsed away.
 * @param {import('juggler/pinboard-item-type').PinFileEdit[]} edits - The edits, newest first.
 * @returns {{path: string, edits: number, added: number, removed: number, itemId: string}[]} One entry per path.
 */
function groupByPath(edits) {
  /** @type {Map<string, {path: string, edits: number, added: number, removed: number, itemId: string}>} */
  const byPath = new Map();
  for (const edit of edits) {
    const existing = byPath.get(edit.path);
    if (existing) {
      existing.edits++;
      existing.added += edit.added;
      existing.removed += edit.removed;
      continue;
    }
    // The list arrives newest first, so the first edit seen for a path is its
    // most recent — which is the one worth revealing.
    byPath.set(edit.path, {
      path: edit.path,
      edits: 1,
      added: edit.added,
      removed: edit.removed,
      itemId: edit.itemId,
    });
  }
  return [...byPath.values()];
}

/**
 * One file's row, in the part of it that is fixed for as long as the row stands
 * for that file: the name, the directory, and the click that goes to the change.
 *
 * The row is keyed by path, so the words derived from the path are written here
 * and never again. The item to reveal is not fixed — editing the file again gives
 * the path a newer action — so it is carried on the row and read at click time
 * rather than closed over, which would pin the row to the change it was built
 * for.
 * @param {{path: string, edits: number, added: number, removed: number, itemId: string}} entry - The file.
 * @param {(itemId: string) => void} reveal - What clicking it does.
 * @returns {HTMLElement} The row.
 */
function fileRow(entry, reveal) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'changed-files-pin__row';
  row.setAttribute('aria-label', `Reveal the last change to ${entry.path}`);

  row.appendChild(createElement('span', 'changed-files-pin__name', basename(entry.path)));
  row.appendChild(createElement('span', 'changed-files-pin__dir', formatDisplayPath(entry.path)));

  row.addEventListener('click', () => reveal(row.dataset.itemId || ''));
  return row;
}

/**
 * Write one file's current tallies into its row: which change to reveal, how many
 * edits, and how much they came to.
 * @param {HTMLElement} row - The row for this path.
 * @param {{path: string, edits: number, added: number, removed: number, itemId: string}} entry - The file.
 * @returns {void}
 */
function fillFileRow(row, entry) {
  if (row.dataset.itemId !== entry.itemId) row.dataset.itemId = entry.itemId;

  const stat = row.querySelector('.changed-files-pin__stat');
  const count = row.querySelector('.changed-files-pin__count');
  if (entry.edits > 1) {
    const text = `×${entry.edits}`;
    // The count sits between the directory and the diffstat, so a count arriving
    // after a diffstat goes in front of it rather than on the end.
    if (count) setText(/** @type {HTMLElement} */ (count), text);
    else row.insertBefore(createElement('span', 'changed-files-pin__count', text), stat);
  } else if (count) {
    count.remove();
  }

  // A tool that skipped its diffstat reports nothing rather than zero, and a
  // silent "+0 -0" would read as "changed nothing at all".
  if (entry.added || entry.removed) {
    if (stat) {
      setText(/** @type {HTMLElement} */ (stat.querySelector('.changed-files-pin__added')), `+${entry.added}`);
      setText(/** @type {HTMLElement} */ (stat.querySelector('.changed-files-pin__removed')), `-${entry.removed}`);
    } else {
      const fresh = createElement('span', 'changed-files-pin__stat');
      fresh.appendChild(createElement('span', 'changed-files-pin__added', `+${entry.added}`));
      fresh.appendChild(document.createTextNode(' '));
      fresh.appendChild(createElement('span', 'changed-files-pin__removed', `-${entry.removed}`));
      row.appendChild(fresh);
    }
  } else if (stat) {
    stat.remove();
  }
}

/**
 * ChangedFilesPin — what this conversation's tools have changed on disk.
 *
 * Read from the transcript, not from a ledger kept beside one: every row is a
 * `write` or `edit` tool action that completed and succeeded, so the list is
 * exactly as durable as the conversation and cannot drift from it. Nothing has to
 * be retained or reset, and it survives a restart because the transcript does.
 *
 * It is deliberately **not** a list of what changed. A shell command can rewrite
 * half the tree and nothing here will know: a bare filesystem write carries no
 * author, and inferring one from the watcher or from git would mean attributing
 * the user's own edits to the assistant. So the pin says which question it is
 * answering, and the Git pin beside it answers the other one.
 *
 * Read-only, and clicking a row goes back to the action that made the change —
 * which is where the diff, the approval and the reasoning already live.
 * @class
 * @augments PinboardItemType
 */
class ChangedFilesPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'changed-files',
    name: 'Changed files',
    version: '1.0.0',
    description: "Lists the files this conversation's tools changed",
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a conversation whose edits to list.
   */
  canAdd(active) {
    return active?.conversation ? true : 'No active conversation';
  }

  /**
   * The name, and nothing else. Which conversation this list belongs to is the
   * board's business rather than this pin's: every pin on a board reads the same
   * conversation, so naming it here would be one tab's answer to a question the
   * whole board shares — and the body already says it is this conversation's.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe() {
    return { title: this.name };
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'changed-files-pin');
    container.replaceChildren(body);

    const list = createElement('div', 'changed-files-pin__list');

    // Always present, because it is what the list means rather than a remark
    // about it: read without this, "Changed files" is a claim the pin cannot
    // make. Kept to the two limits that matter — which tools, and which
    // conversation.
    const note = createElement(
      'div',
      'changed-files-pin__note',
      'Only what the write and edit tools changed in this conversation. '
        + "A shell command's changes can't be attributed."
    );

    /**
     * @param {string} itemId - The action to go to.
     * @returns {void}
     */
    const reveal = (itemId) => context.services.fileEdits.reveal(itemId);

    const render = () => {
      const edits = context.services.fileEdits.list({ tools: MUTATION_TOOLS, limit: EDIT_LIMIT });
      const files = groupByPath(edits);

      // One row per path, matched to the row that path already had. A write
      // lands on one file, and rebuilding the other forty to say so is the cost
      // this avoids.
      reconcileRows(list, files, (entry) => entry.path, (entry) => fileRow(entry, reveal), fillFileRow);

      // The body is the list — or a word saying there is none — with the note
      // beneath it. Both outlive a render, so they are only swapped when the
      // list crosses between empty and not.
      const lead = files.length
        ? list
        : (body.querySelector('.changed-files-pin__empty')
          || createElement('div', 'changed-files-pin__empty', 'Nothing changed yet.'));
      if (body.firstChild !== lead) body.replaceChildren(lead, note);
    };

    const stopWatching = context.services.fileEdits.onChange(render);
    render();

    return {
      update: (next) => {
        context = next;
        render();
      },
      teardown: () => stopWatching(),
    };
  }
}

export default ChangedFilesPin;
