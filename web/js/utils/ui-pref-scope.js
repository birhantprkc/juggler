//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ui-pref-scope — who owns a viewer's zoom and theme, and where they are kept.
 *
 * Both settings answer the same question twice, so the rule lives here and
 * zoom-manager.js and theme-manager.js each apply it (the pre-paint block in
 * index.html mirrors it a third time, because it has to run before any module
 * loads).
 *
 * In a **desktop window** the setting belongs to the project: it is stored
 * server-side in the session, so reopening the project restores it even though
 * each window is a separate process on its own port with an empty localStorage.
 *
 * In a **remote browser** — a phone or laptop over the LAN or a tunnel — it
 * belongs to the device, and localStorage is the only store. The session value
 * still ranks last rather than nowhere, so a device that has never chosen one
 * opens the way the desktop is set up instead of at a stock default. What it
 * must not do is write back: one pinch on a phone would otherwise resize the
 * desktop window it dialled into, and a second remote device would fight the
 * first over a single shared value. The server refuses those writes too (see
 * localViewerOnly in cmd/juggler/server/network.go).
 * @module utils/ui-pref-scope
 */

import { windowRole, WINDOW_ROLE_MAIN } from './view-mode.js';

/**
 * Namespace a localStorage key by the loaded project, and by this window when it
 * is not the ordinary one.
 *
 * The page origin identifies a *port*, not a project: the next project's server
 * reuses the port, one process can switch project in place, and a viewer
 * arriving over the studio relay sees a single origin for every project on every
 * machine it connects to. Unnamespaced, this project would read whatever the
 * last one left behind. The server injects the key pre-paint; a no-project
 * window has none and falls back to the bare key, which is all it needs.
 *
 * A detached board is its own window with its own appearance, but localStorage
 * is shared by every document on the origin — so a board gets its role appended
 * and the Juggler shell keeps the plain key. Desktop windows read the session
 * ahead of this store anyway; what this covers is a board opened as a browser
 * tab, which has no session to write to and would otherwise share one cell with
 * the tab that opened it.
 * @param {string} base - The unscoped key, e.g. 'juggler-zoom'.
 * @returns {string} The key to read and write.
 */
export function scopedKey(base) {
  const projectKey = typeof window === 'undefined' ? null : window.__projectKey;
  const scoped = projectKey ? `${base}:${projectKey}` : base;
  const role = windowRole();
  return role === WINDOW_ROLE_MAIN ? scoped : `${scoped}@${role}`;
}

/**
 * Resolve which stored value a freshly-opened page should adopt.
 *
 * The window-scoped hints (a mode carried across a same-window reload, a seed
 * the native host baked into the URL of a window it opened) keep their middle
 * position either way; what flips is which store bookends them — the project's
 * session in a desktop window, this device's own in a remote browser. The hints
 * are all absent in a remote browser anyway, since only the native host creates
 * them, so the two orders differ exactly where they should.
 *
 * Every source is either a usable value or null; the first usable one wins.
 * @param {object} sources - Candidate values, each already validated or null.
 * @param {boolean} sources.desktop - True in a native desktop window.
 * @param {any} sources.session - This project's saved value (server-injected).
 * @param {any} sources.device - This device's stored value (localStorage).
 * @param {any[]} [sources.windowScoped] - Window-scoped hints, best first.
 * @param {any} [sources.fallback] - Returned when nothing is stored anywhere.
 * @returns {any} The value to adopt.
 */
export function resolvePref({ desktop, session, device, windowScoped = [], fallback = null }) {
  const ordered = desktop
    ? [session, ...windowScoped, device]
    : [device, ...windowScoped, session];
  return ordered.find((value) => value !== null && value !== undefined) ?? fallback;
}
