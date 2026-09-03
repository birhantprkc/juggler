//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/pinboard` — one-way writes to the user's Pinboard.
 *
 * Extensions may request that a configured pin be added and revealed, but this
 * module deliberately exposes no board read or list operation. A Pinboard remains
 * display state, not a source of model context.
 * @module sdk/pinboard
 */

import { applyPinboardOperations } from '../js/services/pinboard-operations-api.js';

/**
 * Add or restore one pin on the shared main board and ask eligible viewers to
 * reveal it. `id` must be stable for an idempotent retry. The update following
 * the add also restores the expected config if that id was already present.
 * @param {{id: string, type: string, config: Record<string, any>, from: string, signal?: AbortSignal}} request - Pin request.
 * @returns {Promise<{board?: string, pins?: any[]}>} Resulting board.
 */
export function pinToPinboard(request) {
  const { id, type, config, from, signal } = request;
  if (!id || !type || !from) throw new Error('id, type and from are required');
  return applyPinboardOperations('main', [
    { op: 'add', id, type, config },
    { op: 'update', id, config },
  ], { pin: id, from }, signal);
}
