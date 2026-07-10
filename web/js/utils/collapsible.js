//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { EXPAND_MORE_SVG, EXPAND_LESS_SVG } from './icons.js';

/**
 * Collapse/expand affordance for oversized conversation items (an extremely
 * long user message, a long thread summary). The clamped content fades out at
 * the bottom via a CSS mask and a subtle, full-width "Show more" toggle is
 * inserted directly below it. Nothing is added when the content isn't tall
 * enough to be in the way, so ordinary-length items render untouched.
 * @module collapsible
 */

/** 18rem — the clamp height; matches `.collapsible.is-collapsed` in styles.css. */
const DEFAULT_THRESHOLD_PX = 18 * 16;

/**
 * Don't bother clamping content that only just clears the threshold — hiding a
 * line or two behind a toggle is more annoying than just showing it.
 */
const SLACK_PX = 24;

/**
 * Expanded/collapsed state keyed by a caller-supplied stable id, so a user's
 * choice survives the item being re-rendered (thread tiles in particular
 * repaint their summary in place). Module-level, cleared only on reload — the
 * set of expanded items is tiny.
 * @type {Map<string, boolean>}
 */
const expandedState = new Map();

/**
 * Clamp `contentEl` and attach a Show more / Show less toggle when — and only
 * when — its natural height exceeds the threshold. Idempotent: safe to call on
 * every render of the same element; a previously-inserted toggle is removed and
 * the clamp classes are reset before re-measuring, so a repaint (e.g. a thread
 * summary whose text changed) re-evaluates cleanly.
 *
 * The element MUST already be attached to the document when this is called —
 * height is measured via `scrollHeight`, which needs live layout.
 * @param {HTMLElement} contentEl - The content block to clamp (e.g. the message
 *   text div or the `.thread-summary`). The toggle is inserted as its next
 *   sibling, so `contentEl`'s parent should lay its children out in a column.
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.key] - Stable id used to remember the expanded state
 *   across re-renders. Omit for ephemeral items (state defaults to collapsed).
 * @param {number} [opts.thresholdPx] - Override the clamp height in pixels.
 */
export function applyCollapsible(contentEl, { key = '', thresholdPx = DEFAULT_THRESHOLD_PX } = {}) {
  if (!contentEl || !contentEl.isConnected) return;

  // Drop a toggle we added on a previous pass and clear our classes, so the
  // natural height we measure below is the true unclamped height.
  const prior = contentEl.nextElementSibling;
  if (prior && prior.classList.contains('collapsible-toggle')) prior.remove();
  contentEl.classList.remove('collapsible', 'is-collapsed', 'is-expanded');

  if (contentEl.scrollHeight <= thresholdPx + SLACK_PX) return;

  contentEl.classList.add('collapsible');
  // Stamp the key onto the element so `expandCollapsibleContaining` can recover
  // it and persist an auto-expand into `expandedState` (see below). Purely
  // additive — the clamp/toggle behaviour is unchanged.
  if (key) contentEl.dataset.collapsibleKey = key;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'collapsible-toggle';

  let expanded = key ? expandedState.get(key) === true : false;

  const paint = () => {
    contentEl.classList.toggle('is-collapsed', !expanded);
    contentEl.classList.toggle('is-expanded', expanded);
    btn.innerHTML =
      (expanded ? EXPAND_LESS_SVG : EXPAND_MORE_SVG) +
      `<span>${expanded ? 'Show less' : 'Show more'}</span>`;
    btn.setAttribute('aria-expanded', String(expanded));
  };
  paint();

  btn.addEventListener('click', (e) => {
    // Keep this a pure toggle — don't let the click bubble to the
    // conversation-area selection handler.
    e.stopPropagation();
    expanded = !expanded;
    if (key) expandedState.set(key, expanded);
    paint();
  });

  contentEl.after(btn);
}

/**
 * Expand the nearest collapsed collapsible that contains `node`, if any, so a
 * match buried inside a clamped block (e.g. found by ⌘F) can be scrolled to and
 * seen. Walks up from `node` to the closest `.collapsible.is-collapsed`
 * ancestor and, if found, replays exactly what the internal toggle does on
 * expand: flip `is-collapsed`→`is-expanded` and repaint the adjacent
 * `.collapsible-toggle` into its "Show less" state. If the collapsible carries a
 * `key` (stamped as `dataset.collapsibleKey` by {@link applyCollapsible}), the
 * expanded state is also recorded in `expandedState`, so a later repaint keeps
 * it open rather than snapping shut.
 * @param {Node | null} node - Any node inside (or equal to) the collapsible.
 * @returns {boolean} True if a collapsed collapsible was expanded, else false.
 */
export function expandCollapsibleContaining(node) {
  const startEl = /** @type {Element | null} */ (
    node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement ?? null
  );
  const contentEl = /** @type {HTMLElement | null} */ (
    startEl?.closest('.collapsible.is-collapsed') ?? null
  );
  if (!contentEl) return false;

  contentEl.classList.remove('is-collapsed');
  contentEl.classList.add('is-expanded');

  const btn = contentEl.nextElementSibling;
  if (btn && btn.classList.contains('collapsible-toggle')) {
    btn.innerHTML = EXPAND_LESS_SVG + '<span>Show less</span>';
    btn.setAttribute('aria-expanded', 'true');
  }

  const key = contentEl.dataset.collapsibleKey;
  if (key) expandedState.set(key, true);

  return true;
}
