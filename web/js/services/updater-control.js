//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client for the in-app updater, reached over the native window-control
 * endpoint (`/win/<id>/updater?op=…`). The updater itself lives in the desktop
 * *app* process (a private build overlay), not the server that served this page,
 * so — like minimise/close/pick-directory — the only way to it is the loopback
 * control endpoint baked into the window URL as `nativeCtl`.
 *
 * Every call is null-safe: in a plain browser tab (or any page opened without a
 * native host) `windowControlURL` returns null and these resolve to the
 * "no updater" answer, so the update UI degrades to the server-side version
 * notice alone. All ops are POST, matching every other control call.
 */

/**
 * @typedef {object} UpdaterState
 * @property {boolean} present - Whether this build has an in-app updater at all.
 * @property {string} [state] - updater state: idle | checking | up-to-date |
 *   available | downloading | verifying | installing | ready | error.
 * @property {string} [version] - Target release version.
 * @property {string} [appVersion] - This app bundle's version (skew detection).
 * @property {number} [written] - Bytes downloaded so far.
 * @property {number} [total] - Total bytes to download (<=0 ⇒ indeterminate).
 * @property {string} [error] - Last error message, when state === 'error'.
 * @property {boolean} [appManagedServer] - Whether this window's server was
 *   spawned by the app (and so is replaced by the bundle swap).
 */

import { windowControlURL } from '../../sdk/lib/window-control.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/** The "no in-app updater" answer used whenever there is no native host. */
const ABSENT = /** @type {UpdaterState} */ ({ present: false });

/**
 * Read the current updater snapshot for this window. Never rejects — returns the
 * absent state on any error or when there is no native host.
 * @returns {Promise<UpdaterState>} The current snapshot, or the absent state.
 */
export async function getUpdaterState() {
  const url = windowControlURL('updater', '?op=state');
  if (!url) return ABSENT;
  try {
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) return ABSENT;
    const data = await resp.json();
    return data && typeof data === 'object' ? data : ABSENT;
  } catch {
    return ABSENT;
  }
}

/**
 * Kick (or retry) the background download+stage flow. No-op without a native
 * host. The result arrives via the pushed `juggler:updater-status` snapshot, not
 * a return value.
 * @returns {Promise<void>}
 */
export async function startInstall() {
  const url = windowControlURL('updater', '?op=install');
  if (!url) return;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    /* transient — the next pushed snapshot reflects reality */
  }
}

/**
 * The result of a restart request.
 * @typedef {object} RestartResult
 * @property {'ok'|'busy'|'error'|'absent'} status - The restart outcome.
 * @property {number} [busy] - In-flight turn count (status === 'busy').
 * @property {string} [message] - Human-readable reason (busy/error).
 */

/**
 * Relaunch into the staged update. On the first attempt the app returns 409 if
 * any conversation is still running a turn; the caller confirms and re-calls
 * with force=true. Success quits the app (no meaningful response), so an ok
 * result just means the restart was accepted.
 * @param {{force?: boolean}} [opts] - force=true skips the busy check.
 * @returns {Promise<RestartResult>} The restart outcome.
 */
export async function requestRestart({ force = false } = {}) {
  const url = windowControlURL('updater', force ? '?op=restart&force=1' : '?op=restart');
  if (!url) return { status: 'absent' };
  try {
    const resp = await fetch(url, { method: 'POST' });
    if (resp.status === 204) return { status: 'ok' };
    if (resp.status === 409) {
      const body = await resp.json().catch(() => ({}));
      return { status: 'busy', busy: body.busy, message: body.message };
    }
    const body = await resp.json().catch(() => ({}));
    return { status: 'error', message: body.error || `Restart failed (HTTP ${resp.status})` };
  } catch (err) {
    return { status: 'error', message: extractErrorMessage(err) };
  }
}
