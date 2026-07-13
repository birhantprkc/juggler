//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared helpers for user-message image attachments (AssetRefs).
 *
 * `normalizeAttachments` collapses the `attachments` field — which arrives
 * either as a plain array of plain objects (embedded JSON synced from the Go
 * worker) or, defensively, as a Y.Array of Y.Maps — into plain AssetRef
 * records. Lives here (rather than in a component) so both the conversation
 * area and the service-layer properties-panel renderers can share it without a
 * component→service layering inversion.
 * @module utils/attachments
 */

import { formatBytes } from './format.js';

/**
 * @typedef {{id:string, mime:string, filename:string, bytes:number, width:number, height:number}} AssetRef
 */

/**
 * Coerce a synced list field into a plain array. The value arrives either as a
 * plain array (embedded JSON synced from the Go worker) or, defensively, as a
 * Y.Array; anything else yields an empty array.
 * @param {any} raw
 * @returns {any[]} Plain array of the (still possibly Y.Map) entries.
 */
function toPlainList(raw) {
  return typeof raw?.toArray === 'function' ? raw.toArray() : (Array.isArray(raw) ? raw : []);
}

/**
 * Normalize a user item's `attachments` field into plain AssetRef objects.
 * @param {any} raw
 * @returns {AssetRef[]} Plain attachment refs (empty if none).
 */
export function normalizeAttachments(raw) {
  return toPlainList(raw)
    .map((/** @type {any} */ ref) => (ref && typeof ref.get === 'function')
      ? { id: ref.get('id'), mime: ref.get('mime'), filename: ref.get('filename'), bytes: ref.get('bytes'), width: ref.get('width'), height: ref.get('height') }
      : ref)
    .filter((/** @type {any} */ ref) => ref && ref.id);
}

/**
 * @typedef {{filename:string, content:string, bytes:number}} TextFileSnapshot
 */

/**
 * @typedef {{text: string, attachments: AssetRef[], textFiles: TextFileSnapshot[], scheduledSendAt: number|null}} Draft
 * `scheduledSendAt` is an epoch-ms wall-clock target for a deferred "send after
 * a delay": the input box arms a timer to press Send at that moment. Persisting
 * it on the draft (rather than a live-only timer) is what lets a pending send
 * survive a reload and stay bound to the thread it was composed in. `null` when
 * no send is scheduled.
 */

/**
 * Normalize a draft's `textFiles` field — dropped text-file snapshots — into
 * plain records. Like {@link normalizeAttachments}, it accepts either a plain
 * array of plain objects (synced from the Go worker) or a Y.Array of Y.Maps.
 * Entries without string content are dropped.
 * @param {any} raw
 * @returns {TextFileSnapshot[]} Plain text-file snapshots (empty if none).
 */
export function normalizeTextFiles(raw) {
  return toPlainList(raw)
    .map((/** @type {any} */ t) => (t && typeof t.get === 'function')
      ? { filename: t.get('filename'), content: t.get('content'), bytes: t.get('bytes') }
      : t)
    .filter((/** @type {any} */ t) => t && typeof t.content === 'string')
    .map((/** @type {any} */ t) => ({
      filename: typeof t.filename === 'string' ? t.filename : 'dropped file',
      content: t.content,
      bytes: typeof t.bytes === 'number' ? t.bytes : 0
    }));
}

/**
 * Normalize the `draft` field — the unsent input-box draft, stored as a single
 * `{text, attachments, textFiles}` record (a Y.Map on a thread container, or a
 * plain object synced from conversation metadata) — into a plain Draft. Always
 * returns a well-formed record so callers can read every part unconditionally.
 * Modelling the draft as ONE record (rather than a bare text string plus
 * component-local attachments) is what makes a half-persisted draft — text
 * kept, attachments/text-files lost across a reload — structurally impossible.
 * @param {any} raw
 * @returns {Draft} The draft (empty text + no attachments/text-files when absent).
 */
export function normalizeDraft(raw) {
  if (!raw) return { text: '', attachments: [], textFiles: [], scheduledSendAt: null };
  const obj = (typeof raw.toJSON === 'function') ? raw.toJSON() : raw;
  const text = (obj && typeof obj.text === 'string') ? obj.text : '';
  const when = obj && obj.scheduledSendAt;
  return {
    text,
    attachments: normalizeAttachments(obj && obj.attachments),
    textFiles: normalizeTextFiles(obj && obj.textFiles),
    scheduledSendAt: (typeof when === 'number' && Number.isFinite(when)) ? when : null
  };
}

/**
 * Format a byte count as a compact human-readable size ("823 B", "12.3 KB",
 * "4.1 MB"). Returns an empty string for a missing/zero/invalid count so
 * callers can omit the field entirely.
 * @param {number} bytes
 * @returns {string} Formatted size, or '' when there is nothing to show.
 */
export function formatAttachmentBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  return formatBytes(bytes);
}
