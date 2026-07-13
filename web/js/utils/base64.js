//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * base64 <-> Uint8Array conversion for the worker/engine yjs-sync transport. Go's
 * json.Marshal encodes `[]byte` as base64 and json.Unmarshal expects the same, so
 * every doc update crossing the boundary is packed/unpacked here.
 * @module utils/base64
 */

/**
 * Encode raw bytes as a base64 string.
 * @param {Uint8Array} bytes - The bytes to encode.
 * @returns {string} The base64 representation.
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(/** @type {number} */ (bytes[i]));
  }
  return globalThis.btoa(binary);
}

/**
 * Decode a base64 string back into raw bytes.
 * @param {string} base64 - The base64 string to decode.
 * @returns {Uint8Array} The decoded bytes.
 */
export function base64ToBytes(base64) {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
