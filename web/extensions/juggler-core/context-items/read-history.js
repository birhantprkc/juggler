//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-before-mutate freshness, derived from the durable conversation
 * transcript.
 *
 * The edit and write tools refuse to modify an existing file the model hasn't
 * looked at this session (Claude Code-style), and refuse when the file's bytes
 * have changed on disk since the model last saw them — so a blind or stale
 * search-and-replace can't corrupt a file the model is only guessing at. Both
 * answers come entirely from state the conversation persists in its Yjs
 * document:
 *
 *  - successful `read`/`write`/`edit`/`batch_read` tool-actions for the path
 *    (the model read, created, or already mutated it), and `explore_code`
 *    actions whose sandbox script `fs.readFile`-ed it. Their recorded results
 *    carry `contentHash` — the SHA-256 of the file's raw on-disk bytes that the
 *    backend echoes from every read and mutation — which is compared against
 *    the file's current hash to detect out-of-band change;
 *  - a pinned / at-mentioned file-content context item for the path. Pins are
 *    re-rendered into context at send time, so a pinned file is always treated
 *    as fresh.
 *
 * Because the transcript is durable and shared, freshness survives app
 * relaunch, engine restarts, and additional clients attaching, and reads the
 * same doc in either browser realm — there is no per-process state to lose or
 * keep in sync. A matching record without a stored hash (transcripts written
 * before hashes were recorded) counts as seen-but-unverifiable: the mutation is
 * allowed rather than forcing a spurious re-read.
 * @module context-items/read-history
 */

import { toolInputPath, absolutePathKey } from './path-approval.js';

/**
 * In-memory, per-realm record of content hashes this process has written via a
 * completed edit/write, keyed by canonical absolute path (absolutePathKey).
 *
 * Layered on top of the durable transcript purely to close a timing window:
 * when several edits to the same file execute within one assistant turn, an
 * earlier edit's completed tool-action — which carries its post-edit hash — may
 * not yet be observable in the Yjs transcript when the next edit validates, so
 * the follow-up would see its own sibling's freshly-written bytes as an
 * out-of-band change and be spuriously refused. recordWrittenHash captures every
 * hash this process actually wrote, synchronously at execute time. Because every
 * remembered hash is bytes we wrote ourselves, honoring it can never wave
 * through an unseen out-of-band change — it only recognises our own just-applied
 * write. Bounded per path to cap memory over a long session.
 * @type {Map<string, Set<string>>}
 */
const writtenHashes = new Map();

/** Cap on remembered hashes per path, bounding memory over a long session. */
const MAX_WRITTEN_HASHES_PER_PATH = 8;

/**
 * Record a content hash this process just wrote to `path`, so a follow-up
 * mutation of the same file within the same assistant turn passes the freshness
 * guard without waiting for the durable transcript to catch up. Safe by
 * construction: only hashes of bytes we actually wrote are remembered.
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path that was written
 * @param {string|undefined} hash - The file's on-disk content hash after the write
 * @returns {void}
 */
export function recordWrittenHash(session, path, hash) {
  if (typeof hash !== 'string' || !hash) return;
  const target = absolutePathKey(session, path);
  if (!target) return;
  let set = writtenHashes.get(target);
  if (!set) {
    set = new Set();
    writtenHashes.set(target, set);
  }
  set.add(hash);
  // A Set preserves insertion order: evict the oldest once over the cap.
  while (set.size > MAX_WRITTEN_HASHES_PER_PATH) {
    const oldest = /** @type {string} */ (set.values().next().value);
    set.delete(oldest);
  }
}

/**
 * Clear the in-memory written-hash record. Test-only — the store is otherwise
 * process-lifetime and never needs clearing.
 * @returns {void}
 */
export function __resetWrittenHashesForTest() {
  writtenHashes.clear();
}

/**
 * Tools whose successful completion means the model has seen the file's bytes.
 * `batch_read` is matched via its per-file results (which carry per-file
 * success and hash) rather than its input list, and `explore_code` via the
 * `filesRead` map its result records for every `fs.readFile` its script made.
 * @type {Set<string>}
 */
const SEEN_TOOLS = new Set(['read', 'write', 'edit', 'batch_read', 'explore_code']);

/**
 * Read a property from either a Y.Map or a plain object. Transcript values are
 * Y types when read from the live doc and plain objects in tests; accessing
 * fields lazily this way avoids materialising whole results (which can embed
 * full file contents) via toJSON.
 * @param {any} obj - Y.Map, plain object, or undefined
 * @param {string} key - Property name
 * @returns {any} The value, or undefined
 */
function yget(obj, key) {
  if (!obj) return undefined;
  return typeof obj.get === 'function' ? obj.get(key) : obj[key];
}

/**
 * View a Y.Array or plain array as a plain array.
 * @param {any} value - Y.Array, array, or undefined
 * @returns {any[]} Plain array view (empty when not array-like)
 */
function ylist(value) {
  if (!value) return [];
  if (typeof value.toArray === 'function') return value.toArray();
  return Array.isArray(value) ? value : [];
}

/**
 * The ops-layer payload inside a persisted tool-action result. The action
 * pipeline stores the backend's result nested under `fullResult.result`
 * (response-handler wraps it with state/success/displayData); simpler writers
 * store the payload as `fullResult` directly, so fall back to that.
 * @param {any} result - The tool-action's persisted result (Y.Map or object)
 * @returns {any} The ops payload, or undefined
 */
function opsPayload(result) {
  const full = yget(result, 'fullResult');
  return yget(full, 'result') ?? full;
}

/**
 * @typedef {object} SeenState
 * @property {boolean} seen - The model has seen this path this session
 * @property {boolean} pinned - A pinned/at-mentioned item covers the path (always fresh)
 * @property {Set<string>} hashes - Content hashes the model has seen for the path
 * @property {boolean} unverified - Some matching record carries no hash, so staleness can't be proven
 */

/**
 * Collect what the transcript says the model has seen for `path`: whether it
 * was seen at all, via a pin or via tool-actions, and every content hash those
 * records carry.
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path the mutation targets
 * @returns {SeenState} Aggregated seen-state for the path
 */
function seenState(conversation, session, path) {
  /** @type {SeenState} */
  const state = { seen: false, pinned: false, hashes: new Set(), unverified: false };
  const target = absolutePathKey(session, path);
  if (!conversation || !target) return state;

  const threads = /** @type {any} */ (conversation).getAllMessageThreads?.() || [];
  for (const thread of threads) {
    // 1) User-surfaced context items (pins, at-mentions) carrying a path — in
    //    ANY thread, since subthreads can hold their own pins. Their bytes are
    //    rendered into context at send time, so they always count as fresh.
    for (const item of thread.contextItems || []) {
      const p = /** @type {any} */ (item)?.data?.path;
      if (p && absolutePathKey(session, p) === target) {
        state.seen = true;
        state.pinned = true;
      }
    }

    // 2) Prior successful seen-tool actions for this path. Completed + non-error
    //    only, so a not-yet-finished action (including the current mutation's
    //    own pending tool-action) never counts as "seen". The cheap toolInput
    //    path comparison runs before any result field is touched, so
    //    non-matching actions cost almost nothing.
    for (const ymap of thread.items || []) {
      if (typeof ymap.get !== 'function' || ymap.get('type') !== 'tool-action') continue;
      const toolName = ymap.get('toolName');
      if (!SEEN_TOOLS.has(toolName)) continue;
      if (ymap.get('state') !== 'completed') continue;
      const rawInput = ymap.get('toolInput');
      const toolInput = rawInput?.toJSON ? rawInput.toJSON() : rawInput;

      if (toolName === 'batch_read') {
        collectBatchRead(state, session, target, toolInput, ymap);
        continue;
      }
      if (toolName === 'explore_code') {
        collectExploreCode(state, session, target, ymap);
        continue;
      }

      const p = toolInputPath(toolInput, true);
      if (!p || absolutePathKey(session, p) !== target) continue;

      const result = ymap.get('result');
      if (!result || yget(result, 'isError') === true) continue;
      if (yget(yget(result, 'fullResult'), 'success') === false) continue;
      const payload = opsPayload(result);
      // A read that found no file proved nothing about its contents.
      if (yget(payload, 'exists') === false) continue;

      state.seen = true;
      const hash = yget(payload, 'contentHash');
      if (typeof hash === 'string' && hash) state.hashes.add(hash);
      else state.unverified = true;
    }
  }
  return state;
}

/**
 * Fold a completed batch_read action's per-file results into `state`. Matching
 * prefers the result entries (each records whether THAT file's read succeeded
 * and the hash of what it saw). When the stored result carries no per-file
 * entries — the transcript writer strips large `results` arrays down to a
 * count — an input-listed file on a non-error action counts as
 * seen-but-unverifiable instead, so a big batch still registers as a read.
 * @param {SeenState} state - Aggregate to update
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string} target - Canonical key of the path being checked
 * @param {any} toolInput - The batch_read tool input (files list, used as a cheap pre-filter)
 * @param {any} ymap - The tool-action Y.Map
 * @returns {void}
 */
function collectBatchRead(state, session, target, toolInput, ymap) {
  // Cheap pre-filter on the input list before touching the (larger) result.
  const inputFiles = ylist(toolInput?.files);
  const inInput = inputFiles.some(
    (f) => absolutePathKey(session, /** @type {any} */ (f)?.file_path) === target
  );
  if (inputFiles.length > 0 && !inInput) return;

  const result = ymap.get('result');
  if (!result || yget(result, 'isError') === true) return;
  const entries = ylist(yget(opsPayload(result), 'results'));

  if (entries.length === 0) {
    // Per-file entries stripped from storage: trust the input list.
    if (inInput) {
      state.seen = true;
      state.unverified = true;
    }
    return;
  }

  for (const entry of entries) {
    if (yget(entry, 'success') !== true) continue;
    const file = yget(entry, 'file');
    if (!file || absolutePathKey(session, String(file)) !== target) continue;
    const fileResult = yget(entry, 'result');
    if (yget(fileResult, 'exists') === false) continue;
    state.seen = true;
    const hash = yget(fileResult, 'contentHash');
    if (typeof hash === 'string' && hash) state.hashes.add(hash);
    else state.unverified = true;
  }
}

/**
 * Entries of a Y.Map or plain object as [key, value] pairs.
 * @param {any} obj - Y.Map, plain object, or undefined
 * @returns {Array<[string, any]>} Entry pairs (empty when not map-like)
 */
function yentries(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (typeof obj.entries === 'function' && typeof obj.get === 'function') {
    return [...obj.entries()];
  }
  return Object.entries(obj);
}

/**
 * Fold a completed explore_code action's recorded reads into `state`. The
 * tool's result carries `filesRead` — path → contentHash for every file the
 * sandbox script's `fs.readFile` pulled — recorded by the explore-code item at
 * execute time. The model's own script chose those reads, so they earn full
 * hash credit; grep/glob results are deliberately absent (fragments and names
 * don't show the model the file).
 * @param {SeenState} state - Aggregate to update
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string} target - Canonical key of the path being checked
 * @param {any} ymap - The tool-action Y.Map
 * @returns {void}
 */
function collectExploreCode(state, session, target, ymap) {
  const result = ymap.get('result');
  if (!result || yget(result, 'isError') === true) return;
  for (const [file, hash] of yentries(yget(opsPayload(result), 'filesRead'))) {
    if (absolutePathKey(session, file) !== target) continue;
    state.seen = true;
    if (typeof hash === 'string' && hash) state.hashes.add(hash);
    else state.unverified = true;
  }
}

/**
 * Gate a file mutation on transcript-derived freshness. Refuses when the model
 * has never seen the file this session, or when `currentHash` (the file's
 * current on-disk SHA-256, as reported by the backend) matches none of the
 * hashes the model has seen — i.e. the file changed out-of-band since it was
 * last read. Pinned files and hash-less legacy records are treated as fresh.
 * @param {object|undefined} conversation - Conversation instance
 * @param {object|undefined} session - Session (for path resolution)
 * @param {string|undefined} path - File path the mutation targets
 * @param {string|undefined} [currentHash] - Current on-disk content hash, when known
 * @param {string} [verb] - Mutation verb for the refusal message ('edit', 'overwrite')
 * @returns {{ok: true}|{ok: false, error: string}} Freshness verdict
 */
export function checkFileFreshness(conversation, session, path, currentHash, verb = 'edit') {
  const state = seenState(conversation, session, path);
  // A hash this process wrote earlier this turn proves the file was seen even
  // if that write's tool-action has not yet surfaced in the durable transcript.
  const target = absolutePathKey(session, path);
  const written = target ? writtenHashes.get(target) : undefined;
  if (!state.seen && !(written && written.size > 0)) {
    return {
      ok: false,
      error: `Refusing to ${verb} '${path}': it has not been read this session. Read the file first, then retry using its exact current text.`
    };
  }
  if (state.pinned || state.unverified || !currentHash) return { ok: true };
  if (state.hashes.has(currentHash)) return { ok: true };
  // In-flight sibling edit: the current on-disk bytes match a hash we wrote
  // earlier this turn, whose completing tool-action the transcript may not
  // reflect yet. Trust it — those bytes are our own just-applied write, not an
  // unseen out-of-band change.
  if (written && written.has(currentHash)) return { ok: true };
  return {
    ok: false,
    error: `Refusing to ${verb} '${path}': the file has changed on disk since it was last read. Re-read the file, then retry against its current content.`
  };
}
