//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Native window title — names the OS window after the session (project) it
 * views. The macOS "Window" menu lists open windows by their NSWindow title,
 * and Windows/Linux taskbars and window switchers list them by the same native
 * title; without this every window reads "Juggler" and they're
 * indistinguishable.
 *
 * Like theme/control, this drives the *native window* hosting the page (the
 * desktop app's loopback endpoint via nativeCtl), so it's gated on window-mode:
 * remote browser tabs and the engine page have no host process to title and
 * skip the call.
 * @module utils/window-title
 */

import { isDesktopWindow, postWindowControl } from '../../sdk/lib/window-control.js';

/**
 * Derive the window title from the session's project path: the app name plus
 * the project's own directory name. Only the last path component is used —
 * taskbars and window menus have little room and truncate from the end, so a
 * full path would clip away the one part that tells two windows apart. A window
 * with no project yet (freshly opened, still at the picker) gets a placeholder
 * so its entry stays meaningful.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @returns {string} The window title.
 */
export function windowTitleForProject(projectPath) {
  // Both separators: the desktop app reports native paths, so Windows projects
  // arrive backslash-separated.
  const dirName = (projectPath || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return 'Juggler - ' + (dirName || 'New Window');
}

/**
 * Push the current project to the native window host: its title (which names
 * the window in the macOS "Window" menu and in the Windows/Linux taskbar and
 * window switcher) and — crucially — the raw project path, which is the
 * window's persistent identity. Projects are chosen in-page (the picker
 * switches the server's project), so the host process only learns which project
 * a window actually views from this report; it keys per-window geometry and the
 * restore set on it. One-way and best-effort: only native windows (window-mode)
 * have a host to report to; everything else skips the call.
 * @param {string} projectPath - Absolute project path, or '' when none is set.
 * @returns {void}
 */
export function updateWindowTitle(projectPath) {
  if (!isDesktopWindow()) return;
  const title = windowTitleForProject(projectPath);
  const query = '?title=' + encodeURIComponent(title)
    + '&project=' + encodeURIComponent(projectPath || '');
  postWindowControl('title', query);
}
