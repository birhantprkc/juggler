//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Incremental renderer for text that arrives by growing.
 *
 * Rendering a stream by re-parsing the whole accumulated string on each update
 * costs O(length) per update, which over a block that arrives in many updates
 * is quadratic — the reason a long reasoning block used to make the UI stutter
 * for as long as it took to arrive. This splits the text at Markdown block
 * boundaries instead: everything before the last boundary is SEALED (parsed
 * once, then left alone in the DOM) and only the tail after it is re-parsed as
 * it grows. Each update then costs O(tail), and a tail is one paragraph.
 *
 * A boundary is only taken where appending more text cannot change what has
 * already been rendered: a blank line, outside any open fence, whose preceding
 * block is not one that more text could continue (a list, a blockquote, a
 * table, an indented code block). Text with no such boundary — one very long
 * unbroken paragraph — simply never seals, and degrades to re-parsing the
 * whole thing, exactly as before. Link reference definitions reach backwards
 * (a `[x]: url` line can change a link rendered paragraphs earlier), so the
 * first one seen turns sealing off for the rest of the stream.
 *
 * The text is assumed to only ever GROW at the end. A rewrite of the sealed
 * prefix is detected by fingerprint and answered with a full re-render.
 * @module utils/streaming-markdown
 */

import { renderMarkdown, looksLikeMarkdown, decorateCodeBlocks } from '../../sdk/lib/markdown.js';

/** Opens or closes a fenced code block; the capture is the fence marker. */
const FENCE_RE = /^ {0,3}(```|~~~)/;

/**
 * A block that a blank line does NOT necessarily end: another list item,
 * quote line, table row or indented code line after the blank continues the
 * same construct, and sealing between them would split it in two.
 */
const CONTINUABLE_RE = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]|^ {0,3}>|^ {0,3}\||^(?:\t| {4,})\S/;

/** A link reference definition, whose effect reaches back over the whole document. */
const REF_DEF_RE = /^ {0,3}\[[^\]\n]+\]:/;

/** Characters of already-sealed text kept to detect a rewritten prefix. */
const FINGERPRINT_LEN = 64;

/**
 * Characters re-tested for Markdown constructs behind the newly arrived text.
 * A construct can straddle the join (a table is a header line plus a separator
 * line), so the detector never starts exactly where the last one stopped.
 */
const DETECT_OVERLAP = 512;

/**
 * The end of the longest prefix of `text` that can be parsed now and never
 * revisited, searching from `from` (which must be at a line start).
 * @param {string} text - The full accumulated text.
 * @param {number} from - Index to scan from; everything before it is sealed.
 * @returns {{seal: number, refDef: boolean}} New seal point (>= from), and
 *   whether a link reference definition appeared in the scanned region.
 */
export function findSealPoint(text, from) {
  /** The marker that opened the fence we are inside, or '' when outside one. */
  let fence = '';
  let refDef = false;
  let seal = from;
  let lastContentLine = '';
  let i = from;

  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    // A line with no newline yet is still arriving, so it can never be sealed.
    if (nl === -1) break;
    const line = text.slice(i, nl);
    i = nl + 1;

    const opener = FENCE_RE.exec(line)?.[1];
    // Only the marker that opened a fence can close it, so a ~~~ inside a ```
    // block doesn't hand us a seal point in the middle of the code.
    if (opener && (!fence || opener === fence)) {
      fence = fence ? '' : opener;
      lastContentLine = line;
      continue;
    }
    if (fence) continue;
    if (REF_DEF_RE.test(line)) refDef = true;

    if (line.trim() === '') {
      if (lastContentLine && !CONTINUABLE_RE.test(lastContentLine)) seal = i;
    } else {
      lastContentLine = line;
    }
  }

  return { seal, refDef };
}

/**
 * Render growing text into `host`, re-parsing only what is still in flight.
 *
 * `host`'s class is set to `markdown` or `plain` per update: reasoning arrives
 * either as a Markdown summary or as raw prose, and prose rendered as Markdown
 * loses its stray `*`/`_`/`#` to formatting. The decision is re-made as the
 * text grows (so a block whose first construct arrives late switches then) but
 * never reverses, because append-only text cannot lose a construct it has.
 * @param {HTMLElement} host - Element to render into. Owned entirely by this.
 * @param {object} [options] - Rendering options.
 * @param {boolean} [options.escapeXml=true] - Passed to renderMarkdown.
 * @param {boolean} [options.detect=true] - Choose between Markdown and verbatim
 *   per update. False renders as Markdown always, for a source that is known to
 *   be Markdown (an assistant reply) rather than possibly raw prose.
 * @returns {{update: (text: string) => void, reset: () => void}} Controller.
 */
export function createStreamingMarkdown(host, options = {}) {
  const { escapeXml = true, detect = true } = options;

  /** @type {'markdown'|'plain'|null} */
  let mode = null;
  /** Index in the text up to which the DOM is sealed. */
  let sealedUpTo = 0;
  /** Tail of the sealed text, to catch a prefix that was rewritten. */
  let fingerprint = '';
  /** Set once a link reference definition is seen; sealing stops for good. */
  let refDefSeen = false;
  /** Marker separating the sealed nodes from the re-parsed tail. */
  /** @type {Comment|null} */
  let marker = null;
  /** How much of the text the Markdown detector has already looked at. */
  let detectedUpTo = 0;

  const reset = () => {
    mode = null;
    sealedUpTo = 0;
    fingerprint = '';
    refDefSeen = false;
    marker = null;
    detectedUpTo = 0;
    host.replaceChildren();
  };

  /**
   * Whether the text contains a Markdown construct, testing only what has
   * newly arrived once the answer so far is "no". Latches on.
   * @param {string} text - The full accumulated text.
   * @returns {boolean} True once a construct has appeared.
   */
  const isMarkdown = (text) => {
    if (!detect || mode === 'markdown') return true;
    // Start at a line start, or a pattern anchored to `^` would match the
    // middle of a line the last pass already cleared.
    const back = Math.max(0, detectedUpTo - DETECT_OVERLAP);
    const from = back === 0 ? 0 : text.lastIndexOf('\n', back) + 1;
    detectedUpTo = text.length;
    return looksLikeMarkdown(text.slice(from));
  };

  /**
   * Parse a segment and hand back its nodes, already decorated, in a detached
   * holder. Decorating before insertion keeps the pass proportional to the new
   * segment rather than to everything rendered so far.
   * @param {string} md - Markdown source for one or more whole blocks.
   * @returns {HTMLElement} Holder whose children are the rendered nodes.
   */
  const parse = (md) => {
    const holder = document.createElement('div');
    holder.innerHTML = renderMarkdown(md, { escapeXml });
    decorateCodeBlocks(holder);
    return holder;
  };

  /**
   * @param {HTMLElement} holder - Holder from parse().
   * @param {Node|null} before - Insert before this node, or append at the end.
   */
  const moveInto = (holder, before) => {
    while (holder.firstChild) host.insertBefore(holder.firstChild, before);
  };

  /** @param {string} text - Full text; renders it from scratch as Markdown. */
  const renderWhole = (text) => {
    host.replaceChildren();
    marker = document.createComment('live');
    host.appendChild(marker);
    moveInto(parse(text), null);
    sealedUpTo = 0;
    fingerprint = '';
  };

  /** @param {string} text - Full text; shown verbatim, appending the delta. */
  const renderPlain = (text) => {
    const first = host.firstChild;
    if (mode === 'plain' && first && first.nodeType === Node.TEXT_NODE && host.childNodes.length === 1) {
      const existing = /** @type {Text} */ (first);
      if (text.startsWith(existing.data)) {
        existing.appendData(text.slice(existing.data.length));
        return;
      }
    }
    host.replaceChildren(document.createTextNode(text));
  };

  return {
    reset,

    /** @param {string} text - The full accumulated text, so far. */
    update(text) {
      const wantMarkdown = isMarkdown(text);
      const wantMode = wantMarkdown ? 'markdown' : 'plain';

      if (wantMode === 'plain') {
        renderPlain(text);
        mode = 'plain';
        host.className = 'plain';
        return;
      }

      // Entering Markdown mode (from nothing, or from verbatim prose) starts
      // the sealed/live split over.
      const restart = mode !== 'markdown' || !marker
        || text.length < sealedUpTo
        || text.slice(sealedUpTo - fingerprint.length, sealedUpTo) !== fingerprint;

      mode = 'markdown';
      host.className = 'markdown';

      if (restart) {
        renderWhole(text);
        return;
      }

      const live = /** @type {Comment} */ (marker);
      while (live.nextSibling) live.nextSibling.remove();

      if (!refDefSeen) {
        const { seal, refDef } = findSealPoint(text, sealedUpTo);
        if (refDef) {
          // A definition can retarget a link rendered long before it, so what
          // was sealed may now be wrong: re-parse the lot, and stop sealing.
          refDefSeen = true;
          renderWhole(text);
          return;
        }
        if (seal > sealedUpTo) {
          moveInto(parse(text.slice(sealedUpTo, seal)), live);
          sealedUpTo = seal;
          fingerprint = text.slice(Math.max(0, seal - FINGERPRINT_LEN), seal);
        }
      }

      moveInto(parse(text.slice(sealedUpTo)), null);
    },
  };
}
