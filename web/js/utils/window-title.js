//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Native window title — names the OS window after the session (project) it
 * views. The macOS "Window" menu lists open windows by their NSWindow title;
 * without this every window reads "Juggler" and they're indistinguishable.
 *
 * Like theme/control, this drives the *native window* hosting the page (the
 * desktop app's loopback endpoint via nativeCtl), so it's gated on window-mode:
 * remote browser tabs and the engine page have no host process to title and
 * skip the call.
 * @module utils/window-title
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';

/**
 * Derive the window title from the session's project path. The path is the
 * window's identity, with the user-home prefix abbreviated to `~` for brevity.
 * A window with no project yet (freshly opened, still at the picker) gets a
 * placeholder so its menu entry stays meaningful.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @param {string} [home] - Backend user-home dir; abbreviated to `~` when it prefixes the path.
 * @returns {string} The window title.
 */
export function windowTitleForProject(projectPath, home = '') {
  if (!projectPath) return 'New Window';
  if (home && (projectPath === home || projectPath.startsWith(home + '/'))) {
    return '~' + projectPath.slice(home.length);
  }
  return projectPath;
}

/**
 * Push the current project to the native window host: its title (for the macOS
 * "Window" menu) and — crucially — the raw project path, which is the window's
 * persistent identity. Projects are chosen in-page (the picker switches the
 * server's project), so the host process only learns which project a window
 * actually views from this report; it keys per-window geometry and the restore
 * set on it. One-way and best-effort: only native windows (window-mode) have a
 * host to report to; everything else skips the call.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @param {string} [home] - Backend user-home dir for `~` abbreviation.
 * @returns {void}
 */
export function updateWindowTitle(projectPath, home = '') {
  if (document.documentElement.dataset.windowMode !== '1') return;
  const title = windowTitleForProject(projectPath, home);
  const query = '?title=' + encodeURIComponent(title)
    + '&project=' + encodeURIComponent(projectPath || '');
  const url = windowControlURL('title', query);
  if (!url) return; // no native host (browser tab) — nothing to title
  fetch(url, { method: 'POST' }).catch(() => { /* one-way; nothing to recover from */ });
}
