//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Compute the viewport pixel rect of a single character inside a <textarea>.
 *
 * A textarea exposes no DOM node for its caret or any individual glyph, so the
 * only way to find where a character paints is the well-worn "mirror div"
 * technique: build an off-screen div that copies every layout-affecting style
 * of the textarea, fill it with the same text up to the target index, and read
 * back the geometry of a span placed at that index. Because the mirror wraps
 * and breaks identically to the real control, the span lands exactly where the
 * glyph does.
 * @see web/js/components/file-completion-manager.js — anchors the `@-mention`
 *   dropdown horizontally to the `@` the user is typing over.
 */

/**
 * Style properties that influence where text lays out, copied from the real
 * textarea onto the mirror so wrapping/positioning match glyph-for-glyph.
 * @type {string[]}
 */
const MIRRORED_PROPERTIES = [
  'direction', 'boxSizing', 'width', 'height',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
  'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration',
  'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
];

/**
 * Return the viewport rect of the character at `index` in `textarea`.
 *
 * The returned `left`/`top` are the top-left of the glyph in viewport
 * coordinates (so they can feed `getBoundingClientRect`-style placement); the
 * textarea's own scroll offset is subtracted so a scrolled control still maps
 * correctly.
 * @param {HTMLTextAreaElement} textarea
 * @param {number} index - Character offset into `textarea.value`.
 * @returns {{ left: number, top: number, height: number }} Viewport-space glyph
 *   top-left and the line height.
 */
export function caretViewportRect(textarea, index) {
  const cs = window.getComputedStyle(textarea);

  const mirror = document.createElement('div');
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  for (const prop of MIRRORED_PROPERTIES) {
    // @ts-expect-error indexing CSSStyleDeclaration by property name
    mirror.style[prop] = cs[prop];
  }
  // The textarea's own height must not constrain the mirror, or a tall caret
  // index would clip; let it grow to whatever the wrapped text needs.
  mirror.style.height = 'auto';

  mirror.textContent = textarea.value.substring(0, index);
  const marker = document.createElement('span');
  // A non-empty marker guarantees a measurable box even at end-of-text.
  marker.textContent = textarea.value.substring(index) || '.';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const markerLeft = marker.offsetLeft;
  const markerTop = marker.offsetTop;
  mirror.remove();

  const taRect = textarea.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  return {
    left: taRect.left + markerLeft - textarea.scrollLeft,
    top: taRect.top + markerTop - textarea.scrollTop,
    height: lineHeight,
  };
}
