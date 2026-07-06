//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit + DOM tests for the right-click context-menu service.
 *
 * Covers:
 *  - provider dispatch (resolveMenu): first matching, non-empty provider wins,
 *    empty results are skipped, non-matching elements resolve to null;
 *  - the built-in text-edit menu (buildTextEditMenu): Cut/Copy/Paste/Select All
 *    for writable fields, Copy-only for read-only selections, nothing for plain
 *    elements or read-only fields — this is what keeps the native menu (with its
 *    Inspect Element / Writing Tools items) from ever showing over text;
 *  - end-to-end wiring: a real `contextmenu` event opens the juggler popup,
 *    suppresses the native menu (preventDefault), and Escape dismisses it.
 * @module unit-tests/context-menu-test
 */

import {
  buildTextEditMenu,
  resolveMenu,
  registerContextMenuProvider,
} from '../../js/services/context-menu-service.js';

// Unique marker so our test provider never collides with real providers or
// real DOM. Real providers match code-block / diff-viewer / .conversation-tab /
// [data-file-path]; none of those match this attribute.
const MARK = 'data-cm-unit-test';

let _providerRegistered = false;
/**
 *
 */
function ensureTestProvider() {
  if (_providerRegistered) return;
  registerContextMenuProvider({
    match: (start) => (start ? start.closest(`[${MARK}]`) : null),
    build: (subject) => {
      const kind = subject.getAttribute(MARK);
      if (kind === 'empty') return []; // exercise the "skip empty" path
      return [
        { label: 'Test Action', onClick: () => { /* no-op */ } },
      ];
    },
  });
  _providerRegistered = true;
}

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Run the context-menu test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** @param {number} r */
  const tally = (r) => { if (r) passed += r; else failed += 1; };

  ensureTestProvider();

  const labelsOf = (/** @type {{label?: string, separator?: boolean}[]} */ items) =>
    items.filter(i => !i.separator).map(i => i.label);

  // === Provider dispatch (resolveMenu) ===
  const matchEl = document.createElement('div');
  matchEl.setAttribute(MARK, 'normal');
  const resolved = resolveMenu(matchEl);
  tally(check(!!resolved && resolved.items.length === 1 && resolved.items[0].label === 'Test Action',
    'resolveMenu: matching element should return the provider items', errors));
  tally(check(!!resolved && resolved.subject === matchEl,
    'resolveMenu: subject should be the matched element', errors));

  // closest() climbs: right-clicking a child resolves to the marked ancestor.
  const child = document.createElement('span');
  matchEl.appendChild(child);
  const resolvedChild = resolveMenu(child);
  tally(check(!!resolvedChild && resolvedChild.subject === matchEl,
    'resolveMenu: should climb to the nearest matching ancestor', errors));

  const emptyEl = document.createElement('div');
  emptyEl.setAttribute(MARK, 'empty');
  tally(check(resolveMenu(emptyEl) === null,
    'resolveMenu: provider returning no items should be skipped (null)', errors));

  const plainEl = document.createElement('div');
  tally(check(resolveMenu(plainEl) === null,
    'resolveMenu: unclaimed element should resolve to null', errors));

  tally(check(resolveMenu(null) === null,
    'resolveMenu: null target should resolve to null', errors));

  // === Built-in text-edit menu (buildTextEditMenu) ===
  // Writable textarea with a selection → full edit menu, Cut/Copy enabled.
  const ta = document.createElement('textarea');
  ta.value = 'hello world';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.setSelectionRange(0, 5);
    const taMenu = buildTextEditMenu(ta);
    tally(check(
      JSON.stringify(labelsOf(taMenu)) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All']),
      `text-edit: writable textarea menu labels (got ${JSON.stringify(labelsOf(taMenu))})`, errors));
    const cut = taMenu.find(i => i.label === 'Cut');
    const paste = taMenu.find(i => i.label === 'Paste');
    tally(check(cut && !cut.disabled, 'text-edit: Cut enabled when selection non-empty', errors));
    tally(check(paste && !paste.disabled, 'text-edit: Paste always enabled', errors));

    // Collapsed caret → Cut/Copy disabled, Paste still enabled.
    ta.setSelectionRange(2, 2);
    const taCollapsed = buildTextEditMenu(ta);
    const cut2 = taCollapsed.find(i => i.label === 'Cut');
    const copy2 = taCollapsed.find(i => i.label === 'Copy');
    tally(check(cut2?.disabled === true && copy2?.disabled === true,
      'text-edit: Cut/Copy disabled with no selection', errors));
  } finally {
    ta.remove();
  }

  // Read-only field → no edit menu (no clutter, no native Inspect/Writing Tools).
  const roField = document.createElement('input');
  roField.type = 'text';
  roField.value = 'locked';
  roField.readOnly = true;
  document.body.appendChild(roField);
  try {
    tally(check(buildTextEditMenu(roField).length === 0,
      'text-edit: read-only input yields no edit menu', errors));
  } finally {
    roField.remove();
  }

  // Non-editable element with a live text selection → Copy only.
  const para = document.createElement('p');
  para.textContent = 'selectable read-only text';
  document.body.appendChild(para);
  try {
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const paraMenu = buildTextEditMenu(para);
    tally(check(
      JSON.stringify(labelsOf(paraMenu)) === JSON.stringify(['Copy']),
      `text-edit: selected read-only text offers Copy only (got ${JSON.stringify(labelsOf(paraMenu))})`, errors));
    sel?.removeAllRanges();
  } finally {
    para.remove();
  }

  // Plain element, no selection → no menu at all.
  const bare = document.createElement('div');
  document.body.appendChild(bare);
  try {
    window.getSelection()?.removeAllRanges();
    tally(check(buildTextEditMenu(bare).length === 0,
      'text-edit: plain element with no selection yields no menu', errors));
  } finally {
    bare.remove();
  }

  // === End-to-end: contextmenu over a textarea opens the juggler edit menu ===
  const taHost = document.createElement('textarea');
  taHost.value = 'abc';
  document.body.appendChild(taHost);
  try {
    taHost.focus();
    taHost.setSelectionRange(0, 0);
    const ev = new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 30, clientY: 30,
    });
    const notCancelled = taHost.dispatchEvent(ev);
    tally(check(notCancelled === false,
      'e2e: native menu suppressed over a text field (preventDefault)', errors));
    const editMenu = document.querySelector('.juggler-context-menu');
    const editLabels = editMenu
      ? Array.from(editMenu.querySelectorAll('.juggler-context-menu-item')).map(b => b.textContent)
      : [];
    tally(check(
      JSON.stringify(editLabels) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Select All']),
      `e2e: textarea right-click shows the edit menu (got ${JSON.stringify(editLabels)})`, errors));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    taHost.remove();
    const leftover = document.querySelector('.juggler-context-menu');
    if (leftover) leftover.remove();
  }

  // === End-to-end: contextmenu event opens + Escape dismisses ===
  const host = document.createElement('div');
  host.setAttribute(MARK, 'normal');
  document.body.appendChild(host);
  try {
    // Pre-condition: no menu open.
    const before = document.querySelector('.juggler-context-menu');
    tally(check(before === null, 'e2e: no juggler menu should exist before the event', errors));

    host.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20,
    }));

    const menu = document.querySelector('.juggler-context-menu');
    tally(check(menu !== null, 'e2e: contextmenu over a claimed element should open the juggler menu', errors));
    const rows = menu ? menu.querySelectorAll('.juggler-context-menu-item') : [];
    tally(check(rows.length === 1 && rows[0].textContent === 'Test Action',
      'e2e: menu should render the provider rows', errors));

    // Escape dismisses.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    tally(check(document.querySelector('.juggler-context-menu') === null,
      'e2e: Escape should dismiss the juggler menu', errors));
  } finally {
    host.remove();
    const leftover = document.querySelector('.juggler-context-menu');
    if (leftover) leftover.remove();
  }

  return { passed, failed, errors };
}
