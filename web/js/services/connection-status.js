//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side mirror of the WebSocket's liveness, as the UI wants to show it:
 * `null` while connected, `'disconnected'` after a close, `'error'` after a
 * socket error. Subscribing here rather than being pushed at means a widget
 * created mid-outage (a conversation tab opened while the socket is down) reads
 * the current state on arrival instead of showing a stale "connected" until the
 * next transition.
 *
 * Registers its listeners at module-evaluation time, which precedes the app's
 * `connect()` — the same ordering `providers-cache.js` relies on.
 * @module services/connection-status
 */

import wsService from './websocket.js';

/** @typedef {null|'connecting'|'disconnected'|'error'} ConnectionStatus */

/** @type {ConnectionStatus} */
let _status = null;

/** @type {Set<(status: ConnectionStatus) => void>} */
const _subscribers = new Set();

/** @param {ConnectionStatus} next */
function set(next) {
  if (_status === next) return;
  _status = next;
  for (const fn of _subscribers) fn(_status);
}

wsService.on('open', () => set(null));
wsService.on('close', () => set('disconnected'));
wsService.on('error', () => set('error'));

const connectionStatus = {
  /**
   * The current status. Starts at `null` (assume connected) so the first paint
   * of a normal load shows no fault before the socket has had a chance to open.
   * @returns {ConnectionStatus} Current status.
   */
  get() {
    return _status;
  },

  /**
   * Subscribe to status changes. The callback fires only on change, so callers
   * should seed themselves from `get()` first.
   * @param {(status: ConnectionStatus) => void} fn - Called with each new status.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
  }
};

export default connectionStatus;
