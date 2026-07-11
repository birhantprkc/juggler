//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Right-click (context menu) service.
 *
 * One app-wide capture-phase `contextmenu` listener (module singleton — `import`
 * is the discovery mechanism, see CLAUDE.md "Frontend service style") that owns
 * every menu the app shows. The dispatch order on a right-click is:
 *
 *  1. **Registered juggler providers.** Components register providers
 *     ({@link registerContextMenuProvider}); the first that claims the target
 *     wins (code blocks, diffs, conversation tabs, file refs…). We render our
 *     own popup and suppress the native menu.
 *
 *  2. **Built-in text-edit menu.** Over an editable field we offer
 *     Cut/Copy/Paste/Select All; over a plain text selection, just Copy. We own
 *     these instead of delegating to the native WKWebView menu *on purpose*: in
 *     a non-`production` build WKWebView's native edit menu always carries
 *     "Inspect Element", and on macOS it also injects "Writing Tools" /
 *     "Look Up" / "Translate" / "Share". The page can only choose whether to
 *     show the native menu at all — it cannot strip individual items — so the
 *     only way to keep clean, relevant edit menus (and no Inspect Element over a
 *     read-only paragraph) is to render them ourselves.
 *
 *  3. **Native fallback, dev-mode only.** When nothing juggler-specific applies
 *     and we're in runtime dev-mode (`window.JUGGLER_DEV_MODE`, injected by the
 *     index template from the server's `--dev`/`--assets-from-disk`/config flag), we let
 *     the event fall through so the native debug menu (Reload / Inspect Element)
 *     stays reachable by right-clicking any non-text region. We seed
 *     `window._wails.environment.Debug` from the same flag so the Wails runtime's
 *     own handler agrees and allows that native menu. Outside dev-mode we
 *     `preventDefault()` so the native menu never appears anywhere.
 *
 * Net effect: text and content menus are always juggler-owned and tidy
 * regardless of build tag or dev-mode; the WKWebView debug menu shows only in a
 * real dev session and only over non-text areas.
 * @module services/context-menu-service
 */

/**
 * A single command row in a juggler context menu.
 * @typedef {object} ContextMenuItem
 * @property {string} [label] - Display text. Omit for a separator.
 * @property {boolean} [separator] - When true, render a divider (ignores other fields).
 * @property {boolean} [disabled] - When true, the row is shown greyed and not clickable.
 * @property {boolean} [danger] - When true, style as a destructive action.
 * @property {() => void} [onClick] - Invoked when the row is chosen.
 */

/**
 * A context-menu provider. `match` decides whether this provider owns the
 * right-clicked element (returning the "subject" element it cares about, or
 * null to decline); `build` turns that subject into the menu rows to show.
 * @typedef {object} ContextMenuProvider
 * @property {(start: Element|null, event: MouseEvent) => (Element|null)} match - Return the subject element this provider owns, or null to decline.
 * @property {(subject: Element, event: MouseEvent) => (ContextMenuItem[]|null)} build - Build the menu rows for a matched subject.
 */

import { copyToClipboard, readFromClipboard } from '../../sdk/lib/clipboard.js';
import { markPopupOpen } from '../utils/popup-manager.js';

/** @type {ContextMenuProvider[]} @private */
const _providers = [];

/** @type {HTMLElement|null} @private */
let _openMenu = null;

/**
 * Releases this menu's open-state token (from markPopupOpen). Set while a menu
 * is open so the message input's Escape won't cancel a turn underneath it.
 * @type {(() => void)|null}
 * @private
 */
let _releaseOpenState = null;

/**
 * Register a juggler context-menu provider. Call once at module load from the
 * component that owns the relevant DOM + behaviour.
 * @param {ContextMenuProvider} provider
 */
export function registerContextMenuProvider(provider) {
  _providers.push(provider);
}

/**
 * Whether juggler is running in runtime dev-mode (server `--dev` /
 * `--assets-from-disk` / config). Drives the native debug-menu gate.
 * @returns {boolean} True when running in runtime dev-mode.
 */
export function isDevMode() {
  return !!(/** @type {any} */ (window).JUGGLER_DEV_MODE);
}

// Input types that carry editable text (so Cut/Copy/Paste/Select All apply).
// Excludes button/checkbox/radio/range/colour/file/etc.
const EDITABLE_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'email', 'tel', 'password', 'number', '',
]);

/**
 * Is this element an enabled, writable text field (input/textarea) we can edit?
 * @param {Element|null} el - Candidate element.
 * @returns {boolean} True for a focusable, non-readonly, non-disabled text field.
 * @private
 */
function isWritableField(el) {
  if (!el) return false;
  const input = /** @type {HTMLInputElement & HTMLTextAreaElement} */ (el);
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !input.disabled && !input.readOnly;
  if (tag === 'INPUT') {
    const type = (input.getAttribute('type') || '').toLowerCase();
    return EDITABLE_INPUT_TYPES.has(type) && !input.disabled && !input.readOnly;
  }
  return false;
}

/**
 * The nearest contentEditable host of an element, or null. Native
 * `isContentEditable` already walks ancestors, so we just confirm and return
 * the closest editable container.
 * @param {Element|null} el - Candidate element.
 * @returns {HTMLElement|null} The editable host, or null.
 * @private
 */
function contentEditableHost(el) {
  const node = /** @type {HTMLElement|null} */ (el);
  if (node && node.isContentEditable) {
    return /** @type {HTMLElement} */ (node.closest('[contenteditable]')) || node;
  }
  return null;
}

/**
 * Snapshot of the selection inside a text field at right-click time.
 * @param {HTMLInputElement|HTMLTextAreaElement} el - The field.
 * @returns {{start: number, end: number, text: string}} Selection range + text.
 * @private
 */
function fieldSelection(el) {
  const value = el.value || '';
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Write text to the clipboard, swallowing permission failures.
 * @param {string} text - Text to copy.
 * @private
 */
async function writeClipboard(text) {
  try { await copyToClipboard(text); } catch (e) { /* clipboard blocked */ }
}

/**
 * Read text from the clipboard, returning '' when unavailable/blocked.
 * @returns {Promise<string>} Clipboard text, or ''.
 * @private
 */
async function readClipboard() {
  return readFromClipboard();
}

/**
 * Replace the [start,end) range of a field's value with `text`, restore the
 * caret after the inserted text, and fire an `input` event so listeners
 * (autosize, Yjs draft sync, validation) react exactly as for typed input.
 * @param {HTMLInputElement|HTMLTextAreaElement} el - The field.
 * @param {number} start - Range start.
 * @param {number} end - Range end.
 * @param {string} text - Replacement text.
 * @private
 */
function spliceField(el, start, end, text) {
  const value = el.value || '';
  el.value = value.slice(0, start) + text + value.slice(end);
  const caret = start + text.length;
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch (e) { /* type doesn't support it */ }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Build the built-in edit menu for the right-clicked element. Captures the
 * selection snapshot now (at right-click time) so the actions still work after
 * the popup steals focus. Returns [] when the target is neither editable nor
 * carrying a usable selection — the caller then falls back to native (dev) or
 * suppression (non-dev).
 * @param {Element|null} start - The right-clicked element.
 * @returns {ContextMenuItem[]} Edit-menu rows (possibly empty).
 */
export function buildTextEditMenu(start) {
  const field = isWritableField(start)
    ? /** @type {HTMLInputElement|HTMLTextAreaElement} */ (start)
    : null;
  const editableHost = field ? null : contentEditableHost(start);
  const selectionText = (window.getSelection?.()?.toString()) || '';

  if (field) {
    const sel = fieldSelection(field);
    const hasSel = sel.text.length > 0;
    return [
      { label: 'Cut', disabled: !hasSel, onClick: () => {
        writeClipboard(sel.text);
        spliceField(field, sel.start, sel.end, '');
      } },
      { label: 'Copy', disabled: !hasSel, onClick: () => writeClipboard(sel.text) },
      { label: 'Paste', onClick: async () => {
        const text = await readClipboard();
        if (text) spliceField(field, sel.start, sel.end, text);
      } },
      { separator: true },
      { label: 'Select All', onClick: () => { field.focus(); field.select(); } },
    ];
  }

  if (editableHost) {
    const hasSel = selectionText.length > 0;
    return [
      { label: 'Cut', disabled: !hasSel, onClick: () => {
        writeClipboard(selectionText);
        editableHost.focus();
        try { document.execCommand('delete'); } catch (e) { /* best effort */ }
      } },
      { label: 'Copy', disabled: !hasSel, onClick: () => writeClipboard(selectionText) },
      { label: 'Paste', onClick: async () => {
        const text = await readClipboard();
        if (!text) return;
        editableHost.focus();
        try { document.execCommand('insertText', false, text); } catch (e) { /* best effort */ }
      } },
    ];
  }

  // Non-editable element with a live selection: copy only.
  if (selectionText) {
    return [{ label: 'Copy', onClick: () => writeClipboard(selectionText) }];
  }

  return [];
}

/**
 * Run the registered providers against the right-clicked element. Pure w.r.t.
 * the DOM: returns the first non-empty menu (and its subject) or null. Exposed
 * for unit testing provider dispatch.
 * @param {Element|null} start - The right-clicked element (event target).
 * @param {MouseEvent} [event] - The originating event (passed through to providers).
 * @returns {{items: ContextMenuItem[], subject: Element}|null} The first matching menu, or null when no provider claims the element.
 */
export function resolveMenu(start, event) {
  const ev = /** @type {MouseEvent} */ (event || /** @type {any} */ ({}));
  for (const provider of _providers) {
    let subject = null;
    try {
      subject = provider.match(start, ev);
    } catch (e) {
      subject = null;
    }
    if (!subject) continue;
    let items = null;
    try {
      items = provider.build(subject, ev);
    } catch (e) {
      items = null;
    }
    const filtered = (items || []).filter(Boolean);
    if (filtered.length === 0) continue;
    return { items: filtered, subject };
  }
  return null;
}

/**
 * Align the Wails runtime's native-menu policy with juggler's runtime
 * dev-mode by seeding `window._wails.environment.Debug`. Idempotent.
 * @private
 */
function syncWailsDebugFlag() {
  const w = /** @type {any} */ (window);
  w._wails = w._wails || {};
  w._wails.environment = w._wails.environment || {};
  w._wails.environment.Debug = isDevMode();
}

/**
 * Close any open juggler menu and tear down its dismiss listeners.
 * @private
 */
function closeMenu() {
  if (_openMenu) {
    _openMenu.remove();
    _openMenu = null;
  }
  if (_releaseOpenState) {
    _releaseOpenState();
    _releaseOpenState = null;
  }
  document.removeEventListener('pointerdown', _onOutside, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
}

/**
 * Dismiss the menu on a pointer-down outside it.
 * @param {PointerEvent} e - The pointer event.
 * @private
 */
function _onOutside(e) {
  const target = /** @type {globalThis.Node|null} */ (e.target);
  if (_openMenu && target && _openMenu.contains(target)) return;
  closeMenu();
}

/**
 * Render and position the juggler popup menu at viewport coords (x, y).
 * @param {ContextMenuItem[]} items
 * @param {number} x
 * @param {number} y
 * @private
 */
function showMenu(items, x, y) {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'juggler-context-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'juggler-context-menu-separator';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'juggler-context-menu-item';
    if (item.danger) row.classList.add('danger');
    row.setAttribute('role', 'menuitem');
    row.textContent = item.label || '';
    if (item.disabled) {
      row.disabled = true;
    } else {
      row.addEventListener('click', () => {
        closeMenu();
        try {
          item.onClick?.();
        } catch (e) {
          console.error('[ContextMenu] action failed:', e);
        }
      });
    }
    menu.appendChild(row);
  }

  // Position off-screen first to measure, then clamp into the viewport.
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  _openMenu = menu;
  // Escape and the browser/mobile Back button dismiss via popup-manager.
  _releaseOpenState = markPopupOpen(() => closeMenu());

  const rect = menu.getBoundingClientRect();
  const margin = 4;
  let left = x;
  let top = y;
  if (left + rect.width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';

  document.addEventListener('pointerdown', _onOutside, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
}

/**
 * Capture-phase `contextmenu` handler. Three-tier dispatch (see module doc):
 * registered providers → built-in text-edit menu → native fallback (dev only).
 * Any juggler menu suppresses the native one so its Inspect Element / Writing
 * Tools items never appear over our content.
 * @param {MouseEvent} e - The contextmenu event.
 * @private
 */
function onContextMenu(e) {
  // Only Element targets support closest()/matches() that providers rely on.
  const t = /** @type {any} */ (e.target);
  const start = t && typeof t.closest === 'function' ? /** @type {Element} */ (t) : null;

  // 1) Registered juggler providers.
  const resolved = resolveMenu(start, e);
  if (resolved) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(resolved.items, e.clientX, e.clientY);
    return;
  }

  // 2) Built-in edit menu for text fields / selections. Owning these means the
  //    native menu (Inspect Element in non-production builds; Writing Tools /
  //    Look Up on macOS) never shows over text — in any build or runtime mode.
  const textItems = buildTextEditMenu(start);
  if (textItems.length) {
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(textItems, e.clientX, e.clientY);
    return;
  }

  // 3) Nothing juggler-specific applies. In dev-mode let the native debug menu
  //    (Reload / Inspect Element) through on non-text regions; otherwise
  //    suppress the native menu entirely.
  if (isDevMode()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

// Seed the native-menu gate as early as this module loads, and again at the
// first right-click in case the runtime overwrote the environment object after
// load (the handler reads it live, so a late re-seed is harmless).
syncWailsDebugFlag();
window.addEventListener('contextmenu', (e) => {
  syncWailsDebugFlag();
  onContextMenu(/** @type {MouseEvent} */ (e));
}, { capture: true });
