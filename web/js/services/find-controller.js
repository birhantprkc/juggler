//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { expandCollapsibleContaining } from '../utils/collapsible.js';

/**
 * Framework-free engine behind the "Find in conversation" (⌘F) bar. Given a
 * root element (a column's reversed `#message-list`), it walks the text nodes,
 * builds an ordered list of matches as DOM `Range`s, and paints them with the
 * CSS Custom Highlight API — never by wrapping matches in `<span>`s, because the
 * conversation renderer diffs and animates message elements and would clobber
 * injected wrapper nodes mid-stream. All DOM mutation is confined to the
 * highlight registry and a `scrollIntoView`, so the controller is safe to drive
 * from a tiny presentational find-bar component and is unit-testable in
 * isolation.
 *
 * The API (`setRoot`/`search`/`next`/`prev`/`refresh`/`clear` plus `total` and
 * `current` getters) is stable so the find-bar can rely on it verbatim. Every
 * mutating call returns a `{ total, current }` summary where `current` is a
 * 1-based index for display (0 when there are no matches).
 * @module services/find-controller
 */

/** Registry name for the full set of matches (the subtle highlight). */
const HL_ALL = 'find-match';
/** Registry name for the single active match (the strong highlight). */
const HL_CURRENT = 'find-match-current';

/**
 * @typedef {object} FindResult
 * @property {number} total - Number of matches for the current query.
 * @property {number} current - 1-based index of the active match, 0 when total is 0.
 */

/**
 * @typedef {object} FindOptions
 * @property {boolean} [caseSensitive] - Compare text as-is (default: false).
 * @property {boolean} [wholeWord] - Require non-word chars on both sides (default: false).
 */

/**
 * Whether `ch` is a word character `[A-Za-z0-9_]`. An empty string — used for a
 * boundary at a text node's edge — counts as a non-word char.
 * @param {string} ch - A single character, or '' at a text-node edge.
 * @returns {boolean} True when `ch` is a word character.
 */
function isWordChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 // _
  );
}

/**
 * The controller. One instance per find-bar; `setRoot` re-points it at whichever
 * conversation column currently owns the search.
 */
export default class FindController {
  /** @type {Element | null} The element searched within (a `#message-list`). */
  #root = null;
  /** @type {string} The last query, retained so `refresh` can re-run it. */
  #query = '';
  /** @type {Required<FindOptions>} The last normalised options. */
  #opts = { caseSensitive: false, wholeWord: false };
  /** @type {Range[]} Matches in document order. */
  #matches = [];
  /** @type {number} 0-based index of the active match (meaningless when empty). */
  #index = 0;
  /** @type {boolean} Whether the CSS Custom Highlight API is available. */
  #supported = false;

  constructor() {
    this.#supported =
      typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;
  }

  /** @returns {number} Total match count. */
  get total() {
    return this.#matches.length;
  }

  /** @returns {number} 1-based index of the active match, 0 when there are none. */
  get current() {
    return this.#matches.length ? this.#index + 1 : 0;
  }

  /**
   * Point the controller at the element to search within. Changing the root
   * clears all prior state and highlights; re-passing the same root is a no-op.
   * @param {Element | null} rootEl - Typically a column's `#message-list`.
   * @returns {void}
   */
  setRoot(rootEl) {
    if (rootEl === this.#root) return;
    this.clear();
    this.#root = rootEl || null;
  }

  /**
   * Recompute matches for `query`, repaint highlights, and pick the active match
   * as the first one at or after the previously-active position (else the
   * first match). An empty or whitespace-only query yields zero matches and
   * clears the highlights.
   * @param {string} query - The text to find.
   * @param {FindOptions} [opts] - Case-sensitivity and whole-word toggles.
   * @returns {FindResult} The updated match summary.
   */
  search(query, opts = {}) {
    this.#query = query || '';
    this.#opts = { caseSensitive: !!opts.caseSensitive, wholeWord: !!opts.wholeWord };
    const prev = this.#currentStartPoint();
    this.#matches = this.#computeMatches();
    this.#index = this.#indexAtOrAfter(prev);
    this.#paintAll();
    this.#paintCurrent();
    return this.#result();
  }

  /**
   * Advance to the next match, wrapping past the end back to the first.
   * @returns {FindResult} The updated match summary.
   */
  next() {
    return this.#step(1);
  }

  /**
   * Step to the previous match, wrapping past the start back to the last.
   * @returns {FindResult} The updated match summary.
   */
  prev() {
    return this.#step(-1);
  }

  /**
   * Re-run the last query/options after the conversation mutated (e.g. streaming
   * appended text). The active match is preserved by identity — the match whose
   * start container and offset still exist — otherwise the index is clamped to
   * the nearest valid position.
   * @returns {FindResult} The updated match summary.
   */
  refresh() {
    const prev = this.#currentStartPoint();
    this.#matches = this.#computeMatches();
    if (this.#matches.length === 0) {
      this.#index = 0;
    } else {
      let idx = -1;
      if (prev) {
        idx = this.#matches.findIndex(
          (r) => r.startContainer === prev.node && r.startOffset === prev.offset,
        );
      }
      if (idx === -1) idx = Math.min(this.#index, this.#matches.length - 1);
      this.#index = Math.max(0, idx);
    }
    this.#paintAll();
    this.#paintCurrent();
    return this.#result();
  }

  /**
   * Remove both highlights and reset all state (query, matches, active index).
   * @returns {void}
   */
  clear() {
    this.#query = '';
    this.#matches = [];
    this.#index = 0;
    if (this.#supported) {
      this.#registry.delete(HL_ALL);
      this.#registry.delete(HL_CURRENT);
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The CSS Custom Highlight registry, typed loosely because its `set`/`delete`
   * are newer than the DOM lib we type-check against. Only touch it behind the
   * {@link #supported} guard.
   * @returns {any} The `CSS.highlights` registry.
   */
  get #registry() {
    return CSS.highlights;
  }

  /** @returns {FindResult} The current match summary. */
  #result() {
    const total = this.#matches.length;
    return { total, current: total ? this.#index + 1 : 0 };
  }

  /**
   * Move the active index by `dir` with wrap-around, repaint just the current
   * highlight, and scroll it into view.
   * @param {number} dir - +1 for next, -1 for prev.
   * @returns {FindResult} The updated match summary.
   */
  #step(dir) {
    const total = this.#matches.length;
    if (!total) return this.#result();
    this.#index = (this.#index + dir + total) % total;
    this.#paintCurrent();
    this.#scrollToCurrent();
    return this.#result();
  }

  /**
   * The active match's start boundary, captured before a recompute so the new
   * active match can be chosen relative to it.
   * @returns {{ node: Node, offset: number } | null} The start boundary, or null when there is no active match.
   */
  #currentStartPoint() {
    const cur = this.#matches[this.#index];
    if (!cur) return null;
    return { node: cur.startContainer, offset: cur.startOffset };
  }

  /**
   * Index of the first match whose start is at or after `point`, or 0 when
   * `point` is null or lies past every match.
   * @param {{ node: Node, offset: number } | null} point - The boundary to seek from.
   * @returns {number} The chosen active-match index.
   */
  #indexAtOrAfter(point) {
    if (!point || this.#matches.length === 0) return 0;
    for (let i = 0; i < this.#matches.length; i++) {
      const r = this.#matches[i];
      if (!r) continue;
      if (this.#comparePoints(r.startContainer, r.startOffset, point.node, point.offset) >= 0) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Compare two (node, offset) boundary points in document order.
   * @param {Node} n1 - First boundary's node.
   * @param {number} o1 - First boundary's offset.
   * @param {Node} n2 - Second boundary's node.
   * @param {number} o2 - Second boundary's offset.
   * @returns {number} -1 if the first is before the second, 0 if equal, 1 if after.
   */
  #comparePoints(n1, o1, n2, o2) {
    const a = document.createRange();
    a.setStart(n1, o1);
    a.collapse(true);
    const b = document.createRange();
    b.setStart(n2, o2);
    b.collapse(true);
    return a.compareBoundaryPoints(Range.START_TO_START, b);
  }

  /**
   * Walk every text node under the root and collect a `Range` per occurrence of
   * the query. Matching is per-text-node (matches spanning element boundaries
   * are out of scope); occurrences are found by scanning `indexOf`, then filtered
   * by the whole-word boundary test when enabled.
   * @returns {Range[]} The matches in document order.
   */
  #computeMatches() {
    const root = this.#root;
    const q = this.#query;
    /** @type {Range[]} */
    const matches = [];
    if (!root || !q || !q.trim()) return matches;

    const { caseSensitive, wholeWord } = this.#opts;
    const needle = caseSensitive ? q : q.toLowerCase();
    const step = needle.length; // non-empty here, so the scan always advances

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        this.#isSearchable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });

    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue;
      if (!raw) continue;
      const hay = caseSensitive ? raw : raw.toLowerCase();
      let from = 0;
      for (;;) {
        const i = hay.indexOf(needle, from);
        if (i === -1) break;
        const end = i + step;
        if (!wholeWord || this.#isWholeWord(raw, i, end)) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, end);
          matches.push(range);
        }
        from = i + step;
      }
    }
    return matches;
  }

  /**
   * Whether a text node should be searched. Skips content inside SCRIPT/STYLE or
   * inside an element hidden via the `hidden` attribute or `aria-hidden="true"`.
   * Overflow-clipped (merely off-screen) content is intentionally NOT skipped —
   * `offsetParent`-style visibility checks are unreliable in the reversed,
   * overflow-clipped conversation layout.
   * @param {Node} node - The text node to test.
   * @returns {boolean} True when the node's text should be searched.
   */
  #isSearchable(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      if (el === this.#root) break;
    }
    return true;
  }

  /**
   * Whole-word test for the substring at `[start, end)` in `text`: the char
   * before `start` and the char at `end` must both be non-word chars (edges of
   * the text count as non-word).
   * @param {string} text - The text node's value.
   * @param {number} start - Inclusive start offset of the match.
   * @param {number} end - Exclusive end offset of the match.
   * @returns {boolean} True when the substring stands as a whole word.
   */
  #isWholeWord(text, start, end) {
    const before = start > 0 ? text.charAt(start - 1) : '';
    const after = end < text.length ? text.charAt(end) : '';
    return !isWordChar(before) && !isWordChar(after);
  }

  /**
   * Register (or clear) the full-set highlight. No-op when the Highlight API is
   * unavailable — matching and scrolling still work, only the paint is skipped.
   * @returns {void}
   */
  #paintAll() {
    if (!this.#supported) return;
    if (this.#matches.length) {
      this.#registry.set(HL_ALL, new Highlight(...this.#matches));
    } else {
      this.#registry.delete(HL_ALL);
    }
  }

  /**
   * Register (or clear) the single active-match highlight, given a higher paint
   * priority so it wins over the overlapping full-set highlight.
   * @returns {void}
   */
  #paintCurrent() {
    if (!this.#supported) return;
    const cur = this.#matches[this.#index];
    if (cur) {
      const hi = new Highlight(cur);
      hi.priority = 1;
      this.#registry.set(HL_CURRENT, hi);
    } else {
      this.#registry.delete(HL_CURRENT);
    }
  }

  /**
   * Reveal and scroll the active match into view: expand any collapsed
   * collapsible around it first (so a clamped-away match becomes visible), then
   * reuse `conversation-area`'s smooth, centred `scrollIntoView`.
   * @returns {void}
   */
  #scrollToCurrent() {
    const cur = this.#matches[this.#index];
    if (!cur) return;
    const sc = cur.startContainer;
    const el = sc.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (sc) : sc.parentElement;
    if (!el) return;
    expandCollapsibleContaining(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
