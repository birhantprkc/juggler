//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git status info card — a quiet, live summary of the project's working-tree
 * state. When there's a single repo at the project root the line is just the
 * counts. With multiple repos, or a repo below the root, each line is prefixed
 * with the repo's location (the root repo by the project folder name, nested
 * repos by their relative path).
 *
 * One info-card plugin of the `@juggler/core` extension; the host rail owns the
 * outer card chrome (eyebrow + × close), so this only fills the content region.
 * The latest snapshot is cached at module scope so a remount paints instantly
 * before the next poll returns. Not an ARIA live region — the counts change
 * quietly and the same information is available from git directly.
 * @module extensions/juggler-core/cards/git-status-card
 */

import InfoCardType from 'juggler/info-card-type';
import api from '../../../js/services/api.js';

/**
 * Re-poll the working-tree status this often (ms), and only while the window is
 * focused. This is a passive background card, so it stays deliberately lazy —
 * infrequent, and never running git while the user is off in their own git
 * client (see the focus gate in {@link GitStatusCard#mount}).
 */
const REFRESH_MS = 20000;

/**
 * Last status snapshot, shared across (re)mounts. `null` means "not fetched yet"
 * so the first paint shows a neutral checking state rather than a false "no repo".
 * @type {{root: string, repos: import('../../../js/services/api.js').GitRepoStatus[]}|null}
 */
let lastSnapshot = null;

/**
 * Human label for a repo: nested repos by their relative path, the root repo by
 * the project folder's name (a bare "." would be cryptic).
 * @param {string} root - Absolute project root path.
 * @param {string} repoPath - Repo path relative to root ("" for the root repo).
 * @returns {string} A short location label.
 */
function repoLabel(root, repoPath) {
  if (repoPath) return repoPath;
  const base = (root || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base || 'repo';
}

/**
 * Compose the minimal counts phrase, omitting a zero side entirely.
 * @param {import('../../../js/services/api.js').GitRepoStatus} repo
 * @returns {string} e.g. "2 changed, 1 staged", "1 staged".
 */
function countsPhrase(repo) {
  const parts = [];
  if (repo.changed > 0) parts.push(`${repo.changed} changed`);
  if (repo.staged > 0) parts.push(`${repo.staged} staged`);
  return parts.join(', ');
}

/**
 * Make a body-styled line element. Used for the whole-card status messages
 * ("Checking…", "No changed files"), not the per-repo rows.
 * @param {string} text
 * @returns {HTMLParagraphElement} The populated line element.
 */
function line(text) {
  const p = document.createElement('p');
  p.className = 'info-card__body';
  p.textContent = text;
  return p;
}

/**
 * Make a per-repo status row: an optional subtle name badge followed by the
 * monospaced counts phrase. When `name` is null (the lone-repo-at-root case)
 * the row is just the counts, still in the mono face for a consistent read.
 * @param {string|null} name - Repo location label, or null to omit the badge.
 * @param {string} counts - The counts phrase (e.g. "2 changed, 1 staged").
 * @returns {HTMLDivElement} The populated row element.
 */
function repoLine(name, counts) {
  const row = document.createElement('div');
  row.className = 'info-card__git-line';
  if (name) {
    const badge = document.createElement('span');
    badge.className = 'info-card__git-repo';
    badge.textContent = name;
    row.appendChild(badge);
  }
  const countsEl = document.createElement('span');
  countsEl.className = 'info-card__git-counts';
  countsEl.textContent = counts;
  row.appendChild(countsEl);
  return row;
}

/**
 * Render the current snapshot into the content region.
 * @param {HTMLElement} contentEl
 * @returns {void}
 */
function render(contentEl) {
  const snap = lastSnapshot;
  if (snap === null) {
    contentEl.replaceChildren(line('Checking…'));
    return;
  }
  const repos = snap.repos || [];
  if (repos.length === 0) {
    contentEl.replaceChildren(line('No git repository'));
    return;
  }
  const dirty = repos.filter((r) => r.changed > 0 || r.staged > 0);
  if (dirty.length === 0) {
    contentEl.replaceChildren(line('No changed files'));
    return;
  }
  // Only the lone-repo-at-root case hides its location; anything else labels.
  const showLabels = !(repos.length === 1 && !repos[0]?.path);
  const nodes = dirty.map((r) => {
    const counts = countsPhrase(r);
    return repoLine(showLabels ? repoLabel(snap.root, r.path) : null, counts);
  });
  contentEl.replaceChildren(...nodes);
}

/**
 * The Git status info card.
 */
export default class GitStatusCard extends InfoCardType {
  /** @type {import('juggler/info-card-type').InfoCardManifest} */
  static MANIFEST = {
    id: 'git-status',
    name: 'Git status',
    version: '1.0.0',
    description: "Show a summary of your project's git working tree in the sidebar.",
    eyebrow: 'Git status',
    priority: 10,
  };

  /** @returns {boolean} Always renderable (it reports its own state). */
  hasContent() {
    return true;
  }

  /**
   * Paint the cached snapshot immediately, then poll the server on an interval,
   * refreshing the counts in place.
   * @param {HTMLElement} contentEl
   * @returns {() => void} Teardown that stops polling.
   */
  mount(contentEl) {
    let disposed = false;
    let inFlight = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    // Never run git while Juggler is unfocused: a background `git status` poll
    // fighting the user's own git client is worse than a slightly stale card.
    // (We still pass --no-optional-locks server-side, but not polling at all
    // while they're elsewhere is the real fix.) We refresh at once on refocus.
    const focused = () => typeof document === 'undefined' || document.hasFocus();

    const refresh = async () => {
      // Skip if a poll is still outstanding (so a slow response can't stack up
      // overlapping fetches), if torn down, or if the window isn't focused.
      if (inFlight || disposed || !focused()) return;
      inFlight = true;
      try {
        const data = await api.getGitStatus();
        if (disposed) return;
        lastSnapshot = {
          root: (data && data.root) || '',
          repos: data && Array.isArray(data.repos) ? data.repos : [],
        };
      } catch {
        // Transient failure: keep the last good snapshot (and keep polling). If
        // we never got one, stay in the neutral checking state rather than
        // flashing a misleading "no repository".
        if (disposed || lastSnapshot === null) return;
      } finally {
        inFlight = false;
      }
      render(contentEl);
    };

    // Regaining focus refreshes at once, so the card is current the moment the
    // user looks back at Juggler rather than up to REFRESH_MS stale.
    const onFocus = () => { refresh(); };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

    render(contentEl);
    refresh();
    timer = setInterval(refresh, REFRESH_MS);

    return () => {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  }
}
