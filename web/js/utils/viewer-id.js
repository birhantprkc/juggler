//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Viewer identity — this document's own name, stable across reloads, which is
 * what one viewer hands to another so it can be addressed later.
 *
 * The server mints a client id per WebSocket connection, and that is the wrong
 * grain here: a viewer that reloads, or whose link blips, arrives under a new
 * client id, and anything holding the old one would think it had gone. So the
 * id is minted here and kept in sessionStorage, which is scoped to this tab and
 * survives a reload of it.
 *
 * Two caveats worth knowing rather than defending against:
 * - Duplicating a tab copies its sessionStorage in some browsers, so two
 *   documents can carry one id. Anything addressed to it reaches both, which is
 *   a harmless duplicate rather than a misdelivery.
 * - The engine realm has no sessionStorage and needs no identity; it gets the
 *   empty string, and an empty id addresses nothing.
 * @module utils/viewer-id
 */

/** sessionStorage key holding this tab's viewer id. */
const STORAGE_KEY = 'juggler-viewer-id';

/**
 * Cached for this document's life, so a blocked sessionStorage is still stable.
 * @type {string|null}
 */
let cached = null;

/**
 * Mint a fresh viewer id. The alphabet is what the server accepts verbatim
 * (see sanitiseViewerID in cmd/juggler/server/network.go).
 * @returns {string} A new id of the form `v_<32 hex chars>`.
 */
function mint() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `v_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * This document's viewer id, minting and storing one on first use.
 * @returns {string} The id, or '' in a realm with no sessionStorage.
 */
export function viewerId() {
  if (cached !== null) return cached;
  let store = null;
  try {
    store = globalThis.sessionStorage;
  } catch {
    // Storage disabled by policy; fall through to a memory-only id.
  }
  if (!store) {
    cached = typeof globalThis.crypto?.getRandomValues === 'function' ? mint() : '';
    return cached;
  }
  try {
    const saved = store.getItem(STORAGE_KEY);
    if (saved) {
      cached = saved;
      return cached;
    }
    cached = mint();
    store.setItem(STORAGE_KEY, cached);
  } catch {
    cached = mint();
  }
  return cached;
}
