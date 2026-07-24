//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * KeyShortcutManager + file-editing-permission unit tests.
 *
 * Covers the central shortcut table, platform-agnostic binding matching, the
 * customisation override seam, platform-correct display formatting, and the
 * shared file-editing toggle the "toggle file editing" shortcut drives. Tests
 * are platform-independent: display/matching assertions branch on the same
 * exported {@link isMac} the manager itself uses. Nothing registers a handler on
 * a real dispatchable id, so the shared singleton's handler map is never
 * clobbered for other suites.
 * @module unit-tests/key-shortcut-manager-test
 */

import { assert } from '../utilities/test-helpers.js';
import keyShortcutManager, { isMac, eventMatchesBinding, formatBindingForPlatform } from '../../js/services/key-shortcut-manager.js';
import {
  isFileEditingAllowed,
  toggleFileEditing,
  WRITE_FILE_ITEM_TYPE,
} from '../../js/services/file-editing-permission.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Build a fake KeyboardEvent carrying only the props eventMatchesBinding reads.
 * @param {object} overrides - Property overrides.
 * @returns {any} A minimal event-like object.
 */
function evt(overrides) {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...overrides };
}

/**
 * A minimal MessageThread stand-in backing the file-write permission rules with
 * a plain array — matches the getRulesFor/addRule/removeRule surface the helper
 * uses.
 * @returns {any} The fake thread.
 */
function fakeThread() {
  let rules = [];
  let n = 1;
  return {
    getRulesFor(type) { return rules.filter((r) => r.type === type); },
    addRule(type, rule) { rules.push({ id: `r${n++}`, type, ...rule }); },
    removeRule(id) { rules = rules.filter((r) => r.id !== id); },
    allRules() { return rules; },
  };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  const mac = isMac();
  // The command modifier for this platform, as an event-prop override.
  const modProp = mac ? { metaKey: true } : { ctrlKey: true };

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Definition table ────────────────────────────────────────────────
  await run('all() lists the expected command ids', () => {
    const ids = keyShortcutManager.all().map((d) => d.id);
    for (const id of ['jump-to-attention', 'new-conversation', 'bin-conversation',
      'toggle-file-editing', 'pause-conversation', 'undo', 'redo', 'zoom-in', 'zoom-out',
      'strategy-switch', 'cycle-model', 'cycle-thinking']) {
      assert(ids.includes(id), `expected shortcut "${id}" in the table`);
    }
  });

  await run('byCategory() groups without dropping any shortcut', () => {
    const groups = keyShortcutManager.byCategory();
    const grouped = groups.reduce((n, g) => n + g.shortcuts.length, 0);
    assert(grouped === keyShortcutManager.all().length, 'grouped count must equal total');
    const cats = groups.map((g) => g.category);
    assert(new Set(cats).size === cats.length, 'each category should appear once');
  });

  await run('prev/next-tab are macOS-only and bound to ⌥⌘↑/↓', () => {
    const ids = keyShortcutManager.all().map((d) => d.id);
    assert(ids.includes('prev-tab') && ids.includes('next-tab'), 'tab-nav commands present');
    const prev = keyShortcutManager.getBinding('prev-tab');
    const next = keyShortcutManager.getBinding('next-tab');
    assert(prev.mod && prev.alt && prev.key === 'ArrowUp', 'prev-tab is Mod+Alt+ArrowUp');
    assert(next.mod && next.alt && next.key === 'ArrowDown', 'next-tab is Mod+Alt+ArrowDown');
    // Rendered for macOS regardless of host, since the binding only ships there.
    assert(formatBindingForPlatform(prev, true) === '⌥⌘↑', `prev-tab mac label wrong: ${formatBindingForPlatform(prev, true)}`);
    assert(formatBindingForPlatform(next, true) === '⌥⌘↓', `next-tab mac label wrong: ${formatBindingForPlatform(next, true)}`);
  });

  await run('byCategoryForPlatform hides macOS-only commands off macOS', () => {
    const idsIn = (groups) => groups.flatMap((g) => g.shortcuts.map((s) => s.id));
    const onMac = idsIn(keyShortcutManager.byCategoryForPlatform(true));
    const offMac = idsIn(keyShortcutManager.byCategoryForPlatform(false));
    assert(onMac.includes('prev-tab') && onMac.includes('next-tab'), 'mac listing includes tab-nav');
    assert(!offMac.includes('prev-tab') && !offMac.includes('next-tab'), 'non-mac listing omits tab-nav');
    // Non-platform commands appear on both.
    assert(onMac.includes('undo') && offMac.includes('undo'), 'unrestricted commands appear on both');
    // byCategory() (unfiltered) still lists everything.
    assert(idsIn(keyShortcutManager.byCategory()).includes('prev-tab'), 'byCategory keeps platform commands');
  });

  // ── Binding matching (platform-aware) ───────────────────────────────
  await run('undo matches Mod+Z but not Mod+Shift+Z', () => {
    const undo = keyShortcutManager.getBinding('undo');
    assert(eventMatchesBinding(undo, evt({ ...modProp, key: 'z' })), 'Mod+Z should match undo');
    assert(!eventMatchesBinding(undo, evt({ ...modProp, shiftKey: true, key: 'z' })),
      'Mod+Shift+Z should NOT match undo (shift is significant)');
  });

  await run('redo matches Mod+Shift+Z but not Mod+Z', () => {
    const redo = keyShortcutManager.getBinding('redo');
    assert(eventMatchesBinding(redo, evt({ ...modProp, shiftKey: true, key: 'z' })), 'Mod+Shift+Z should match redo');
    assert(!eventMatchesBinding(redo, evt({ ...modProp, key: 'z' })), 'Mod+Z should NOT match redo');
  });

  await run('a bare key (no mod) does not match a mod binding', () => {
    const undo = keyShortcutManager.getBinding('undo');
    assert(!eventMatchesBinding(undo, evt({ key: 'z' })), 'Z alone should not match undo');
  });

  await run('a mod binding tolerates the other command modifier being held too', () => {
    const undo = keyShortcutManager.getBinding('undo');
    // Both meta and ctrl set is how the header shortcut test dispatches
    // platform-agnostically; a command-modifier binding must still fire.
    assert(eventMatchesBinding(undo, evt({ metaKey: true, ctrlKey: true, key: 'z' })),
      'Cmd+Ctrl+Z should still match undo');
  });

  await run('a modifier-less binding rejects an extra command modifier', () => {
    const strat = keyShortcutManager.getBinding('strategy-switch'); // {shift:true, key:'Tab'}
    assert(eventMatchesBinding(strat, evt({ shiftKey: true, key: 'Tab' })), 'Shift+Tab should match strategy-switch');
    assert(!eventMatchesBinding(strat, evt({ ...modProp, shiftKey: true, key: 'Tab' })),
      'Mod+Shift+Tab should not match a modifier-less binding');
  });

  await run('zoom-in folds the shifted "+" onto "=" and ignores Shift', () => {
    const zoomIn = keyShortcutManager.getBinding('zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, key: '=' })), 'Mod+= should match zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, key: '+' })), 'Mod++ should match zoom-in');
    assert(eventMatchesBinding(zoomIn, evt({ ...modProp, shiftKey: true, key: '+' })),
      'Mod+Shift++ should match zoom-in (shift not significant)');
  });

  await run('alt bindings match the macOS Option glyph via the code fallback', () => {
    const cycleModel = keyShortcutManager.getBinding('cycle-model');
    assert(cycleModel.mod && cycleModel.alt && cycleModel.key === 'm', 'cycle-model is Mod+Alt+M');
    // Windows/Linux report the base letter in `key`.
    assert(eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'm', code: 'KeyM' })),
      'Mod+Alt+m should match cycle-model');
    // macOS reports the Option-modified glyph ('µ' for ⌥M, '†' for ⌥T) — the
    // physical `code` carries the match there.
    assert(eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'µ', code: 'KeyM' })),
      'Mod+Alt+µ (macOS ⌥M glyph) should match cycle-model via code');
    const cycleThinking = keyShortcutManager.getBinding('cycle-thinking');
    assert(eventMatchesBinding(cycleThinking, evt({ ...modProp, altKey: true, key: '†', code: 'KeyT' })),
      'Mod+Alt+† (macOS ⌥T glyph) should match cycle-thinking via code');
    // The code fallback is Alt-only: without Alt the glyph must not match.
    assert(!eventMatchesBinding(cycleModel, evt({ ...modProp, key: 'µ', code: 'KeyM' })),
      'no Alt ⇒ no code fallback');
    // And the wrong physical key must not match even with the modifiers right.
    assert(!eventMatchesBinding(cycleModel, evt({ ...modProp, altKey: true, key: 'µ', code: 'KeyN' })),
      'a different code must not match');
  });

  await run('an unwanted Alt modifier blocks the match', () => {
    const newConv = keyShortcutManager.getBinding('new-conversation');
    assert(eventMatchesBinding(newConv, evt({ ...modProp, key: 'n' })), 'Mod+N should match new-conversation');
    assert(!eventMatchesBinding(newConv, evt({ ...modProp, altKey: true, key: 'n' })),
      'Mod+Alt+N should not match a non-Alt binding');
  });

  // New tab (⌘N) vs New window (⇧⌘N) must not overlap: new-conversation pins
  // shift:false so ⇧⌘N doesn't also open a tab, and new-window owns ⇧⌘N.
  await run('Shift disambiguates New tab (⌘N) from New window (⇧⌘N)', () => {
    const newConv = keyShortcutManager.getBinding('new-conversation');
    const newWin = keyShortcutManager.getBinding('new-window');
    assert(!eventMatchesBinding(newConv, evt({ ...modProp, shiftKey: true, key: 'n' })),
      'Mod+Shift+N must NOT match new-conversation');
    assert(eventMatchesBinding(newWin, evt({ ...modProp, shiftKey: true, key: 'n' })),
      'Mod+Shift+N should match new-window');
    assert(!eventMatchesBinding(newWin, evt({ ...modProp, key: 'n' })),
      'bare Mod+N must NOT match new-window');
  });

  // ── Display formatting (platform-correct) ───────────────────────────
  await run('formatBinding renders platform-correct labels', () => {
    assert(keyShortcutManager.formatBinding('undo') === (mac ? '⌘Z' : 'Ctrl+Z'),
      `undo label wrong: ${keyShortcutManager.formatBinding('undo')}`);
    assert(keyShortcutManager.formatBinding('redo') === (mac ? '⇧⌘Z' : 'Ctrl+Shift+Z'),
      `redo label wrong: ${keyShortcutManager.formatBinding('redo')}`);
    assert(keyShortcutManager.formatBinding('bin-conversation') === (mac ? '⌘⌫' : 'Ctrl+Backspace'),
      `bin label wrong: ${keyShortcutManager.formatBinding('bin-conversation')}`);
    assert(keyShortcutManager.formatBinding('zoom-in') === (mac ? '⌘+' : 'Ctrl++'),
      `zoom-in label wrong: ${keyShortcutManager.formatBinding('zoom-in')}`);
    assert(keyShortcutManager.formatBinding('does-not-exist') === '', 'unknown id formats to empty string');
  });

  // formatBindingForPlatform renders for an EXPLICIT platform, independent of
  // the running host — the seam the About-Juggler help corpus uses to describe
  // shortcuts for session.platform rather than the client's navigator.
  await run('formatBindingForPlatform renders both platforms regardless of host', () => {
    const redo = keyShortcutManager.getBinding('redo');
    assert(formatBindingForPlatform(redo, true) === '⇧⌘Z', `mac redo wrong: ${formatBindingForPlatform(redo, true)}`);
    assert(formatBindingForPlatform(redo, false) === 'Ctrl+Shift+Z', `non-mac redo wrong: ${formatBindingForPlatform(redo, false)}`);
    const bin = keyShortcutManager.getBinding('bin-conversation');
    assert(formatBindingForPlatform(bin, true) === '⌘⌫', `mac bin wrong: ${formatBindingForPlatform(bin, true)}`);
    assert(formatBindingForPlatform(bin, false) === 'Ctrl+Backspace', `non-mac bin wrong: ${formatBindingForPlatform(bin, false)}`);
    // And it agrees with the navigator-based instance method on this host.
    assert(formatBindingForPlatform(redo, mac) === keyShortcutManager.formatBinding('redo'),
      'explicit-platform formatter should match formatBinding on this host');
  });

  // ── Customisation override seam ─────────────────────────────────────
  await run('setBinding overrides and reverts the effective binding', () => {
    const original = keyShortcutManager.getBinding('undo');
    try {
      keyShortcutManager.setBinding('undo', { mod: true, key: 'y' });
      assert(keyShortcutManager.getBinding('undo').key === 'y', 'override should take effect');
      assert(keyShortcutManager.formatBinding('undo') === (mac ? '⌘Y' : 'Ctrl+Y'), 'display reflects override');
    } finally {
      keyShortcutManager.setBinding('undo', null);
    }
    assert(keyShortcutManager.getBinding('undo').key === original.key, 'clearing reverts to default');
  });

  // ── register() guards (no real handler mutation) ────────────────────
  await run('register() ignores unknown and external ids, returning a noop', () => {
    const a = keyShortcutManager.register('no-such-shortcut', () => true);
    const b = keyShortcutManager.register('strategy-switch', () => true); // external — rejected
    assert(typeof a === 'function' && typeof b === 'function', 'register always returns an unregister function');
    // Neither call should throw or take effect; nothing to assert beyond the noop.
    a();
    b();
  });

  // ── File-editing permission toggle ──────────────────────────────────
  await run('toggleFileEditing turns editing on then off', () => {
    const mt = fakeThread();
    assert(isFileEditingAllowed(mt) === false, 'starts disallowed');

    assert(toggleFileEditing(mt) === true, 'first toggle returns the new (on) state');
    assert(isFileEditingAllowed(mt) === true, 'editing now allowed');
    const on = mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean');
    assert(on.length === 1 && on[0].value === true && on[0].scope === 'conversation',
      'exactly one conversation-scoped value:true rule');

    assert(toggleFileEditing(mt) === false, 'second toggle returns the new (off) state');
    assert(isFileEditingAllowed(mt) === false, 'editing now disallowed');
    assert(mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean').length === 0,
      'no boolean rules remain when off');
  });

  await run('toggleFileEditing normalises a stale value:false rule when turning on', () => {
    const mt = fakeThread();
    mt.addRule(WRITE_FILE_ITEM_TYPE, { kind: 'boolean', value: false, scope: 'conversation' });
    assert(isFileEditingAllowed(mt) === false, 'value:false is not "allowed"');
    assert(toggleFileEditing(mt) === true, 'toggle turns editing on');
    const booleans = mt.getRulesFor(WRITE_FILE_ITEM_TYPE).filter((r) => r.kind === 'boolean');
    assert(booleans.length === 1 && booleans[0].value === true, 'stale rule replaced by a single value:true');
  });

  return { passed, failed, errors };
}
