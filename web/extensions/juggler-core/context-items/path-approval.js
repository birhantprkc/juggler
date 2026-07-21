//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared out-of-root approval helpers for the read-family tools (read, search,
 * glob). Each is approval-gated but auto-approves any target inside the project
 * root or a granted allowed path (the common case), and prompts only for a
 * target outside those roots — offering to grant the folder rather than
 * hard-failing the model. This module centralises the containment check and the
 * folder-grant suggestion so all three tools behave identically and one folder
 * grant widens read, write, and shell access alike.
 *
 * The write tools have their own copies of the containment/grant logic in
 * edit-base.js because they additionally gate on a boolean "allow file edits"
 * toggle; reads have no such toggle (in-root reads are always allowed), so their
 * logic is simpler and lives here.
 * @module context-items/path-approval
 */

import { isPathInsideAllowedRoots, canonicalRoot } from 'juggler/utils/path-containment';

/**
 * Extract a path from a tool input, tolerating the `file_path` alias the LLM
 * commonly emits for the read tool. Returns '' when no usable path is present.
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {boolean} [allowFilePathAlias] - Also accept the `file_path` alias (read tool)
 * @returns {string} The target path, or '' if none
 */
export function toolInputPath(toolInput, allowFilePathAlias = false) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const p = toolInput.path ?? (allowFilePathAlias ? toolInput.file_path : undefined);
  return typeof p === 'string' ? p : '';
}

/**
 * Directory portion of a path, handling both `/` and `\` separators (the backend
 * reports native OS paths).
 * @param {string} p - File path
 * @returns {string} The parent directory, or '' if none
 */
export function dirname(p) {
  if (!p) return '';
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx <= 0 ? '' : trimmed.slice(0, idx);
}

/**
 * Collapse a home-dir prefix to `~` for display (cosmetic; the persisted grant
 * is the absolute path).
 * @param {string} p - Absolute path
 * @param {string} home - Backend home dir (may be empty)
 * @returns {string} `~`-collapsed display path
 */
export function tildeify(p, home) {
  if (!home) return p;
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  if (p === base) return '~';
  if (p.startsWith(base + '/')) return '~' + p.slice(base.length);
  return p;
}

/**
 * Does `path` resolve inside the project root or the user's standing
 * allowed-paths grant? A path we can't resolve is treated as out-of-root so the
 * tool prompts. Mirrors EditBase._isPathAllowed so one folder grant widens read,
 * write, and shell access identically.
 * @param {{messageThread?: any, session?: any}} item - The context-item instance
 * @param {string} path - Target path
 * @returns {boolean} True if the path is within an allowed root
 */
export function isPathAllowed(item, path) {
  if (!path) return false;
  const mt = item.messageThread;
  if (!mt) return false;
  return isPathInsideAllowedRoots(
    path,
    mt.getAllowedPaths(),
    item.session?.home || '',
    item.session?.platform || ''
  );
}

/**
 * Build the single "don't ask again" folder-grant suggestion for an out-of-root
 * target: add `grantDir` to the conversation's allowed paths — the grant that
 * actually stops future prompts here (and, since the list is shared, widens
 * shell + write access to that folder too). Only offered when `grantDir`
 * canonicalises to a grantable absolute root ({@link canonicalRoot} returns null
 * for `~`, `$`-bearing, over-broad, relative, or Windows drive paths); otherwise
 * the user still gets a one-shot Yes / No and the caller returns `[]`.
 * @param {string} grantDir - Directory to grant (a read's parent folder, or a search/glob search dir)
 * @param {string} home - Backend home dir, for `~` display + guard
 * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions (0 or 1)
 */
export function folderGrantSuggestions(grantDir, home) {
  const folder = canonicalRoot(grantDir, home);
  if (!folder) return [];
  return [{
    allowedPaths: [folder],
    label: `allow ${tildeify(folder, home)}`
  }];
}

/**
 * Strip the framework-only escape-hatch flags a model must never be able to set
 * from its raw tool arguments. `outOfRootApproved` (the backend's out-of-scope
 * admit flag) and `userInitiated` (the user-pin containment bypass) are added by
 * the JS execution path ALONE — and only after the approval gate has run. Since
 * every read/search/glob item normalizes LLM input through here before it reaches
 * `execute`, deleting these keeps the backend's "set only on the modal-approved
 * execution path" contract intact: a model that injects either flag into its tool
 * call can never smuggle it through to the backend to widen its own filesystem
 * reach. Mutates and returns `params`.
 * @param {Record<string, unknown>} params - Normalized tool params (mutated in place)
 * @returns {Record<string, unknown>} The same object, without the escape-hatch flags
 */
export function stripInjectedApprovalFlags(params) {
  if (params && typeof params === 'object') {
    delete params.outOfRootApproved;
    delete params.userInitiated;
  }
  return params;
}
