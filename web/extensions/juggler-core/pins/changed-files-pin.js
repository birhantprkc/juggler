//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { basename, formatDisplayPath } from 'juggler/item-utils';
import { createElement, createFileActions, injectStylesOnce } from 'juggler/ui';
import { reconcileRows, setText } from '../lib/reconcile.js';
import { pinEmpty } from '../lib/pin-empty.js';

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
  gap: 0.375rem;
  min-height: 0;
  overflow: auto;
}
.changed-files-pin__file {
  /* A card is a flex item in a bounded column, so it would otherwise give up its
     own height to fit its siblings — and it clips, so every card but the last
     would quietly lose its bottom instead of the list scrolling. */
  flex-shrink: 0;
  border: 0.0625rem solid transparent;
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  overflow: hidden;
}
.changed-files-pin__file.is-open {
  border-color: var(--border-color, transparent);
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
}
.changed-files-pin__row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.changed-files-pin__row:hover {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
}
.changed-files-pin__row:focus-visible {
  outline: 0.125rem solid var(--accent-blue);
  outline-offset: -0.125rem;
}
.changed-files-pin__caret {
  flex-shrink: 0;
  width: 0.4375rem;
  height: 0.4375rem;
  margin-top: 0.375rem;
  background: var(--text-tertiary);
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  transition: transform var(--transition-base, 0.15s ease);
}
.changed-files-pin__row[aria-expanded="true"] .changed-files-pin__caret {
  transform: rotate(90deg);
}
.changed-files-pin__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.1875rem;
  min-width: 0;
}
.changed-files-pin__name {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.changed-files-pin__meta {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
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
.changed-files-pin__diff {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0 0.625rem 0.625rem;
}
.changed-files-pin__diff diff-viewer {
  max-height: 40rem;
  border-radius: 0.375rem;
  box-shadow: none;
}
.changed-files-pin__diff-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.changed-files-pin__reveal {
  border: none;
  background: transparent;
  color: var(--accent-blue);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  padding: 0.125rem 0.25rem;
}
.changed-files-pin__reveal:hover {
  text-decoration: underline;
}
.changed-files-pin__undrawn,
.changed-files-pin__note {
  color: var(--text-tertiary);
}
.changed-files-pin__undrawn {
  padding: 0.25rem 0 0.125rem;
  font-size: var(--font-size-sm);
}
.changed-files-pin__note {
  flex-shrink: 0;
  margin-top: auto;
  padding-top: 0.25rem;
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
`);

/** The tools whose completed actions mean a file was changed. */
const MUTATION_TOOLS = ['write', 'edit'];

/** How many edits to read before grouping. Enough for any real conversation. */
const EDIT_LIMIT = 500;

/**
 * The largest diff worth attempting here, as cells of the table the line diff
 * builds: it allocates one row per line of the old file and one column per line
 * of the new, and computes it on the click, in the only thread there is. Two
 * two-thousand-line files are about the point where that stops being instant, and
 * a board that stopped answering would be a worse outcome than not drawing.
 */
const DIFF_CELL_BUDGET = 4_000_000;

/**
 * @typedef {object} ChangedFile
 * @property {string} path - The file.
 * @property {number} edits - How many times it was changed.
 * @property {number} added - Lines added across them.
 * @property {number} removed - Lines removed across them.
 * @property {string} itemId - The most recent change to it.
 * @property {string} firstItemId - The earliest change to it in this conversation.
 */

/**
 * One row per file, newest first, from the flat list of edits. A file edited
 * five times is one thing the user changed, not five — but how many times is
 * worth knowing, so it is counted rather than collapsed away.
 *
 * Both ends are kept, because they are the two different questions a row is
 * asked. The newest edit is where the conversation last touched the file, and is
 * what revealing goes to; the oldest is where this conversation found it, and is
 * the only "before" that makes the diff mean what the pin's title says.
 * @param {import('juggler/pinboard-item-type').PinFileEdit[]} edits - The edits, newest first.
 * @returns {ChangedFile[]} One entry per path.
 */
function groupByPath(edits) {
  /** @type {Map<string, ChangedFile>} */
  const byPath = new Map();
  for (const edit of edits) {
    const existing = byPath.get(edit.path);
    if (existing) {
      existing.edits++;
      existing.added += edit.added;
      existing.removed += edit.removed;
      // Still walking backwards through the file's history, so whichever edit is
      // seen last is the earliest one there is.
      existing.firstItemId = edit.itemId;
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
      firstItemId: edit.itemId,
    });
  }
  return [...byPath.values()];
}

/**
 * How many lines a file has, without cutting it into them. The count decides
 * whether the file is too big to diff, so building an array of every line to find
 * that out would be doing the thing the count exists to avoid.
 * @param {string} text - The file.
 * @returns {number} Its line count.
 */
function lineCount(text) {
  if (!text) return 0;
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
  return lines;
}

/**
 * What one file's changes came to, drawn as a unified diff: the file as this
 * conversation first found it against the file as it last left it. The states it
 * passed through in between are the transcript's to tell — this answers the
 * question the pin's title asks, and answers it once however many edits it took.
 *
 * Two cases never reach the viewer, because it draws two empty strings as "No
 * changes" and that would be the opposite of true on a row that is only here
 * because something changed: a change whose before and after were never recorded,
 * and a file too large to diff without stalling the board. Both say which.
 * @param {ChangedFile} entry - The file.
 * @param {import('juggler/pinboard-item-type').PinFileEditsService} fileEdits - The host's edits service.
 * @returns {HTMLElement} The diff, or the reason there is none.
 */
function diffBody(entry, fileEdits) {
  const before = fileEdits.snapshot(entry.firstItemId);
  const after = entry.itemId === entry.firstItemId ? before : fileEdits.snapshot(entry.itemId);
  if (!before || !after) {
    return createElement('div', 'changed-files-pin__undrawn',
      "The before and after weren't recorded for this change.");
  }

  if ((lineCount(before.oldContent) + 1) * (lineCount(after.newContent) + 1) > DIFF_CELL_BUDGET) {
    return createElement('div', 'changed-files-pin__undrawn',
      'This file is too large to diff here.');
  }

  const viewer = /** @type {any} */ (document.createElement('diff-viewer'));
  viewer.setDiff(before.oldContent, after.newContent, entry.path);
  return viewer;
}

/**
 * The panel under an open row, brought up to date. Rebuilt only when the pair of
 * edits it spans changes: a turn under way says the conversation moved several
 * times a second, and recomputing an unchanged diff on each would cost the
 * reader their scroll position as well as the work.
 * @param {HTMLElement} panel - The open row's panel.
 * @param {ChangedFile} entry - The file.
 * @param {import('juggler/pinboard-item-type').PinFileEditsService} fileEdits - The host's edits service.
 * @returns {void}
 */
function fillDiffPanel(panel, entry, fileEdits) {
  if (panel.dataset.from === entry.firstItemId && panel.dataset.to === entry.itemId) return;
  panel.dataset.from = entry.firstItemId;
  panel.dataset.to = entry.itemId;

  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'changed-files-pin__reveal';
  reveal.textContent = 'Reveal in conversation';
  reveal.setAttribute('aria-label', `Reveal the last change to ${entry.path}`);
  // Reading the id off the panel rather than closing over it: a file edited again
  // while its diff is open must reveal the new edit, not the one it opened on.
  reveal.addEventListener('click', () => fileEdits.reveal(panel.dataset.to || ''));

  const bar = createElement('div', 'changed-files-pin__diff-bar');
  // The shared group, not a local imitation of it: opening a file, copying its
  // path and revealing it where it lives mean the same thing here as on every
  // other surface that shows a path, and "reveal" already has one meaning per
  // platform that this pin has no business restating.
  const fileActions = createFileActions(entry.path, { pin: entry.path });
  if (fileActions) bar.appendChild(fileActions);
  bar.appendChild(reveal);
  // The bar is outside the body on purpose: where the pin cannot draw what
  // happened, the conversation can still show it, so the way there survives
  // exactly the case that needs it.
  panel.replaceChildren(bar, diffBody(entry, fileEdits));
}

/**
 * One file's row, in the part of it that is fixed for as long as the row stands
 * for that file: the name, the directory, and the click that opens it.
 *
 * The row is keyed by path, so the words derived from the path are written here
 * and never again — and the path is the one thing about a row that cannot change,
 * which is why the toggle may close over it. What the row opens onto is a sibling
 * of the button rather than a child: a diff inside a button would be a control
 * nobody could select text in.
 *
 * The name has a line to itself and everything measured about the file sits under
 * it. A pinboard column is narrow, and on one line the directory has to give up
 * its width to the tallies the moment there are any — so the name that identifies
 * the row is the thing that ends up elided.
 * @param {ChangedFile} entry - The file.
 * @param {(path: string) => void} toggle - Open or close this file's diff.
 * @returns {HTMLElement} The row.
 */
function fileRow(entry, toggle) {
  const file = createElement('div', 'changed-files-pin__file');

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'changed-files-pin__row';
  row.setAttribute('aria-label', `Show what changed in ${entry.path}`);
  row.setAttribute('aria-expanded', 'false');
  // The app's right-click menu offers Open, Reveal and Copy path to anything
  // naming a file, so a row that is not open is still a row you can act on.
  row.dataset.filePath = entry.path;

  // Drawn rather than written: a glyph would be at the mercy of whichever font
  // the platform has, and this one only ever has to be a triangle that turns.
  const caret = createElement('span', 'changed-files-pin__caret');
  caret.setAttribute('aria-hidden', 'true');
  row.appendChild(caret);

  const text = createElement('span', 'changed-files-pin__text');
  text.appendChild(createElement('span', 'changed-files-pin__name', basename(entry.path)));
  const meta = createElement('span', 'changed-files-pin__meta');
  meta.appendChild(createElement('span', 'changed-files-pin__dir', formatDisplayPath(entry.path)));
  text.appendChild(meta);
  row.appendChild(text);

  row.addEventListener('click', () => toggle(entry.path));
  file.appendChild(row);
  return file;
}

/**
 * Write one file's current tallies into its row — how many edits, and how much
 * they came to — and put its diff under it, or take it away.
 *
 * The diff is read here rather than at build time because it is the expensive
 * thing on the board: a snapshot is the file twice over, so it is fetched for a
 * row somebody opened and never for a row merely drawn.
 * @param {HTMLElement} file - The row for this path.
 * @param {ChangedFile} entry - The file.
 * @param {(path: string) => boolean} isOpen - Whether this file's diff is showing.
 * @param {import('juggler/pinboard-item-type').PinFileEditsService} fileEdits - The host's edits service.
 * @returns {void}
 */
function fillFileRow(file, entry, isOpen, fileEdits) {
  const row = /** @type {HTMLElement} */ (file.querySelector('.changed-files-pin__row'));
  const meta = /** @type {HTMLElement} */ (file.querySelector('.changed-files-pin__meta'));
  const open = isOpen(entry.path);
  row.setAttribute('aria-expanded', open ? 'true' : 'false');
  file.classList.toggle('is-open', open);

  let panel = /** @type {HTMLElement|null} */ (file.querySelector('.changed-files-pin__diff'));
  if (!open) {
    // Closing is how the two files are let go: nothing else was holding them.
    panel?.remove();
  } else {
    if (!panel) {
      panel = createElement('div', 'changed-files-pin__diff');
      file.appendChild(panel);
    }
    fillDiffPanel(panel, entry, fileEdits);
  }

  const stat = meta.querySelector('.changed-files-pin__stat');
  const count = meta.querySelector('.changed-files-pin__count');
  if (entry.edits > 1) {
    const text = `×${entry.edits}`;
    // The count sits between the directory and the diffstat, so a count arriving
    // after a diffstat goes in front of it rather than on the end.
    if (count) setText(/** @type {HTMLElement} */ (count), text);
    else meta.insertBefore(createElement('span', 'changed-files-pin__count', text), stat);
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
      meta.appendChild(fresh);
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
 * Read-only. Opening a row shows what the conversation did to that file as one
 * unified diff — its state before the first edit against its state after the
 * last, however many edits that took — and offers the way back to the action
 * that made the most recent one, where the approval and the reasoning live.
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
    order: 30,
    defaultPin: true,
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

    // Which files are showing their diff, kept by path rather than by row. The
    // conversation moves several times a second while a turn runs and every one
    // of those is a re-render; a panel that lived on the element would survive
    // that, but a file whose row is momentarily gone — reordered past the limit,
    // say — would come back closed.
    /** @type {Set<string>} */
    const open = new Set();

    /**
     * @param {string} path - The file whose diff to open or close.
     * @returns {void}
     */
    const toggle = (path) => {
      if (!open.delete(path)) open.add(path);
      render();
    };

    const render = () => {
      const edits = context.services.fileEdits.list({ tools: MUTATION_TOOLS, limit: EDIT_LIMIT });
      const files = groupByPath(edits);

      // One row per path, matched to the row that path already had. A write
      // lands on one file, and rebuilding the other forty to say so is the cost
      // this avoids.
      reconcileRows(
        list,
        files,
        (entry) => entry.path,
        (entry) => fileRow(entry, toggle),
        (row, entry) => fillFileRow(row, entry, (path) => open.has(path), context.services.fileEdits)
      );

      // The body is the list — or a centred line saying what will appear in its
      // place — with the note beneath either. The note stays on an empty card
      // especially: an unqualified empty list is the one reading this pin must
      // never invite. Both elements outlive a render, so they are only swapped
      // when the list crosses between empty and not.
      const lead = files.length
        ? list
        : (body.querySelector('.pin-empty')
          || pinEmpty('Files changed in this conversation appear here.'));
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
