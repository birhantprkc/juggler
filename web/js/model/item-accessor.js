//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Item Accessor - Y.Map creation helpers for conversation items
 * Provides conversion from plain JS objects to Y.Map CRDT types at insertion boundaries.
 * @module model/item-accessor
 */

import * as Y from '../vendor/yjs.mjs';

/**
 * Convert a plain object to a Y.Map with nested CRDT types.
 * Used at insertion boundaries when creating new items.
 * Nested objects become Y.Map, arrays become Y.Array, primitives pass through.
 * @param {object} obj - Plain object
 * @returns {*} New Y.Map with properties set
 */
export function plainToYMap(obj) {
  const ymap = new Y.Map();
  if (!obj || typeof obj !== 'object') return ymap;

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    ymap.set(key, convertToYType(value));
  }
  return ymap;
}

/**
 * Convert a plain JS value to a Yjs CRDT type.
 * Objects → Y.Map, Arrays → Y.Array, primitives pass through.
 * Already-CRDT values (Y.Map, Y.Array) pass through unchanged.
 * @param {any} value - Value to convert
 * @returns {any} Converted value
 */
export function convertToYType(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Y.Map || value instanceof Y.Array) return value;

  if (Array.isArray(value)) {
    const yarr = new Y.Array();
    yarr.push(value.map(v => convertToYType(v)));
    return yarr;
  }

  if (typeof value === 'object') {
    const ymap = new Y.Map();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      ymap.set(k, convertToYType(v));
    }
    return ymap;
  }

  return value;
}
