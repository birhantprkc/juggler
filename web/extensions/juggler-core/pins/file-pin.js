//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinboardItemType from 'juggler/pinboard-item-type';
import { basename } from 'juggler/item-utils';
import { buildPickerPanel, createElement, injectStylesOnce } from 'juggler/ui';
import { fetchLiveFile, renderLiveFileBody } from '../lib/live-file.js';

injectStylesOnce('file-pin-styles', `
.file-pin {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}
.file-pin__note {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}
`);

/**
 * Lines shown before the preview stops. A pin is a place to keep an eye on a
 * file, not a place to read all of one — `Open` is one click away and opens the
 * editor that is actually good at it.
 */
const PREVIEW_LINES = 500;

/**
 * How long to wait for a burst of file changes to finish before re-reading. A
 * save from an editor arrives as several events, and re-reading each of them
 * would be several reads to show one file.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * Collapse a path to one spelling: no repeated separators, no `.` segments, `..`
 * resolved where it can be, no trailing separator. Purely textual — there is no
 * project root in scope here, so a relative path stays relative.
 * @param {string} path - The path as it arrived.
 * @returns {string} The normalized path, or '' when there was nothing to normalize.
 */
function normalizePathText(path) {
  const trimmed = String(path || '').trim();
  if (!trimmed) return '';
  const absolute = trimmed.startsWith('/');
  /** @type {string[]} */
  const segments = [];
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last && last !== '..') {
        segments.pop();
        continue;
      }
      // Above an absolute root there is nowhere to go; a relative path keeps the
      // `..` because only the project root can say what it means.
      if (absolute) continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  if (absolute) return `/${joined}`;
  return joined;
}

/**
 * Validate and normalize a File pin's config. Shared by the instance method the
 * host calls and the static one a source descriptor goes through, so a pin made
 * by pinning a file and a pin made from the picker are spelt the same way.
 * @param {Record<string, any>} config - The config to check.
 * @returns {{path: string, isDirectory?: boolean}|null} The normalized config, or null to reject it.
 */
function normalizeFileConfig(config) {
  const raw = typeof config?.path === 'string' ? config.path.trim() : '';
  if (!raw) return null;
  const path = normalizePathText(raw);
  if (!path) return null;
  // A trailing separator is how a completion says "directory", and it is the only
  // hint available before anything is read.
  const isDirectory = config?.isDirectory === true || (raw.length > 1 && raw.endsWith('/'));
  return isDirectory ? { path, isDirectory: true } : { path };
}

/**
 * The path to read, resolved against the open project when the config holds a
 * relative one.
 * @param {Record<string, any>} config - The pin's config.
 * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
 * @returns {string} An absolute path, or the config's path when there is no project.
 */
function absolutePath(config, active) {
  const path = config?.path || '';
  if (!path || path.startsWith('/')) return path;
  const root = (active?.project?.path || '').replace(/\/+$/, '');
  return root ? `${root}/${path}` : path;
}

/**
 * FilePin — a file kept where it can be seen.
 *
 * The board holds the path and nothing else. Every render reads what is on disk
 * now, so the pin is never stale and never carries a copy of anyone's file
 * around in session state. Pinning a file shows it; it does not put it in a
 * conversation's context, and the model never sees it.
 *
 * The read is user-initiated by construction — the user named this file — so a
 * pin may point outside the project root, the same way an `@`-mention may. That
 * is what lets a pin on a sibling repo keep working; it is also why removing the
 * pin is the way to stop reading it.
 * @class
 * @augments PinboardItemType
 */
class FilePin extends PinboardItemType {
  /** @type {import('juggler/pinboard-item-type').PinboardItemManifest} */
  static MANIFEST = {
    id: 'file',
    name: 'File',
    version: '1.0.0',
    description: 'Keeps a live file within reach',
    instances: 'multiple',
    // The one type that shows whatever the user names rather than something the
    // conversation already has, so it leads the add picker and says in the row
    // that choosing it asks a question. "View" is the load-bearing word: a pin is
    // somewhere to watch a file, and naming one here does not put it in front of
    // the agent.
    addLabel: 'Add a file to view…',
    order: -1,
  };

  /**
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {true|string} True when a project is open.
   */
  canAdd(active) {
    return active?.project?.path ? true : 'No project';
  }

  /**
   * Ask which file. The same picker the file-content item uses, so "add a file"
   * means one thing wherever it is asked.
   * @param {{active: import('juggler/pinboard-item-type').PinActiveContext, initialConfig?: Record<string, any>, signal: AbortSignal}} options - The request.
   * @returns {Promise<Record<string, any>|null>} The config, or null if cancelled.
   */
  async configure(options) {
    const overlay = document.createElement('div');
    overlay.className = 'pp-overlay';
    document.body.appendChild(overlay);

    const { element, promise, cancel } = buildPickerPanel({
      title: 'Add a file to view',
      // A folder is as pinnable as a file — a trailing slash names one, and the
      // pin shows its tree — so the prompt says both rather than only the common
      // half.
      placeholder: 'File or folder path…',
      dirsOnly: false,
      confirmLabel: 'Add',
      showCancel: true,
      // Almost every file worth watching is in the open project, and without
      // this the native chooser opens wherever the app last was.
      startDir: options.active?.project?.path || '',
    });
    overlay.appendChild(element);

    /** @param {KeyboardEvent} e - The keydown. */
    const onKeydown = (e) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    options.signal?.addEventListener('abort', () => cancel(), { once: true });

    const chosen = await promise;
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (!chosen) return null;

    // Stored absolute, so the same file pinned from the picker and from a
    // properties panel is one pin rather than two spellings of one.
    return normalizeFileConfig({
      path: absolutePath({ path: chosen }, options.active),
      isDirectory: chosen.endsWith('/'),
    });
  }

  /**
   * @param {Record<string, any>} config - The stored or supplied config.
   * @returns {Record<string, any>|null} The normalized config, or null to reject it.
   */
  normalizeConfig(config) {
    return normalizeFileConfig(config);
  }

  /**
   * Two pins name the same file when their paths do. Both configs are already
   * normalized, and both are absolute for anything this class created, so this is
   * a string comparison and deliberately nothing cleverer: resolving symlinks or
   * case-folding would need the filesystem, and `isSameConfig` is asked before
   * anything is read.
   * @param {Record<string, any>} a - One config.
   * @param {Record<string, any>} b - The other.
   * @returns {boolean} True when they name the same path.
   */
  isSameConfig(a, b) {
    return (a?.path || '') === (b?.path || '');
  }

  /**
   * The tab is named for the file; the toolbar is the path itself, which the
   * host draws along with the controls that act on it. The name above the path
   * said the same thing twice, and the tab was already saying the short half.
   * @param {Record<string, any>} config - The pin's config.
   * @param {import('juggler/pinboard-item-type').PinActiveContext} active - The active context.
   * @returns {import('juggler/pinboard-item-type').PinDescription} The tab's word and the file.
   */
  describe(config, active) {
    const path = config?.path || '';
    if (!path) return { title: this.name };
    const name = basename(path) || path;
    return {
      title: config.isDirectory ? `${name}/` : name,
      path: absolutePath(config, active),
    };
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {boolean} True for a live file.
   */
  static canPinSource(source) {
    if (source?.kind !== 'file') return false;
    // A snapshot is a different promise from the one this pin makes, and making
    // it quietly would be worse than declining it.
    if (source.presentation && source.presentation !== 'live') return false;
    return typeof source.path === 'string' && source.path.trim() !== '';
  }

  /**
   * @param {import('juggler/pinboard-item-type').PinSource} source - The source to pin.
   * @returns {Record<string, any>|null} The config, or null if the path was unusable.
   */
  static configFromSource(source) {
    return normalizeFileConfig(/** @type {Record<string, any>} */ (source));
  }

  /**
   * Show the file, and keep showing it: a change to it on disk re-reads, and so
   * does `Refresh` for the changes the watcher cannot see.
   * @param {HTMLElement} container - The body to fill.
   * @param {import('juggler/pinboard-item-type').PinContext} pinContext - The pin and its context.
   * @returns {import('juggler/pinboard-item-type').PinController} The controller.
   */
  mount(container, pinContext) {
    let context = pinContext;
    let target = absolutePath(context.pin.config, context.active);

    const body = createElement('div', 'file-pin');
    container.replaceChildren(body);

    // Only the newest read may draw: a refresh can overtake the read it replaced.
    let generation = 0;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let pending;

    const render = async () => {
      const mine = ++generation;
      const path = absolutePath(context.pin.config, context.active);
      body.replaceChildren(createElement('div', 'file-content-loading', 'Loading…'));

      const result = await fetchLiveFile(path, {
        signal: context.signal,
        head: PREVIEW_LINES,
      });
      if (mine !== generation || context.signal.aborted) return;

      renderLiveFileBody(body, result, {
        absolutePath: path,
        conversationId: context.active?.conversation?.id,
      });

      const shown = result.lineCount || 0;
      const total = result.totalLines || 0;
      if (!result.isDirectory && shown && total > shown) {
        body.appendChild(createElement('div', 'file-pin__note',
          `First ${shown} lines of ${total}.`));
      }
    };

    const refresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { void render(); }, REFRESH_DEBOUNCE_MS);
    };

    const stopWatching = context.services.files.onChange((changes) => {
      if (changes.some((change) => touches(change.path, target, context.pin.config.isDirectory === true))) {
        refresh();
      }
    });

    void render();

    return {
      update: (next) => {
        const nextTarget = absolutePath(next.pin.config, next.active);
        const conversationChanged = next.active?.conversation?.id !== context.active?.conversation?.id;
        context = next;
        if (nextTarget === target && !conversationChanged) return;
        target = nextTarget;
        void render();
      },
      teardown: () => {
        clearTimeout(pending);
        stopWatching();
      },
      // Open, copy and reveal are the host's, offered for any pin that names a
      // path — so this one is left with the only thing it knows how to do.
      getActions: () => [
        { id: 'refresh', label: 'Refresh', icon: 'refresh', primary: true, run: () => render() },
      ],
    };
  }
}

/**
 * Whether a changed path is one this pin is showing: the file itself, or anything
 * under it when the pin is a directory listing.
 * @param {string} changed - The absolute path that changed.
 * @param {string} target - The pin's absolute path.
 * @param {boolean} isDirectory - Whether the pin shows a directory.
 * @returns {boolean} True when the pin should re-read.
 */
function touches(changed, target, isDirectory) {
  if (!changed || !target) return false;
  if (changed === target) return true;
  return isDirectory && changed.startsWith(`${target}/`);
}

export default FilePin;
