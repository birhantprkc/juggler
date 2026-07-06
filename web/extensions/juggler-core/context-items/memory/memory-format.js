//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parser/serializer for `.juggler/MEMORY.md` — the agent-writable project
 * memory file.
 *
 * GRAMMAR (deliberately strict and flat — matching the dominant convention in
 * ChatGPT saved memories and the battle-tested Claude-Code community designs:
 * a single heading over a flat list of dated one-liner bullets):
 *
 *   # Memory
 *
 *   - [YYYY-MM-DD] <fact>
 *   - [YYYY-MM-DD] <fact>
 *
 * Design contract:
 *  - `parseMemory` is TOTAL: it never throws, accepts null/undefined, and
 *    silently normalizes slightly-off hand edits (missing heading, stray blank
 *    lines, extra spacing, undated bullets). Non-bullet prose is dropped — this
 *    is a structured store of entries, not a free-form document.
 *  - `serializeMemory` emits the ONE canonical shape. A conforming file
 *    round-trips byte-for-byte; a malformed one is tidied on the next write and
 *    is idempotent thereafter.
 *
 * Because the format is strict, writers can reserialize the whole file
 * canonically on every write rather than attempt surgical line edits — the
 * round-trip is lossless by construction for anything that conforms.
 * @module juggler-core/context-items/memory/memory-format
 */

/**
 * One parsed memory entry.
 * @typedef {object} MemoryEntry
 * @property {string|null} date - ISO date `YYYY-MM-DD`, or null for an undated bullet
 * @property {string} text - The fact text (trimmed)
 * @property {string} raw - The bullet body as parsed (after the `- ` marker, trimmed)
 */

/**
 * Parsed memory document.
 * @typedef {object} ParsedMemory
 * @property {MemoryEntry[]} entries - Entries in file order
 */

const HEADING = '# Memory';

/** Matches a leading `[YYYY-MM-DD]` date stamp and captures the remainder. */
const DATE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;

/**
 * Parse memory file text into structured entries. Total — never throws.
 * @param {string|null|undefined} text - Raw file content
 * @returns {ParsedMemory} Parsed entries (empty when absent/blank/unstructured)
 */
export function parseMemory(text) {
  /** @type {MemoryEntry[]} */
  const entries = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { entries };
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Only bullet lines are entries; the heading and any stray prose are
    // dropped (strict format — an entry, not a margin note).
    if (!trimmed.startsWith('-')) continue;

    const body = trimmed.slice(1).trim();
    if (body === '') continue;

    const m = DATE_RE.exec(body);
    if (m) {
      // m[1] (date) and m[2] (text) are mandatory capture groups — present whenever m matched.
      entries.push({ date: /** @type {string} */ (m[1]), text: /** @type {string} */ (m[2]).trim(), raw: body });
    } else {
      entries.push({ date: null, text: body, raw: body });
    }
  }

  return { entries };
}

/**
 * Serialize entries into the canonical memory file shape.
 * @param {Array<{date?: string|null, text: string}>} entries - Entries to emit
 * @returns {string} Canonical file content (always ends with a trailing newline)
 */
export function serializeMemory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return HEADING + '\n';
  }
  const lines = list.map((e) => {
    const text = (e.text || '').trim();
    return e.date ? `- [${e.date}] ${text}` : `- ${text}`;
  });
  return HEADING + '\n\n' + lines.join('\n') + '\n';
}

/**
 * Append a new dated entry, returning the reserialized canonical content.
 * @param {string|null|undefined} content - Existing file content
 * @param {string} text - Fact to record
 * @param {string} date - ISO date `YYYY-MM-DD` to stamp
 * @returns {string} Updated canonical content
 */
export function appendEntry(content, text, date) {
  const { entries } = parseMemory(content);
  entries.push({ date: date || null, text: (text || '').trim(), raw: (text || '').trim() });
  return serializeMemory(entries);
}

/**
 * Remove every entry whose text contains `match` (case-insensitive substring).
 * @param {string|null|undefined} content - Existing file content
 * @param {string} match - Substring to match against entry text
 * @returns {{content: string, removed: string[]}} Updated content + removed entry texts
 */
export function removeMatching(content, match) {
  const { entries } = parseMemory(content);
  const needle = (match || '').toLowerCase();
  /** @type {string[]} */
  const removed = [];
  const kept = entries.filter((e) => {
    if (needle !== '' && e.text.toLowerCase().includes(needle)) {
      removed.push(e.text);
      return false;
    }
    return true;
  });
  return { content: serializeMemory(kept), removed };
}
