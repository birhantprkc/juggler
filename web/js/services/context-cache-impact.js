//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * One detection primitive for "will my next send re-read a large slice of the
 * cached conversation?" — surfaced as the composer's context-bust caution.
 *
 * The Anthropic prompt cache prefix is `[tools][system]` followed by the rolling
 * `[history]`; because it is prefix-matched, the next request hits the cache only
 * up to the first position that differs from what was last sent, and re-reads
 * everything after that divergence at full (uncached) price. So the cause of the
 * change is irrelevant — a staged strategy switch that alters the tool set, a
 * deleted or edited earlier message, anything that mutates the prefix — they are
 * all the same event: the outgoing prefix now diverges from the last-sent one
 * above the freshly-appended tail.
 *
 * We model the prefix as an ordered fingerprint: element 0 is the tool-set
 * signature (the only part of `[tools][system]` a strategy switch changes, since
 * strategy guidance is injected as tail messages, never placed in the system
 * prompt) and the rest is one signature per history item. The baseline is the
 * fingerprint captured when the conversation last went idle (that transcript is
 * exactly what was cached). Diff current vs baseline: a divergence that *replaces*
 * a cached item (current is not a prefix of baseline) busts the cache from there;
 * the two ways current stays a prefix of baseline both cost nothing — a pure
 * append (a new user message) diverges only past the baseline's end, and a
 * truncation (`/clear`, deleting the tail) diverges only past the shortened
 * current's end, leaving the provider's cache still covering the whole outgoing
 * prefix. Undo restores the transcript, the fingerprint matches the baseline
 * again, and the caution clears.
 *
 * A divergence is necessary but not sufficient to caution: what actually costs is
 * the *size* of the uncached slice re-sent next turn — the previously-cached
 * content re-read from the divergence to the end of its overlap with the cached
 * prefix. Two independent things make that slice cheap, and either one alone
 * clears the caution:
 *   • the divergence sits near the end — editing the last message of a huge
 *     conversation busts the cache but re-reads only a short tail; or
 *   • the whole outgoing context is small — after a `/clear` (or any shrink to a
 *     handful of messages) even a 100%-changed prefix re-reads almost nothing, so
 *     who cares that the cache was lost.
 * Both reduce to the same number: the tokens in the re-read slice. We have one
 * real token measurement (the whole cached prefix, from the last turn's input
 * tokens) and the per-item content lengths baked into the fingerprint, so we
 * apportion that measurement by the content-length fraction that falls in the
 * re-read slice, and caution only when the estimate clears
 * CONTEXT_CACHE_WARNING_TOKENS. (A pure append adds new tail the cache never held,
 * beyond that overlap, so it is not counted — appending never busts.)
 * @module services/context-cache-impact
 */

/**
 * Bubbling event the strategy selector fires when its cache-impact
 * classification flips. The composer (composer-box) owns the warning affordance —
 * a round alert beside the send button — so this signal is the only coupling
 * between the two: `detail.busts` is true when the next send would re-read a
 * large slice of cached context, false when it clears.
 * @type {string}
 */
export const CONTEXT_CACHE_IMPACT_CHANGED = 'context-cache-impact-changed';

/**
 * Estimated re-read floor: when the next send would re-read fewer than this many
 * tokens of previously-cached context at full price, the bust is too cheap to
 * caution about (re-warming a small tail next turn costs little). Compared against
 * the apportioned estimate, not the whole cached prefix — so an edit near the end
 * of a long conversation, or any edit in a small one, stays silent. Pure viewer
 * UX — no exact re-read figure is ever shown (the estimate is deliberately
 * approximate), only whether the loss is large enough to mention.
 * @type {number}
 */
export const CONTEXT_CACHE_WARNING_TOKENS = 25000;

/**
 * A cheap, stable per-item signature: its id plus a light content fingerprint
 * (type + content length). Deleting, inserting, or reordering items changes the
 * id sequence; most edits change the content length. A content-preserving edit
 * (same length) is deliberately not detected — not worth hashing full bodies on
 * every keystroke for that rare case.
 * @param {{get?: (key: string) => any}} item - A history item (Y.Map or plain)
 * @returns {string} The item signature
 */
function itemSignature(item) {
  const get = item?.get?.bind(item);
  if (!get) return '?';
  const id = String(get('itemId') || get('messageId') || get('transactionId') || '');
  const type = String(get('type') || '');
  const content = get('content');
  const len = typeof content === 'string' ? content.length : 0;
  return `${id}~${type}~${len}`;
}

/**
 * A signature for a leading `prefix` context item (a pinned/dropped file frozen
 * at add-time): its id, type, and content length. Adding, removing, or re-pinning
 * one changes the id sequence; a re-snapshot with different bytes changes the
 * length. Same `~<len>` tail encoding as {@link itemSignature}, so
 * {@link signatureWeight} sizes its re-read slice too.
 * @param {{id?: string, type?: string, data?: {content?: unknown}}} ci - A context item instance
 * @returns {string} The context-item signature
 */
function contextItemSignature(ci) {
  const id = String(ci?.id || '');
  const type = String(ci?.type || '');
  const content = ci?.data?.content;
  const len = typeof content === 'string' ? content.length : 0;
  return `ctx:${id}~${type}~${len}`;
}

/**
 * Build the ordered prefix fingerprint: the tool-set signature, then one
 * signature per leading `prefix` context item, then one per history item.
 *
 * Prefix context items (frozen pinned/dropped files) sit between tools+system and
 * the growing history, so they ARE part of the cached prefix now: adding, removing,
 * or re-pinning one busts the cache from its position, exactly like editing a
 * history item. They precede the history entries here so a divergence in them is
 * measured against everything cached after them.
 * @param {object} args
 * @param {string} args.toolsetSig - Sorted tool-name signature under the effective strategy
 * @param {Array<{id?: string, type?: string, data?: {content?: unknown}}>} [args.prefixItems] - The thread's leading `prefix`-position context items
 * @param {Array<{get?: (key: string) => any}>} args.items - The thread's history items
 * @returns {string[]} The prefix fingerprint
 */
export function buildPrefixFingerprint({ toolsetSig, prefixItems = [], items }) {
  const fp = ['tools:' + (toolsetSig || '')];
  for (const ci of prefixItems || []) fp.push(contextItemSignature(ci));
  for (const item of items || []) fp.push(itemSignature(item));
  return fp;
}

/**
 * Recover a fingerprint entry's content-length weight — the trailing `~<len>`
 * that itemSignature() encodes. Used to size the re-read slice by content, so a
 * bust that re-reads one big message weighs more than one that re-reads several
 * tiny ones. The tool-set entry ('tools:…', no `~<len>` tail) weighs 0: its real
 * cost lives in the tool definitions this module does not track, and a tool-set
 * change re-reads the whole history after it anyway, so item content dominates the
 * estimate either way.
 * @param {string|undefined} sig - A fingerprint entry
 * @returns {number} Its content-length weight (0 when none is encoded)
 */
function signatureWeight(sig) {
  if (typeof sig !== 'string') return 0;
  const i = sig.lastIndexOf('~');
  if (i < 0) return 0;
  const len = parseInt(sig.slice(i + 1), 10);
  return Number.isFinite(len) ? len : 0;
}

/**
 * Classify whether the next send re-reads a large slice of cached context, by
 * diffing the outgoing prefix fingerprint against the last-sent baseline and
 * sizing the re-read slice that the divergence creates.
 * @param {object} args
 * @param {string[]|null} args.baseline - Fingerprint captured at the last idle (null when none yet)
 * @param {string[]|null} args.current - Fingerprint of what the next send would build
 * @param {number} args.anchorTokens - Last turn's input tokens (0 when nothing anchored)
 * @returns {'none'|'busts-large'} Impact classification
 */
export function classifyContextCacheImpact({ baseline, current, anchorTokens }) {
  // No baseline (fresh bind / tools not resolved) → nothing cached to lose.
  if (!baseline || !current) return 'none';
  const n = baseline.length;
  // First index where the outgoing prefix diverges from the cached one.
  let d = 0;
  while (d < n && d < current.length && current[d] === baseline[d]) d++;
  // The re-read slice is the previously-cached region the divergence invalidates,
  // as re-sent by the outgoing transcript: current[d .. min(n, current.length)).
  // The min() bound is what makes append and truncation free without special
  // casing — an append leaves d === n (empty slice), and a truncation (/clear,
  // tail-delete) leaves d === current.length (empty slice), so neither re-reads
  // anything. Content past that bound is a genuinely new tail the cache never
  // held, not a re-read, so it is excluded.
  const overlapEnd = Math.min(n, current.length);
  let reReadChars = 0;
  for (let i = d; i < overlapEnd; i++) reReadChars += signatureWeight(current[i]);
  if (reReadChars === 0) return 'none';
  // Size the slice in tokens. anchorTokens measures the whole cached prefix, so
  // anchorTokens / (its content chars) is the last turn's token-per-char density;
  // apply it to the re-read slice's chars. This gates on the tokens actually
  // re-sent, so a bust is silent both when the divergence sits near the end (short
  // slice) and when the whole conversation is now small (few chars to re-read at
  // all) — e.g. right after a /clear.
  let baselineChars = 0;
  for (let i = 1; i < n; i++) baselineChars += signatureWeight(baseline[i]);
  const estReReadTokens = baselineChars > 0
    ? anchorTokens * (reReadChars / baselineChars)
    : 0;
  return estReReadTokens >= CONTEXT_CACHE_WARNING_TOKENS ? 'busts-large' : 'none';
}
