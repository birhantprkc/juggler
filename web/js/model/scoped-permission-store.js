//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
/* eslint-disable jsdoc/require-param, jsdoc/require-returns, jsdoc/require-returns-description, jsdoc/require-property-description, jsdoc/escape-inline-tags */
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The storage machinery behind {@link module:model/message-thread-permissions}:
 * one collection of entries kept in two scopes at once.
 *
 *   - session:      project-wide, stored as JSON in `session.metadata`
 *   - conversation: this conversation tab, stored in the conversation Yjs doc
 *
 * Permission rules and allowed paths are the same collection with different
 * payloads, so both are instances of {@link createScopedStore} rather than two
 * hand-copied read/save/locate/move sets. Everything entry-shaped —
 * normalization, defaults, identity, what a session entry is allowed to be —
 * arrives as configuration; the store itself never inspects an entry's fields.
 * @module model/scoped-permission-store
 */

import { plain } from './item-accessor.js';

/**
 * @typedef {'session'|'conversation'} PermissionScope
 */

export const SCOPE_SESSION = 'session';
export const SCOPE_CONVERSATION = 'conversation';

/** @type {PermissionScope[]} Lookup order: session entries outrank conversation ones. */
const SCOPES = [SCOPE_SESSION, SCOPE_CONVERSATION];

/** @param {any} mt @returns {Record<string, any>} */
function sessionMetadata(mt) {
  return mt.conversation?.session?.metadata || {};
}

/**
 * @typedef {object} ScopedStoreConfig
 * @property {string} sessionKey Key holding the session-scoped array in `session.metadata`.
 * @property {string} conversationKey Key holding the conversation-scoped array in the Yjs doc.
 * @property {(entry: any, fallbackScope: PermissionScope) => any} normalize Coerce a stored entry into its canonical shape, defaulting its scope.
 * @property {(a: any, b: any) => boolean} sameIdentity Whether two entries mean the same grant (dedupe across scopes).
 * @property {(entry: any, key: string) => boolean} matches Whether an entry is the one a caller named (id, path, …).
 * @property {(mt: any) => any[]} [defaults] Entries to fall back to when the conversation has never stored any.
 * @property {(mt: any, entry: any) => boolean} [sessionAllows] Drop session-scoped entries this returns false for (see the rules store).
 * @property {(mt: any, entries: any[]) => void} [afterConversationSave] Side effect to run once a conversation-scope write lands.
 */

/**
 * @typedef {object} ScopedStore
 * @property {(mt: any, scope: PermissionScope) => any[]} read
 * @property {(mt: any, scope: PermissionScope, entries: any[]) => void} save
 * @property {(mt: any) => any[]} all
 * @property {(mt: any, entry: any, scope: PermissionScope) => void} append
 * @property {(mt: any, key: string) => {scope: PermissionScope, entries: any[], entry: any, index: number}|null} locate
 * @property {(mt: any, key: string) => boolean} remove
 * @property {(mt: any, key: string, mutate: (entry: any, scope: PermissionScope) => any) => boolean} update
 * @property {(mt: any, key: string, targetScope: PermissionScope, options?: {canMoveTo?: (mt: any, entry: any) => boolean}) => boolean} move
 */

/**
 * Build one two-scope collection.
 * @param {ScopedStoreConfig} config
 * @returns {ScopedStore}
 */
export function createScopedStore(config) {
  const { sessionKey, conversationKey, normalize, sameIdentity, matches, defaults, sessionAllows, afterConversationSave } = config;

  /** @param {any} mt @returns {any[]} */
  function readSession(mt) {
    const stored = sessionMetadata(mt)[sessionKey];
    if (!Array.isArray(stored)) return [];
    const entries = stored.map(e => normalize(e, SCOPE_SESSION));
    return sessionAllows ? entries.filter(e => sessionAllows(mt, e)) : entries;
  }

  /** @param {any} mt @returns {any[]} */
  function readConversation(mt) {
    const stored = plain(mt.conversation.getMetadata(conversationKey));
    const source = Array.isArray(stored) ? stored : (defaults?.(mt) || []);
    return source.map((/** @type {any} */ e) => normalize(e, SCOPE_CONVERSATION));
  }

  /** @param {any} mt @param {any[]} entries */
  function saveSession(mt, entries) {
    const session = mt.conversation?.session;
    const normalized = entries.map(e => normalize(e, SCOPE_SESSION));
    if (session?.patchMetadata) session.patchMetadata({ [sessionKey]: normalized });
    else if (session) session.metadata = { ...(session.metadata || {}), [sessionKey]: normalized };
  }

  /** @param {any} mt @param {any[]} entries */
  function saveConversation(mt, entries) {
    const normalized = entries.map(e => normalize(e, SCOPE_CONVERSATION));
    mt.conversation.setMetadata(conversationKey, normalized);
    afterConversationSave?.(mt, normalized);
  }

  /** @param {any} mt @param {PermissionScope} scope @returns {any[]} */
  function read(mt, scope) {
    return scope === SCOPE_SESSION ? readSession(mt) : readConversation(mt);
  }

  /** @param {any} mt @param {PermissionScope} scope @param {any[]} entries */
  function save(mt, scope, entries) {
    if (scope === SCOPE_SESSION) saveSession(mt, entries);
    else saveConversation(mt, entries);
  }

  /** @param {any} mt @returns {any[]} */
  function all(mt) {
    return [...readSession(mt), ...readConversation(mt)];
  }

  /** @param {any} mt @param {any} entry @param {PermissionScope} scope */
  function append(mt, entry, scope) {
    save(mt, scope, [...read(mt, scope), entry]);
  }

  /** @param {any} mt @param {string} key @returns {{scope: PermissionScope, entries: any[], entry: any, index: number}|null} */
  function locate(mt, key) {
    for (const scope of SCOPES) {
      const entries = read(mt, scope);
      const index = entries.findIndex(e => matches(e, key));
      if (index !== -1) return { scope, entries, entry: entries[index], index };
    }
    return null;
  }

  /** @param {any} mt @param {string} key @returns {boolean} */
  function remove(mt, key) {
    const hit = locate(mt, key);
    if (!hit) return false;
    const next = hit.entries.slice();
    next.splice(hit.index, 1);
    save(mt, hit.scope, next);
    return true;
  }

  /** @param {any} mt @param {string} key @param {(entry: any, scope: PermissionScope) => any} mutate @returns {boolean} */
  function update(mt, key, mutate) {
    const hit = locate(mt, key);
    if (!hit) return false;
    const next = hit.entries.slice();
    next[hit.index] = mutate(hit.entry, hit.scope);
    save(mt, hit.scope, next);
    return true;
  }

  /**
   * Move an entry to the other scope. Already-there is success; an entry the
   * destination already holds (by identity) is dropped rather than duplicated.
   * @param {any} mt
   * @param {string} key
   * @param {PermissionScope} targetScope
   * @param {{canMoveTo?: (mt: any, entry: any) => boolean}} [options]
   * @returns {boolean}
   */
  function move(mt, key, targetScope, options = {}) {
    const target = targetScope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
    const hit = locate(mt, key);
    if (!hit) return false;
    if (hit.scope === target) return true;
    const moved = normalize({ ...hit.entry, scope: target }, target);
    if (options.canMoveTo && !options.canMoveTo(mt, moved)) return false;
    const sourceNext = hit.entries.slice();
    sourceNext.splice(hit.index, 1);
    const targetEntries = read(mt, target);
    // Write the destination before removing the source so live popup renderers
    // never see the row disappear and re-enter at a different position.
    if (!targetEntries.some(e => sameIdentity(e, moved))) save(mt, target, [...targetEntries, moved]);
    save(mt, hit.scope, sourceNext);
    return true;
  }

  return { read, save, all, append, locate, remove, update, move };
}
