//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * KeyShortcutManager — the single source of truth for every keyboard shortcut a
 * user could conceivably rebind.
 *
 * Design intent (customisation-ready, not yet customisable):
 *   - The definition table {@link SHORTCUT_DEFS} lists ALL command-level
 *     shortcuts centrally. Nothing else in the codebase should hard-code a key
 *     combo for a user-facing command; it should look the binding up here (for
 *     matching) or ask this manager to format it (for display).
 *   - Bindings are platform-agnostic: `mod` resolves to ⌘ on macOS and Ctrl on
 *     Windows/Linux, so one definition covers every platform. {@link formatBinding}
 *     renders the platform-correct label for settings and tooltips.
 *   - Definitions here describe WHAT keys exist. Behaviour is contributed
 *     separately by feature code via {@link KeyShortcutManager#register} — the
 *     same additive-registration pattern used elsewhere — so the edit extension,
 *     the conversation bar, etc. own their own handlers while the key table
 *     stays central.
 *
 * When shortcuts become customisable, only this file changes: swap the static
 * default lookup in {@link KeyShortcutManager#getBinding} for a user-overlay
 * (localStorage / server prefs) keyed by definition id. Everything downstream
 * already reads through that method.
 * @module services/key-shortcut-manager
 */

/**
 * A platform-agnostic key binding.
 * @typedef {object} KeyBinding
 * @property {boolean} [mod] - The primary command modifier: ⌘ on macOS, Ctrl elsewhere.
 * @property {boolean|undefined} [shift] - Require Shift (true), forbid it (false),
 *   or don't care (undefined). "Don't care" matters for keys like zoom whose
 *   glyph is reached with Shift on some layouts.
 * @property {boolean} [alt] - Require the Alt/Option modifier.
 * @property {string} key - The `KeyboardEvent.key` this binds to, normalized
 *   (single letters lower-case; named keys like 'Backspace'/'Tab' verbatim).
 * @property {string} [displayKey] - Overrides the glyph shown to the user
 *   (e.g. '+' for the '=' key).
 */

/**
 * A shortcut definition — the central, customisable record for one command.
 * @typedef {object} ShortcutDef
 * @property {string} id - Stable identifier used by handlers and tooltips.
 * @property {string} label - Human-readable command name.
 * @property {string} description - One-line explanation for the settings page.
 * @property {string} category - Grouping label for the settings page.
 * @property {KeyBinding} defaultBinding - The shipped binding (future: overridable).
 * @property {boolean|'empty'} [allowInInput] - Whether the command may fire while
 *   focus is in a text field. `false` (default): never — don't steal keys while
 *   the user is typing. `true`: always. `'empty'`: only when the field is empty,
 *   so a live edit still runs natively (e.g. ⌘⌫ deletes to line start in a
 *   non-empty composer, but bins the conversation when the composer is empty).
 * @property {boolean} [external] - This shortcut's dispatch is owned by a
 *   dedicated controller (e.g. the strategy switcher's hold-to-cycle UX). The
 *   manager still lists it (settings, tooltips) but never dispatches it — the
 *   owner reads {@link KeyShortcutManager#getBinding} and matches itself via
 *   {@link eventMatchesBinding}.
 */

/** @returns {boolean} True on macOS-family platforms (⌘ is the command modifier). */
export function isMac() {
  return typeof navigator !== 'undefined'
    && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * Normalize a `KeyboardEvent.key` for binding comparison: letters lower-case,
 * and the shifted twins of the zoom keys folded onto their base glyph so a
 * binding matches regardless of Shift/layout ('+' → '=', '_' → '-').
 * @param {string} key
 * @returns {string} The normalized key for comparison.
 */
function normalizeKey(key) {
  if (!key) return '';
  if (key === '+') return '=';
  if (key === '_') return '-';
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Does a keyboard event satisfy a binding, accounting for the platform meaning
 * of `mod`? Exported so external controllers (strategy switcher) match against
 * the same central bindings instead of re-hard-coding keys.
 * @param {KeyBinding} binding
 * @param {KeyboardEvent} e
 * @returns {boolean} True when the event satisfies the binding on this platform.
 */
export function eventMatchesBinding(binding, e) {
  const primary = isMac() ? e.metaKey : e.ctrlKey; // the command modifier (⌘ / Ctrl)
  const secondary = isMac() ? e.ctrlKey : e.metaKey; // the other one (⌃ / Meta)
  if (binding.mod) {
    // A command-modifier binding just needs its modifier down; the other one
    // being held too is tolerated (⌘Z and ⌘⌃Z both undo).
    if (!primary) return false;
  } else if (primary || secondary) {
    // A modifier-less binding (e.g. Shift+Tab) must have BOTH command
    // modifiers idle, so ⌃Shift+Tab never triggers a plain-Shift+Tab command.
    return false;
  }
  if (binding.shift !== undefined && !!binding.shift !== e.shiftKey) return false;
  if (!!binding.alt !== e.altKey) return false;
  return normalizeKey(e.key) === normalizeKey(binding.key);
}

/**
 * macOS modifier/named-key glyphs, in Apple's canonical display order.
 * @type {Record<string, string>}
 */
const MAC_KEY_GLYPHS = {
  Backspace: '⌫', Delete: '⌦', Tab: '⇥', Enter: '↵', Return: '↵',
  Escape: '⎋', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ' ': 'Space', Space: 'Space',
};

/**
 * Verbose key names for the Windows/Linux "Ctrl+…" style.
 * @type {Record<string, string>}
 */
const NAMED_KEY_LABELS = {
  ' ': 'Space', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right',
};

/**
 * The glyph/label for a binding's key on an explicit platform. Pure.
 * @param {KeyBinding} binding
 * @param {boolean} mac - True for macOS glyphs, false for Windows/Linux labels.
 * @returns {string} The glyph/label for the binding's key.
 */
function keyGlyphFor(binding, mac) {
  if (binding.displayKey) return binding.displayKey;
  const key = binding.key;
  if (mac && MAC_KEY_GLYPHS[key]) return MAC_KEY_GLYPHS[key];
  if (!mac && NAMED_KEY_LABELS[key]) return NAMED_KEY_LABELS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Render a binding for an EXPLICIT platform (⌘⇧Z on macOS, "Ctrl+Shift+Z" on
 * Windows/Linux), independent of the running client's navigator. Use when the
 * target platform is known from data rather than the live client — e.g. building
 * a platform-specific help corpus from `session.platform`. Pure; the instance
 * {@link KeyShortcutManager#formatKeyBinding} delegates here with `isMac()`.
 * @param {KeyBinding} binding
 * @param {boolean} mac - True to render for macOS, false for Windows/Linux.
 * @returns {string} The platform-correct key label.
 */
export function formatBindingForPlatform(binding, mac) {
  const keyGlyph = keyGlyphFor(binding, mac);
  if (mac) {
    // Apple order: ⌃ ⌥ ⇧ ⌘ — we use ⌥ ⇧ ⌘.
    let out = '';
    if (binding.alt) out += '⌥';
    if (binding.shift) out += '⇧';
    if (binding.mod) out += '⌘';
    return out + keyGlyph;
  }
  const parts = [];
  if (binding.mod) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(keyGlyph);
  return parts.join('+');
}

/**
 * The central shortcut table. Add a customisable command here and nowhere else.
 * @type {ShortcutDef[]}
 */
const SHORTCUT_DEFS = [
  {
    id: 'jump-to-attention',
    label: 'Jump to conversation needing attention',
    description: 'Switch to the next conversation waiting on you; select its first '
      + 'pending approval, or scroll to the end if it just needs a look.',
    category: 'Conversations',
    defaultBinding: { mod: true, key: 'j' },
    allowInInput: true,
  },
  {
    id: 'new-conversation',
    label: 'New conversation',
    description: 'Create a new conversation and switch to it.',
    category: 'Conversations',
    defaultBinding: { mod: true, key: 'n' },
    allowInInput: true,
  },
  {
    id: 'bin-conversation',
    label: 'Move conversation to bin',
    description: 'Move the current conversation to the bin.',
    category: 'Conversations',
    // Fires from the composer only when it's empty, so it works when you'd press
    // it (the composer is focused most of the time) without hijacking ⌘⌫ /
    // Ctrl+Backspace "delete to line start" while there's text to delete.
    defaultBinding: { mod: true, key: 'Backspace' },
    allowInInput: 'empty',
  },
  {
    id: 'toggle-file-editing',
    label: 'Toggle file edit permission',
    description: 'Allow or ask-before file edits for the current conversation.',
    category: 'Conversations',
    defaultBinding: { mod: true, key: 'e' },
    allowInInput: true,
  },
  {
    id: 'find-in-conversation',
    label: 'Find in conversation',
    description: 'Open the find bar to search for text in the current conversation.',
    category: 'Search',
    // Works while typing in the composer — the find bar is a search overlay, so
    // it must be reachable without first leaving the text field.
    defaultBinding: { mod: true, key: 'f' },
    allowInInput: true,
  },
  {
    id: 'undo',
    label: 'Undo',
    description: 'Undo the last change in the current conversation.',
    category: 'Editing',
    // Not in text fields — the composer has its own native undo.
    defaultBinding: { mod: true, shift: false, key: 'z' },
    allowInInput: false,
  },
  {
    id: 'redo',
    label: 'Redo',
    description: 'Redo the last undone change in the current conversation.',
    category: 'Editing',
    defaultBinding: { mod: true, shift: true, key: 'z' },
    allowInInput: false,
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    description: 'Increase the interface zoom level.',
    category: 'View',
    defaultBinding: { mod: true, key: '=', displayKey: '+' },
    allowInInput: true,
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    description: 'Decrease the interface zoom level.',
    category: 'View',
    defaultBinding: { mod: true, key: '-', displayKey: '−' },
    allowInInput: true,
  },
  {
    id: 'strategy-switch',
    label: 'Switch strategy',
    description: 'Cycle the active strategy; hold to open the strategy menu.',
    category: 'Conversations',
    defaultBinding: { shift: true, key: 'Tab' },
    external: true,
  },
];

/**
 * @param {EventTarget|null} target
 * @returns {boolean} True when the target is a text field / editable element.
 */
function isEditableTarget(target) {
  const el = /** @type {HTMLElement|null} */ (target);
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/**
 * @param {EventTarget|null} target
 * @returns {boolean} True when the editable target holds no text (nothing to edit).
 */
function isEditableEmpty(target) {
  const el = /** @type {any} */ (target);
  if (!el) return true;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.value ?? '').length === 0;
  if (el.isContentEditable) return (el.textContent ?? '').length === 0;
  return true;
}

class KeyShortcutManager {
  constructor() {
    /** @type {Map<string, ShortcutDef>} @private */
    this._defs = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));
    /**
     * Future user overrides (id → binding). Empty today; {@link getBinding}
     * already prefers it, so making shortcuts customisable is a localized change.
     * @type {Map<string, KeyBinding>} @private
     */
    this._overrides = new Map();
    /** @type {Map<string, function(KeyboardEvent): (boolean|undefined)>} @private */
    this._handlers = new Map();
    /** @type {boolean} @private */
    this._installed = false;
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /** Install the single global keydown dispatcher. Idempotent. */
  install() {
    if (this._installed || typeof document === 'undefined') return;
    this._installed = true;
    document.addEventListener('keydown', this._onKeyDown);
  }

  /** @returns {ShortcutDef[]} All definitions in declared order. */
  all() {
    return [...this._defs.values()];
  }

  /**
   * Definitions grouped by category, preserving declaration order within and
   * across groups. Handy for the settings page.
   * @returns {Array<{category: string, shortcuts: ShortcutDef[]}>} Groups in declaration order.
   */
  byCategory() {
    /** @type {Array<{category: string, shortcuts: ShortcutDef[]}>} */
    const groups = [];
    for (const def of this._defs.values()) {
      let group = groups.find((g) => g.category === def.category);
      if (!group) { group = { category: def.category, shortcuts: [] }; groups.push(group); }
      group.shortcuts.push(def);
    }
    return groups;
  }

  /**
   * The effective binding for a command — a user override if one exists (future),
   * else the shipped default.
   * @param {string} id
   * @returns {KeyBinding|null} The effective binding, or null if the id is unknown.
   */
  getBinding(id) {
    if (this._overrides.has(id)) return /** @type {KeyBinding} */ (this._overrides.get(id));
    const def = this._defs.get(id);
    return def ? def.defaultBinding : null;
  }

  /**
   * Set a user override for a command's binding. Not yet wired to any UI or
   * persistence — present so the customisation seam exists in exactly one place.
   * @param {string} id
   * @param {KeyBinding|null} binding - null clears the override (revert to default).
   */
  setBinding(id, binding) {
    if (binding) this._overrides.set(id, binding);
    else this._overrides.delete(id);
  }

  /**
   * @param {string} id
   * @returns {string} The command's label, or the id if unknown.
   */
  label(id) {
    return this._defs.get(id)?.label ?? id;
  }

  /**
   * Render a command's current binding for the running platform (⌘⇧Z on macOS,
   * "Ctrl+Shift+Z" on Windows/Linux). Empty string if the command is unknown.
   * @param {string} id
   * @returns {string} The platform-correct key label, or '' if the id is unknown.
   */
  formatBinding(id) {
    const binding = this.getBinding(id);
    return binding ? this.formatKeyBinding(binding) : '';
  }

  /**
   * Render an arbitrary binding for the running platform.
   * @param {KeyBinding} binding
   * @returns {string} The platform-correct key label.
   */
  formatKeyBinding(binding) {
    return formatBindingForPlatform(binding, isMac());
  }

  /**
   * Register the behaviour for a command. The handler returns truthy when it
   * acted on the event, in which case the manager calls preventDefault/
   * stopPropagation; a falsy return leaves the event to propagate (so an
   * inapplicable command — nothing to undo, no flagged conversation — is a
   * transparent no-op). Registering an unknown or `external` id is ignored.
   * @param {string} id
   * @param {function(KeyboardEvent): (boolean|undefined)} handler
   * @returns {function(): void} An unregister function.
   */
  register(id, handler) {
    const def = this._defs.get(id);
    if (!def) {
      console.warn(`[KeyShortcutManager] register(): unknown shortcut "${id}"`);
      return () => {};
    }
    if (def.external) {
      console.warn(`[KeyShortcutManager] register(): "${id}" is externally dispatched`);
      return () => {};
    }
    this._handlers.set(id, handler);
    // A registered command is only reachable once the global dispatcher is
    // listening; install lazily so any registrar (header controls, zoom, the
    // conversation commands) activates it without a separate wiring step.
    this.install();
    return () => {
      if (this._handlers.get(id) === handler) this._handlers.delete(id);
    };
  }

  /**
   * @param {KeyboardEvent} e
   * @private
   */
  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return; // IME in progress
    const editable = isEditableTarget(e.target);
    for (const def of this._defs.values()) {
      if (def.external) continue;
      const handler = this._handlers.get(def.id);
      if (!handler) continue;
      if (editable) {
        // In a text field, only fire if the command opts in — and for the
        // 'empty' policy, only when there's no text the keystroke would edit.
        if (!def.allowInInput) continue;
        if (def.allowInInput === 'empty' && !isEditableEmpty(e.target)) continue;
      }
      const binding = this.getBinding(def.id);
      if (!binding || !eventMatchesBinding(binding, e)) continue;
      const acted = handler(e);
      if (acted) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
  }
}

/** The shared singleton. */
const keyShortcutManager = new KeyShortcutManager();
export default keyShortcutManager;
