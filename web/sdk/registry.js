//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/registry` — instantiate registered context-item types by id.
 *
 * The one registry capability a capability legitimately needs is to materialise
 * another registered context-item type by id — e.g. a plan strategy creating a
 * plan item. That is the narrow **`createItem`** named export below.
 */

import contextItemRegistry from '../js/registries/context-item-registry.js';

/**
 * Instantiate a registered context-item type from plain JSON. This is the
 * sanctioned, narrow entry point into the registry for capabilities.
 * @param {import('juggler/context-item').ItemJSON} json - Item data ({ id, type, data })
 * @param {import('../js/model/session.js').default} session - Owning session
 * @param {import('../js/model/conversation.js').default} conversation - Owning conversation
 * @param {import('../js/model/message-thread.js').default} messageThread - Owning thread
 * @returns {import('juggler/context-item').default} The instantiated context item
 * @throws {Error} If the item type is not registered or the JSON is malformed
 */
export function createItem(json, session, conversation, messageThread) {
  return contextItemRegistry.createItem(json, session, conversation, messageThread);
}
