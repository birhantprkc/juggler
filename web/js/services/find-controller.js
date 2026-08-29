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
 * injected wrapper nodes mid-stream. DOM mutation is confined to the highlight
 * registry, un-clipping whatever hides the active match (a collapsed
 * collapsible) and the scroll offsets that reveal it, so the controller is
 * safe to drive from a tiny presentational
 * find-bar component and is unit-testable in isolation.
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
  /** @type {boolean} Whether the active match has been scrolled to since the last search. */
  #revealed = false;
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
    this.#revealed = false;
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
    this.#revealed = false;
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
   *
   * The first navigation after a search reveals the match already marked active
   * rather than moving off it. `search` picks an active match and paints it but
   * deliberately doesn't scroll (that would yank the view on every keystroke of
   * a debounced query), so stepping straight away would jump the counter from
   * "1 of 9" to "2 of 9" having never shown the user where match 1 was.
   * @param {number} dir - +1 for next, -1 for prev.
   * @returns {FindResult} The updated match summary.
   */
  #step(dir) {
    const total = this.#matches.length;
    if (!total) return this.#result();
    if (this.#revealed) this.#index = (this.#index + dir + total) % total;
    this.#revealed = true;
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
   * Whether a text node should be searched. Skips content inside SCRIPT/STYLE and
   * anything display-hidden: the `hidden` attribute, `aria-hidden="true"`, the
   * `.hidden` utility class, or an inline `display: none`. The message list
   * permanently carries hidden chrome (the footer's Stop/Undo/Pause controls, the
   * thread column actions), and counting text nobody can see makes the match
   * total disagree with what the highlights show.
   *
   * Content that is merely clipped — an `is-collapsed` collapsible — IS searched:
   * it is real conversation text, and {@link #revealCurrent} un-clips it on the
   * way to the match. `offsetParent`/`getComputedStyle` checks are deliberately
   * avoided here: the walk runs on every keystroke and every streaming refresh,
   * and forcing layout per text node would cost more than the whole search.
   * @param {Node} node - The text node to test.
   * @returns {boolean} True when the node's text should be searched.
   */
  #isSearchable(node) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return false;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.classList.contains('hidden')) return false;
      if (/** @type {HTMLElement} */ (el).style?.display === 'none') return false;
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
   * Reveal the active match: un-clip everything hiding it, then scroll it into
   * view. Both halves work on the match's own geometry, not its element's — a
   * long paste is a single text node in a single box, so anything that reveals
   * the box parks a match near its end far off-screen.
   * @returns {void}
   */
  #scrollToCurrent() {
    const cur = this.#matches[this.#index];
    if (!cur) return;
    const sc = cur.startContainer;
    const el = sc.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (sc) : sc.parentElement;
    if (!el) return;
    this.#unclip(el);
    const rect = this.#matchRect(cur, el);
    if (!rect) return;
    this.#revealHorizontally(el, rect);
    this.#revealVertically(rect);
  }

  /**
   * Give the match a box to occupy. A collapsed `.collapsible` clamp (a long user
   * message or thread summary showing its first 15rem behind a "Show more") hides
   * the match without being a reason to have excluded it from the match set, so it
   * is expanded via the shared helper, keeping the toggle and its persisted state
   * in step.
   * @param {Element} el - The element containing the match's start.
   * @returns {void}
   */
  #unclip(el) {
    expandCollapsibleContaining(el);
  }

  /**
   * The active match's box in viewport coordinates, falling back to its first
   * client rect (a match wrapped across lines) and then to its element's box (a
   * match with no rects of its own).
   * @param {Range} range - The active match.
   * @param {Element} el - The element containing the match's start.
   * @returns {DOMRect | null} The rect to reveal, or null when nothing has a box.
   */
  #matchRect(range, el) {
    const whole = range.getBoundingClientRect();
    if (whole && (whole.width || whole.height)) return whole;
    const first = range.getClientRects?.()?.[0];
    if (first && (first.width || first.height)) return first;
    const box = el.getBoundingClientRect();
    return box.width || box.height ? box : null;
  }

  /**
   * Scroll the root (a column's `#message-list`) so the match is on screen,
   * centring it when it isn't. Direct clamped `scrollTop` maths, never
   * `Element.scrollIntoView`: scrollTop is container-scoped, so it can neither
   * overshoot nor drag an ancestor along — `scrollIntoView`'s default
   * `inline: 'nearest'` would also slide the horizontal column container, and at
   * phone widths that fights the container's scroll snap. The reversed scroller's
   * scrollTop still increases toward the content end, so a viewport-space delta
   * applies unchanged. Instant, not smooth: holding Enter through a dozen matches
   * shouldn't queue a dozen glides.
   * @param {DOMRect} rect - The match's box, in viewport coordinates.
   * @returns {void}
   */
  #revealVertically(rect) {
    const root = /** @type {Element|null} */ (this.#root);
    if (!root) return;
    const view = root.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    const delta = rect.top + rect.height / 2 - (view.top + view.height / 2);
    root.scrollTo({ top: root.scrollTop + delta, behavior: 'instant' });
  }

  /**
   * Bring the match in from the side when it sits inside a horizontal scroller —
   * a long line in a code block, a wide table. Only the nearest such ancestor
   * below the root moves, and only one that genuinely scrolls: a `.collapsible`
   * clamp overflows too, but it clips rather than scrolls, and nudging its
   * scrollLeft would shift content the user never asked to move.
   * @param {Element} el - The element containing the match's start.
   * @param {DOMRect} rect - The match's box, in viewport coordinates.
   * @returns {void}
   */
  #revealHorizontally(el, rect) {
    for (let a = /** @type {Element|null} */ (el); a && a !== this.#root; a = a.parentElement) {
      if (a.scrollWidth <= a.clientWidth + 1) continue;
      const overflowX = getComputedStyle(a).overflowX;
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      const box = a.getBoundingClientRect();
      let delta = 0;
      if (rect.left < box.left) delta = rect.left - box.left;
      else if (rect.right > box.right) delta = rect.right - box.right;
      if (delta) a.scrollTo({ left: a.scrollLeft + delta, behavior: 'instant' });
      return;
    }
  }
}
