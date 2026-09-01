//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { createElement, injectStylesOnce } from 'juggler/ui';
import { reconcileParts, reconcileRows, setText } from '../lib/reconcile.js';
import {
  branchPhrase,
  countsPhrase,
  divergencePhrase,
  fileCode,
  fileStatusWords,
  repoLabel,
  truncationNote,
} from '../lib/git-status.js';

injectStylesOnce('git-pin-styles', `
.git-pin {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: 100%;
}
.git-pin__quiet {
  color: var(--text-tertiary);
}
.git-pin__error {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
.git-pin__repo {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.git-pin__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
}
.git-pin__name {
  font-weight: 600;
}
.git-pin__branch {
  font-family: var(--font-mono);
}
.git-pin__meta {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
.git-pin__files {
  display: flex;
  flex-direction: column;
  margin-top: 0.25rem;
}
.git-pin__file {
  display: flex;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}
.git-pin__code {
  color: var(--text-tertiary);
  white-space: pre;
}
.git-pin__path {
  overflow-wrap: anywhere;
}
`);

/** @typedef {import('../lib/reconcile.js').PartSpec} PartSpec */

/**
 * A repository's heading line: who it is, where its HEAD is, and how far that has
 * drifted from what it tracks.
 * @param {HTMLElement} head - The heading row.
 * @param {string} root - Absolute project root, for naming the root repo.
 * @param {import('juggler/pinboard-item-type').PinGitRepo} repo - The repo to draw.
 * @param {boolean} showName - Whether to label it, false for a lone repo at the root.
 * @returns {void}
 */
function fillRepoHead(head, root, repo, showName) {
  /** @type {{cls: string, text: string}[]} */
  const spans = [];
  if (showName) spans.push({ cls: 'git-pin__name', text: repoLabel(root, repo.path) });
  spans.push({ cls: 'git-pin__branch', text: branchPhrase(repo) });

  const divergence = divergencePhrase(repo);
  if (divergence) spans.push({ cls: 'git-pin__meta', text: divergence });
  else if (repo.upstream) spans.push({ cls: 'git-pin__meta', text: 'Up to date' });

  reconcileRows(
    head,
    spans,
    (span) => span.cls,
    (span) => createElement('span', span.cls),
    (el, span) => setText(el, span.text)
  );
}

/**
 * One changed file's row: its status letters, and the path they apply to.
 * @param {import('juggler/pinboard-item-type').PinGitFile} file - The file.
 * @returns {HTMLElement} The row.
 */
function buildFileRow(file) {
  const row = createElement('div', 'git-pin__file');
  row.appendChild(createElement('span', 'git-pin__code'));
  row.appendChild(createElement('span', 'git-pin__path', file.path));
  return row;
}

/**
 * A file's current status. The path is the row's key, so only the letters and the
 * words behind them can have moved.
 * @param {HTMLElement} row - The row for this path.
 * @param {import('juggler/pinboard-item-type').PinGitFile} file - The file.
 * @returns {void}
 */
function fillFileRow(row, file) {
  const code = /** @type {HTMLElement} */ (row.firstElementChild);
  setText(code, fileCode(file));
  const words = fileStatusWords(file);
  if (code.title !== words) code.title = words;
}

/**
 * One repository's block: who it is, where its HEAD is, and what has changed.
 * @param {HTMLElement} block - The block for this repo.
 * @param {string} root - Absolute project root, for naming the root repo.
 * @param {import('juggler/pinboard-item-type').PinGitRepo} repo - The repo to draw.
 * @param {boolean} showName - Whether to label it, false for a lone repo at the root.
 * @returns {void}
 */
function fillRepoBlock(block, root, repo, showName) {
  /** @type {PartSpec[]} */
  const parts = [{
    key: 'head',
    build: () => createElement('div', 'git-pin__head'),
    fill: (el) => fillRepoHead(el, root, repo, showName),
  }];

  const counts = countsPhrase(repo);
  if (!counts) {
    parts.push({
      key: 'quiet',
      build: () => createElement('div', 'git-pin__quiet'),
      fill: (el) => setText(el, 'Nothing changed.'),
    });
  } else {
    parts.push({
      key: 'counts',
      build: () => createElement('div', 'git-pin__meta'),
      fill: (el) => setText(el, counts),
    });
    parts.push({
      key: 'files',
      build: () => createElement('div', 'git-pin__files'),
      // A poll every few seconds over a tree of a few hundred changed files is
      // where this pin's cost lives, and almost none of it differs from the poll
      // before.
      fill: (el) => reconcileRows(el, repo.files || [], (file) => file.path, buildFileRow, fillFileRow),
    });
    const note = truncationNote(repo);
    if (note) {
      parts.push({
        key: 'note',
        build: () => createElement('div', 'git-pin__meta'),
        fill: (el) => setText(el, note),
      });
    }
  }
  reconcileParts(block, parts);
}

/**
 * GitPin — the project's working tree, in the space to read it in.
 *
 * The info card beside it answers "is there anything uncommitted"; this answers
 * "what", which is why it is worth the room: the branch, how far it has drifted
 * from what it tracks, and the files themselves. Nested repositories and
 * submodules each get their own block, because a count summed across them would
 * belong to no repository at all.
 *
 * Nothing here is attributed to Juggler. These are the working tree's changes
 * whoever made them, and a board that quietly implied otherwise would be wrong
 * most of the time — the Changed files pin is the one making that claim, and it
 * makes it from the transcript rather than from git.
 *
 * The status is a poll, not a watch: the file watcher never reports anything
 * under `.git`, so `Refresh` is how the user asks again and the pin never polls
 * on its own — the host's one poll is shared with the card.
 * @class
 * @augments PinboardItemType
 */
class GitPin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'git',
    name: 'Git',
    version: '1.0.0',
    description: "Shows the project's working tree, branch and changed files",
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when there is a project whose tree to read.
   */
  canAdd(active) {
    return active?.project?.path ? true : 'No project';
  }

  /**
   * The title alone. `describe` is called during layout and may not do work, so
   * it cannot read the status — the branch and the counts are in the body, which
   * has the service.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's words.
   */
  describe() {
    return { title: this.name };
  }

  /**
   * The Git status info card offers to open this, and asks the registry rather
   * than naming this class.
   * @param {import('juggler/pinboard-item-type').PinSource} source - What the user asked to pin.
   * @returns {boolean} True for the git working tree.
   */
  static canPinSource(source) {
    return source?.kind === 'git';
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - What the user asked to pin.
   * @returns {Record<string, any>|null} The config, which for a singleton is empty.
   */
  static configFromSource(source) {
    return GitPin.canPinSource(source) ? {} : null;
  }

  /**
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    const body = createElement('div', 'git-pin');
    container.replaceChildren(body);

    const render = () => {
      const status = context.services.git.status();
      const error = context.services.git.error();

      if (!status) {
        // Nothing read yet is not the same as no repository, and saying the
        // wrong one of those is worse than saying neither.
        const parts = [createElement('div', 'git-pin__quiet', 'Checking…')];
        if (error) parts.push(createElement('div', 'git-pin__error', `Couldn't read git status. ${error}`));
        body.replaceChildren(...parts);
        return;
      }

      const repos = status.repos || [];
      if (!repos.length) {
        body.replaceChildren(createElement('div', 'git-pin__quiet', 'No git repository.'));
        return;
      }

      // Only a lone repo at the project root goes unnamed; anything else is one
      // of several, and an unlabelled block would not say which.
      const showNames = !(repos.length === 1 && !repos[0]?.path);
      /** @type {PartSpec[]} */
      const parts = repos.map((repo) => ({
        key: `repo:${repo.path || ''}`,
        build: () => createElement('div', 'git-pin__repo'),
        fill: (/** @type {HTMLElement} */ el) => fillRepoBlock(el, status.root, repo, showNames),
      }));
      // A failed refresh keeps the last good status on screen and says so
      // underneath: blanking the panel loses more than the staleness costs.
      if (error) {
        parts.push({
          key: 'error',
          build: () => createElement('div', 'git-pin__error'),
          fill: (el) => setText(el, `Couldn't refresh. ${error}`),
        });
      }
      reconcileParts(body, parts);
    };

    const stopWatching = context.services.git.onChange(render);
    render();
    void context.services.git.refresh();

    return {
      update: (next) => {
        context = next;
        render();
      },
      teardown: () => stopWatching(),
      getActions: () => [
        {
          id: 'refresh',
          label: 'Refresh',
          icon: 'refresh',
          primary: true,
          run: () => context.services.git.refresh(),
        },
      ],
    };
  }
}

export default GitPin;
