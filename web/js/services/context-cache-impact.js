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
 * exactly what was cached). Diff current vs baseline: a divergence within the
 * baseline's length means the cache busts from there; a pure append (a new user
 * message) diverges only past the end and costs nothing. Undo restores the
 * transcript, the fingerprint matches the baseline again, and the caution clears.
 * @module services/context-cache-impact
 */

/**
 * Bubbling event the strategy selector fires when its cache-impact
 * classification flips. The composer (input-box) owns the warning affordance —
 * a round alert beside the send button — so this signal is the only coupling
 * between the two: `detail.busts` is true when the next send would re-read a
 * large slice of cached context, false when it clears.
 * @type {string}
 */
export const CONTEXT_CACHE_IMPACT_CHANGED = 'context-cache-impact-changed';

/**
 * Last-turn input-token floor below which a bust is not worth cautioning about:
 * re-warming a small prefix next turn is cheap. Pure viewer UX — no exact
 * re-read figure is ever shown (a per-item token attribution would be wildly
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
 * Build the ordered prefix fingerprint: the tool-set signature followed by one
 * signature per history item.
 * @param {object} args
 * @param {string} args.toolsetSig - Sorted tool-name signature under the effective strategy
 * @param {Array<{get?: (key: string) => any}>} args.items - The thread's history items
 * @returns {string[]} The prefix fingerprint
 */
export function buildPrefixFingerprint({ toolsetSig, items }) {
  const fp = ['tools:' + (toolsetSig || '')];
  for (const item of items || []) fp.push(itemSignature(item));
  return fp;
}

/**
 * Classify whether the next send discards a large slice of cached context, by
 * diffing the outgoing prefix fingerprint against the last-sent baseline.
 * @param {object} args
 * @param {string[]|null} args.baseline - Fingerprint captured at the last idle (null when none yet)
 * @param {string[]|null} args.current - Fingerprint of what the next send would build
 * @param {number} args.anchorTokens - Last turn's input tokens (0 when nothing anchored)
 * @returns {'none'|'busts-large'} Impact classification
 */
export function classifyContextCacheImpact({ baseline, current, anchorTokens }) {
  // No baseline (fresh bind / tools not resolved) or no cache worth losing.
  if (!baseline || !current) return 'none';
  if (!(anchorTokens >= CONTEXT_CACHE_WARNING_TOKENS)) return 'none';
  // First index where the outgoing prefix diverges from the cached one.
  const n = baseline.length;
  let d = 0;
  while (d < n && d < current.length && current[d] === baseline[d]) d++;
  // Divergence inside the previously-cached region → the cache is invalidated
  // from d onward. A pure append leaves d === n (every cached element matched),
  // so nothing cached is lost.
  return d < n ? 'busts-large' : 'none';
}
