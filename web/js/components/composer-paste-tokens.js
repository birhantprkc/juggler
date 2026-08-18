//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * composer-paste-tokens — the composer's pasted-text placeholder tokens, for
 * composer.js.
 *
 * A large paste collapses into an inline placeholder token — a run of ordinary
 * characters (invisible delimiters bracketing a visible label) that behaves as
 * text in every way (undoable, single-backspace-deletable, selectable,
 * copyable) yet renders as a styled pill. The full content lives in the
 * append-only `_pasteBlobs` table and is inlined at its exact position at send
 * time, so the model/stored message is identical to a plain paste. See
 * utils/paste-tokens.js for the grammar and the pure helpers.
 *
 * This module owns the composer-side machinery: the capture thresholds, the
 * atomic-token editing rules (a token is deleted whole, never entered), the
 * clipboard expansion on copy/cut, and the mirror overlay that draws the pill
 * behind the textarea.
 *
 * Each function takes the Composer element as its first argument and reads or
 * writes its state through it, mirroring conversation-area-rendering.js.
 * @module components/composer-paste-tokens
 */

import {
  makeToken,
  parseTokens,
  hasTokens,
  expandPasteTokens,
  nextId as nextPasteId,
  stripStrayDelimiters,
  PASTE_TOKEN_OPEN,
  PASTE_TOKEN_CLOSE
} from '../utils/paste-tokens.js';
import { looksBinary } from './composer-attachments.js';

/**
 * A pasted-text payload at or above EITHER threshold is captured into an inline
 * placeholder token instead of flooding the textarea: ~2,500 characters (about
 * one screenful) or 40 lines. Below both, the paste lands as ordinary text
 * exactly as before. Tuned by feel — a modest snippet stays inline; a source
 * file or a long log collapses to a chip.
 */
const PASTE_CHIP_MIN_CHARS = 2_500;

/** Line-count companion to {@link PASTE_CHIP_MIN_CHARS}. */
const PASTE_CHIP_MIN_LINES = 40;

/**
 * Whether a pasted text payload is large enough to capture into a placeholder
 * token rather than land as ordinary text. Either threshold trips it; a
 * payload that decodes as binary is also captured (defensive — don't flood the
 * box with mojibake).
 * @param {string} text
 * @returns {boolean} True to capture, false to paste normally.
 */
export function shouldCapturePaste(text) {
  if (looksBinary(text)) return true;
  if (text.length >= PASTE_CHIP_MIN_CHARS) return true;
  // Count newlines rather than splitting (cheaper on a big blob).
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines >= PASTE_CHIP_MIN_LINES;
}

/**
 * UTF-8 byte size of a string, for the token label.
 * @param {string} str
 * @returns {number} Byte length.
 */
function pasteByteLength(str) {
  try { return new Blob([str]).size; } catch { return str.length; }
}

/**
 * Capture `content` as an inline placeholder: allocate (or reuse, on an exact
 * content match) a token id, store the blob, and insert the token string at
 * the caret. The insert goes through the native editing path so Cmd+Z undoes
 * the capture as one edit; the blob stays in the append-only table until GC.
 * @param {any} composer - Composer instance
 * @param {string} content
 */
export function capturePaste(composer, content) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return;
  const bytes = pasteByteLength(content);
  // Dedup: identical content already captured reuses that id (double-paste
  // gives two tokens sharing one blob; both expand at send). Exact === only.
  let id = null;
  for (const [existingId, blob] of composer._pasteBlobs) {
    if (blob.content === content) { id = existingId; break; }
  }
  if (id === null) {
    id = nextPasteId(textarea.value, composer._pasteBlobs);
    composer._pasteBlobs.set(id, { content, bytes });
  }
  insertAtCaret(composer, textarea, makeToken(id, bytes));
  afterTokenMutation(composer, textarea);
}

/**
 * Insert `text` at the caret, preferring the native undoable path
 * (execCommand) and falling back to a direct value splice where the host
 * rejects the command (older engines, headless test window). Leaves the caret
 * after the inserted text.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 */
function insertAtCaret(composer, textarea, text) {
  textarea.focus();
  const before = textarea.value;
  // Baseline the reconciler to the pre-insert value: execCommand fires `input`
  // synchronously below, and it must compare against what the box holds NOW —
  // never a stale base that would make it revert this trusted insert.
  composer._pasteLastValue = before;
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (ok && textarea.value !== before) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = before.slice(0, start) + text + before.slice(end);
  const pos = start + text.length;
  try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
}

/**
 * Delete the `[start, end)` character range, preferring the native undoable
 * path (select + execCommand('delete')) with a direct-splice fallback.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {number} start
 * @param {number} end
 */
function deleteRange(composer, textarea, start, end) {
  textarea.focus();
  const before = textarea.value;
  // Baseline the reconciler to the pre-delete value (see _insertAtCaret): the
  // token in [start, end) is fully inside the change, so the delete reads as
  // legitimate rather than a partial-interior edit to revert.
  composer._pasteLastValue = before;
  try { textarea.setSelectionRange(start, end); } catch { /* non-fatal */ }
  let ok = false;
  try { ok = document.execCommand('delete', false); } catch { ok = false; }
  if (!ok || textarea.value === before) {
    textarea.value = before.slice(0, start) + before.slice(end);
    try { textarea.setSelectionRange(start, start); } catch { /* non-fatal */ }
  }
  afterTokenMutation(composer, textarea);
}

/**
 * Replace a token with its full content in place (undoable). Cmd+Z afterwards
 * restores the placeholder: the token characters come back and the append-only
 * table still resolves them.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
 */
function expandToken(composer, textarea, tok) {
  const entry = composer._pasteBlobs.get(tok.id);
  const content = entry ? entry.content : tok.text.slice(1, -1);
  textarea.focus();
  try { textarea.setSelectionRange(tok.start, tok.end); } catch { /* non-fatal */ }
  const before = textarea.value;
  // Baseline the reconciler to the pre-expand value (see _insertAtCaret): the
  // token is fully inside the replaced range, so expansion reads as legitimate.
  composer._pasteLastValue = before;
  let ok = false;
  try { ok = document.execCommand('insertText', false, content); } catch { ok = false; }
  if (!ok || textarea.value === before) {
    textarea.value = before.slice(0, tok.start) + content + before.slice(tok.end);
    const pos = tok.start + content.length;
    try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
  }
  afterTokenMutation(composer, textarea);
}

/**
 * Atomicity for placeholder tokens under Backspace/Delete/Arrow keys. Returns
 * true (and prevents the default) when it acted on a token, false to let the
 * key behave normally. A fast no-op when the text holds no tokens.
 * @param {any} composer - Composer instance
 * @param {KeyboardEvent} e
 * @param {HTMLTextAreaElement} textarea
 * @returns {boolean} Whether the key was handled as a token operation.
 */
export function handleTokenKeydown(composer, e, textarea) {
  const key = e.key;
  if (key !== 'Backspace' && key !== 'Delete' && key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  const value = textarea.value;
  if (!hasTokens(value)) return false;
  const collapsed = textarea.selectionStart === textarea.selectionEnd;
  if (!collapsed) return false; // selection-based edits: snapping keeps endpoints out
  const p = textarea.selectionStart;
  const tokens = parseTokens(value);

  if (key === 'Backspace' || key === 'Delete') {
    // Shift/Ctrl deletes keep native behaviour (the reconciler backstops any
    // partial cut). A plain, word (Alt) or line (Meta) delete that ABUTS a
    // token in the delete direction would otherwise chew into the label, so
    // remove the whole token as one unit instead.
    if (e.shiftKey || e.ctrlKey) return false;
    const tok = key === 'Backspace'
      ? tokens.find((t) => t.end === p)
      : tokens.find((t) => t.start === p);
    if (!tok) return false;
    e.preventDefault();
    deleteRange(composer, textarea, tok.start, tok.end);
    return true;
  }

  // Plain arrows skip a token as one unit. Modified arrows (word/line move,
  // shift-select) fall through to native motion; the selection-snapper then
  // bounces any caret/endpoint that landed inside a token back to a boundary.
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const tok = key === 'ArrowLeft'
    ? tokens.find((t) => t.end === p)
    : tokens.find((t) => t.start === p);
  if (!tok) return false;
  e.preventDefault();
  const to = key === 'ArrowLeft' ? tok.start : tok.end;
  try { textarea.setSelectionRange(to, to); } catch { /* non-fatal */ }
  composer._pasteLastCaret = to;
  return true;
}

/**
 * copy/cut handler: when the selection contains any token, write the EXPANDED
 * text (tokens replaced by their content) to the clipboard and, for cut,
 * delete the selection undoably. When the selection holds no token the browser
 * does its normal thing. This keeps sentinel characters from ever leaving the
 * composer — a paste back into another Juggler box re-captures naturally.
 * @param {any} composer - Composer instance
 * @param {ClipboardEvent} e
 * @param {HTMLTextAreaElement} textarea
 * @param {boolean} isCut
 */
export function onClipboardCopyCut(composer, e, textarea, isCut) {
  if (composer._pasteBlobs.size === 0) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) return;
  const selected = textarea.value.slice(start, end);
  if (!hasTokens(selected)) return;
  if (!e.clipboardData) return;
  e.preventDefault();
  const expanded = expandPasteTokens(selected, composer._pasteBlobs);
  e.clipboardData.setData('text/plain', expanded);
  if (isCut) deleteRange(composer, textarea, start, end);
}

/**
 * Length of the common leading run of two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number} The shared-prefix length.
 */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether the single contiguous edit that turned `prev` into `cur` cut into a
 * token's interior (as opposed to leaving tokens whole — typing outside them,
 * or deleting one entirely). A textarea `input` is always one contiguous
 * replacement, so the changed span in `prev` is `[prefix, prev.len - suffix)`;
 * a token that overlaps that span but isn't fully inside it was damaged.
 * @param {string} prev - The last known-good value.
 * @param {string} cur - The current value after the edit.
 * @returns {{start:number, end:number}|null} The damaged span in `prev`, or null.
 */
function damagedTokenSpan(prev, cur) {
  const pre = commonPrefixLen(prev, cur);
  let sfx = 0;
  const maxSfx = Math.min(prev.length - pre, cur.length - pre);
  while (sfx < maxSfx && prev[prev.length - 1 - sfx] === cur[cur.length - 1 - sfx]) sfx++;
  const chgStart = pre;
  const chgEnd = prev.length - sfx; // [chgStart, chgEnd) is the edited span in prev
  for (const t of parseTokens(prev)) {
    const overlaps = t.start < chgEnd && t.end > chgStart;
    const contained = t.start >= chgStart && t.end <= chgEnd;
    if (overlaps && !contained) return t;
  }
  return null;
}

/**
 * Reconcile the textarea after an `input` so a placeholder's contents can never
 * be edited — only deleted whole. Two layers:
 *  1. If the edit cut into a token's interior (a path that dodged the
 *     caret/selection interceptors — autocorrect, dictation, drag-drop, exotic
 *     IME), REVERT to the last known-good value: the edit simply doesn't take,
 *     and the captured content is never silently lost.
 *  2. Otherwise strip any orphaned delimiter characters as a final safety net,
 *     then adopt the current value as the new known-good base.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @returns {boolean} True if the value was changed (reverted or cleaned).
 */
export function reconcileTokens(composer, textarea) {
  const cur = textarea.value;
  const prev = composer._pasteLastValue;
  const curHasDelims = cur.indexOf(PASTE_TOKEN_OPEN) !== -1 || cur.indexOf(PASTE_TOKEN_CLOSE) !== -1;
  // Fast path: no tokens are or were in play — nothing to guard.
  if (!curHasDelims && !hasTokens(prev)) { composer._pasteLastValue = cur; return false; }

  if (!composer._pasteComposing && hasTokens(prev)) {
    const damaged = damagedTokenSpan(prev, cur);
    if (damaged) {
      // Reject the edit: restore the last good value, park the caret at the
      // start of the token that was hit (a boundary, never its interior).
      composer._snappingSelection = true;
      textarea.value = prev;
      try { textarea.setSelectionRange(damaged.start, damaged.start); } catch { /* non-fatal */ }
      composer._snappingSelection = false;
      composer._pasteLastValue = prev;
      composer._pasteLastCaret = damaged.start;
      return true;
    }
  }

  // Edit is legitimate. Strip any stray delimiters (half a token left by a
  // path this couldn't revert) and adopt the result as the new base.
  const cleaned = stripStrayDelimiters(cur, composer._pasteBlobs);
  if (cleaned !== cur) {
    const at = Math.min(textarea.selectionStart, cleaned.length);
    textarea.value = cleaned;
    try { textarea.setSelectionRange(at, at); } catch { /* non-fatal */ }
    composer._pasteLastValue = cleaned;
    composer._pasteLastCaret = at;
    return true;
  }
  composer._pasteLastValue = cur;
  composer._pasteLastCaret = textarea.selectionStart;
  return false;
}

/**
 * Hit-test a viewport point against the mirror's rendered token pills, mapping
 * a hit to its token in text order. Used for click-to-expand, which can't rely
 * on the caret (a click inside a token is snapped to a boundary before `click`
 * fires).
 * @param {any} composer - Composer instance
 * @param {number} x - Client X.
 * @param {number} y - Client Y.
 * @returns {{token: import('../utils/paste-tokens.js').PasteTokenMatch, span: Element}|null}
 *   The hit token and its rendered pill span, or null.
 */
export function tokenAtPoint(composer, x, y) {
  if (!composer._pasteMirror) return null;
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return null;
  const spans = composer._pasteMirror.querySelectorAll('.paste-token');
  const tokens = parseTokens(textarea.value);
  const n = Math.min(spans.length, tokens.length);
  for (let i = 0; i < n; i++) {
    const span = spans[i];
    const tok = tokens[i];
    if (!span || !tok) continue;
    const r = span.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { token: tok, span };
  }
  return null;
}

/**
 * Expand a token in response to a click, with a visible acknowledgement. The
 * insert of a large blob is synchronous and can briefly block the main thread,
 * so paint a "busy" state on the pill FIRST (forcing a layout flush), then run
 * the expansion on a later frame so that state is on screen before the block.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
 * @param {Element} [span] - The pill span to flag as busy.
 */
export function expandTokenWithFeedback(composer, textarea, tok, span) {
  if (span) {
    span.classList.add('expanding');
    void (/** @type {HTMLElement} */ (span)).offsetHeight; // force the state to paint
  }
  const run = () => {
    // Re-resolve the token by id from the CURRENT text: the defer opens a small
    // window in which positions could shift, so never expand a stale span.
    const cur = parseTokens(textarea.value);
    const fresh = cur.find((t) => t.id === tok.id && t.start === tok.start) || cur.find((t) => t.id === tok.id);
    if (fresh) expandToken(composer, textarea, fresh);
  };
  // A click means the view is frontmost, so rAF is not throttled here; a double
  // rAF guarantees the busy state has painted before the blocking insert.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run));
  } else {
    setTimeout(run, 0);
  }
}

/**
 * Shared tail for every token-text mutation (capture, expand, delete, cut):
 * refresh the mirror, re-measure the textarea, update the empty-sensitive
 * controls, and persist the draft immediately (a discrete event, like an
 * attachment add).
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function afterTokenMutation(composer, textarea) {
  // A capture/expand/delete/cut is trusted, so it becomes the reconciler's new
  // known-good base (an execCommand mutation also fires input, which must not
  // then see the pre-mutation value and revert it).
  composer._pasteLastValue = textarea.value;
  composer._pasteLastCaret = textarea.selectionStart;
  syncPasteMirror(composer);
  composer.autoResize(textarea);
  composer._updateSendButtonState();
  composer._persistDraft();
  composer._completions?.handleInput();
}

// ── Token mirror overlay ───────────────────────────────────────────────

/**
 * Rebuild or tear down the backdrop mirror to match the current text. With no
 * tokens the mirror is removed and the textarea is a plain, fully ordinary
 * textarea — all mirror risk is confined to the moments a placeholder exists.
 * @param {any} composer - Composer instance
 */
export function syncPasteMirror(composer) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (!textarea) return;
  const tokens = parseTokens(textarea.value);
  if (tokens.length === 0) {
    teardownPasteMirror(composer, textarea);
    return;
  }
  ensurePasteMirror(composer, textarea);
  renderPasteMirror(composer, textarea.value, tokens);
  syncMirrorMetrics(composer, textarea);
}

/**
 * Create the mirror div (once) behind the textarea, switch the textarea to
 * transparent-text mode, disable spellcheck (squiggles on invisible text), and
 * wire the resize + selection-snapping listeners.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function ensurePasteMirror(composer, textarea) {
  if (composer._pasteMirror) return;
  const mirror = document.createElement('div');
  mirror.className = 'paste-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  // Insert as the textarea's previous sibling so it sits behind it in the
  // wrapper's stacking context.
  textarea.parentElement?.insertBefore(mirror, textarea);
  composer._pasteMirror = mirror;
  textarea.classList.add('paste-mirrored');
  textarea.spellcheck = false;
  if (typeof ResizeObserver === 'function') {
    composer._pasteMirrorRO = new ResizeObserver(() => syncMirrorMetrics(composer, textarea));
    composer._pasteMirrorRO.observe(textarea);
  }
  // Selection snapping: an endpoint strictly inside a token snaps outward, so
  // you can select ACROSS a token but never INTO it (also keeps typing/caret
  // out of the label). Throttled to a microtask-ish guard via a reentrancy flag.
  composer._pasteSelectionListener = () => snapSelectionOutOfTokens(composer, textarea);
  document.addEventListener('selectionchange', composer._pasteSelectionListener);
}

/**
 * Remove the mirror and restore the plain-textarea state. Idempotent.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} [textarea]
 */
export function teardownPasteMirror(composer, textarea) {
  const ta = textarea || /** @type {HTMLTextAreaElement|null} */ (composer.querySelector('textarea'));
  if (composer._pasteMirrorRO) {
    composer._pasteMirrorRO.disconnect();
    composer._pasteMirrorRO = null;
  }
  if (composer._pasteSelectionListener) {
    document.removeEventListener('selectionchange', composer._pasteSelectionListener);
    composer._pasteSelectionListener = null;
  }
  if (composer._pasteMirror) {
    composer._pasteMirror.remove();
    composer._pasteMirror = null;
  }
  if (ta) {
    ta.classList.remove('paste-mirrored');
    ta.spellcheck = false; // matches the render() attribute default
    if (ta.style.cursor) ta.style.cursor = ''; // drop any hover pointer cursor
  }
}

/**
 * Render the mirror's content: the same character string as the textarea, with
 * each token wrapped in a styled `.paste-token` span. Because the label is real
 * text and the span carries only metric-safe styling, both layers lay out
 * identically by construction.
 * @param {any} composer - Composer instance
 * @param {string} text
 * @param {import('../utils/paste-tokens.js').PasteTokenMatch[]} tokens
 */
function renderPasteMirror(composer, text, tokens) {
  const mirror = composer._pasteMirror;
  if (!mirror) return;
  mirror.textContent = '';
  let last = 0;
  for (const t of tokens) {
    if (t.start > last) mirror.appendChild(document.createTextNode(text.slice(last, t.start)));
    const span = document.createElement('span');
    span.className = 'paste-token';
    span.textContent = t.text; // full token incl. invisible delimiters
    mirror.appendChild(span);
    last = t.end;
  }
  // A trailing newline needs a following character for pre-wrap to show the
  // final empty line; mirror the textarea by appending the remainder plus a
  // sentinel space when it ends on a newline.
  let tail = text.slice(last);
  if (tail.endsWith('\n')) tail += '\u200b';
  if (tail) mirror.appendChild(document.createTextNode(tail));
}

/**
 * Copy the textarea's box metrics and scroll onto the mirror so the two layers
 * overlap exactly. Computed styles are copied (rather than assumed from CSS) so
 * the mirror inherits the textarea's real font, regardless of theme.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
function syncMirrorMetrics(composer, textarea) {
  const mirror = composer._pasteMirror;
  if (!mirror) return;
  const cs = window.getComputedStyle(textarea);
  for (const prop of [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
  ]) {
    // @ts-ignore indexed style write
    mirror.style[prop] = cs[prop];
  }
  mirror.style.top = `${textarea.offsetTop}px`;
  mirror.style.left = `${textarea.offsetLeft}px`;
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = `${textarea.clientHeight}px`;
  mirror.scrollTop = textarea.scrollTop;
}

/**
 * Snap a selection endpoint that lands strictly inside a token outward to the
 * token boundary. Guarded against reentrancy (setting the range re-fires
 * selectionchange) and a no-op when nothing needs snapping.
 * @param {any} composer - Composer instance
 * @param {HTMLTextAreaElement} textarea
 */
export function snapSelectionOutOfTokens(composer, textarea) {
  if (composer._snappingSelection || composer._pasteComposing) return;
  if (document.activeElement !== textarea) return;
  if (!hasTokens(textarea.value)) return;
  const tokens = parseTokens(textarea.value);
  let s = textarea.selectionStart;
  let en = textarea.selectionEnd;

  // Collapsed caret: it must never rest INSIDE a token. Snap it out in the
  // direction of travel (a word/line jump or Home/End that landed in a label
  // continues past it), falling back to the nearer edge when direction is
  // ambiguous. This is what makes the interior unreachable by the caret, so no
  // keystroke or paste can target it.
  if (s === en) {
    let p = s;
    for (const t of tokens) {
      if (p > t.start && p < t.end) {
        const movingRight = p >= composer._pasteLastCaret;
        p = movingRight ? t.end : t.start;
        break;
      }
    }
    if (p !== s) {
      composer._snappingSelection = true;
      try { textarea.setSelectionRange(p, p); } catch { /* non-fatal */ } finally { composer._snappingSelection = false; }
    }
    composer._pasteLastCaret = textarea.selectionStart;
    return;
  }

  // Range selection: snap each endpoint outward so you can select ACROSS a
  // token but never INTO it (also keeps a subsequent typed replacement whole).
  const dir = textarea.selectionDirection;
  for (const t of tokens) {
    if (s > t.start && s < t.end) s = (s - t.start) <= (t.end - s) ? t.start : t.end;
    if (en > t.start && en < t.end) en = (en - t.start) <= (t.end - en) ? t.start : t.end;
  }
  if (s !== textarea.selectionStart || en !== textarea.selectionEnd) {
    if (s > en) { const tmp = s; s = en; en = tmp; }
    composer._snappingSelection = true;
    try {
      textarea.setSelectionRange(s, en, dir === 'none' ? undefined : dir);
    } catch { /* non-fatal */ } finally {
      composer._snappingSelection = false;
    }
  }
  composer._pasteLastCaret = textarea.selectionStart;
}
