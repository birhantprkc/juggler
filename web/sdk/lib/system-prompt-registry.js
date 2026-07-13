//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * System-prompt preset registry — the single in-memory catalog of prompt
 * presets (built-ins shipped here, plus the user's saved presets merged in at
 * runtime). It lives in core (not the juggler-core extension) so that core
 * seeding/UI can depend on it without a core→extension import; the extension's
 * system-prompt context item depends on core, which is the allowed direction.
 *
 * Module singleton: there is exactly one preset catalog app-wide and `import` is
 * the discovery mechanism (see the frontend-service-style note in CLAUDE.md).
 * @module services/system-prompt-registry
 */

/**
 * @typedef {object} SystemPromptPreset
 * @property {string} id - Unique preset identifier (kebab-case)
 * @property {string} name - Display name
 * @property {string} version - Semantic version
 * @property {string} description - Short description
 * @property {string} content - Full prompt body (identity + working guidance, no env block)
 * @property {string} category - Category: "general", "specialized", or "user"
 * @property {boolean} [builtin] - True for shipped presets; false/absent for user-saved ones
 */

/** The id of the built-in preset used as the universal fallback. */
export const BUILTIN_DEFAULT_ID = 'default';

class SystemPromptRegistry {
  constructor() {
    // Insertion-ordered: built-ins register first (in declaration order), then
    // user presets are appended. Categories and per-category lists are derived
    // from this map on demand so removing a user preset needs no bookkeeping.
    /** @type {Map<string, SystemPromptPreset>} @private */
    this._presets = new Map();
  }

  /**
   * Register a preset (built-in or user).
   * @param {SystemPromptPreset} preset - Preset to register
   * @returns {Promise<void>}
   */
  async register(preset) {
    if (!preset.id || !preset.name || !preset.content || !preset.category) {
      throw new Error('Invalid preset: missing required fields (id, name, content, category)');
    }
    this._presets.set(preset.id, preset);
  }

  /**
   * Get a preset by ID
   * @param {string} id - Preset ID
   * @returns {SystemPromptPreset|undefined} Preset if found
   */
  getPreset(id) {
    return this._presets.get(id);
  }

  /**
   * Get all registered presets
   * @returns {SystemPromptPreset[]} Array of all presets
   */
  getAllPresets() {
    return Array.from(this._presets.values());
  }

  /**
   * Get presets by category
   * @param {string} category - Category name
   * @returns {SystemPromptPreset[]} Presets in that category
   */
  getPresetsByCategory(category) {
    const c = category.toLowerCase();
    return this.getAllPresets().filter(p => (p.category || '').toLowerCase() === c);
  }

  /**
   * Get all categories in first-seen order.
   * @returns {string[]} Category names
   */
  getCategories() {
    /** @type {string[]} */
    const seen = [];
    for (const p of this._presets.values()) {
      const c = (p.category || '').toLowerCase();
      if (c && !seen.includes(c)) seen.push(c);
    }
    return seen;
  }

  /**
   * Replace all user (non-built-in) presets with the given list, leaving the
   * built-in presets untouched. Called after fetching the user's presets from
   * the server so the registry reflects the latest saved set. User presets are
   * filed under the `user` category and marked `builtin: false`.
   * @param {Array<{id: string, name: string, content: string}>} presets - User presets from the server
   */
  setUserPresets(presets) {
    for (const [id, p] of [...this._presets]) {
      if (!p.builtin) this._presets.delete(id);
    }
    for (const p of (Array.isArray(presets) ? presets : [])) {
      if (!p || !p.id || !p.name || !p.content) continue;
      this._presets.set(p.id, {
        id: p.id,
        name: p.name,
        content: p.content,
        version: '1.0.0',
        description: 'User-saved preset',
        category: 'user',
        builtin: false
      });
    }
  }
}

const systemPromptRegistry = new SystemPromptRegistry();

/**
 * Neutral, opinion-free working guidance shared by the general-purpose built-in
 * presets. It describes how Juggler operates (the tool loop, code handling, code
 * references) in factual terms that apply to any user and any project — no tone,
 * persona, or workflow preferences. Persona/tone choices belong to whoever
 * writes a custom preset, not to the shipped defaults.
 * @type {string}
 */
const GLOBAL_GUIDANCE =
  '## Responses\n' +
  '- Reply in plain text, Markdown, HTML, or Markdown containing HTML, as best suits the response.\n\n' +
  '## Code\n' +
	'- Match the existing patterns, naming, and formatting of the surrounding code.\n' +
	'- Read the relevant code before changing it.\n' +
	'- When a tool call fails, read the error and adjust your approach.\n\n' +
	'## Code references\n' +
	'Refer to code locations as `file_path:line_number`.';

/** @type {SystemPromptPreset[]} */
const BUILTIN_PRESETS = [
  {
    id: 'default',
    name: 'Default',
    version: '2.0.0',
    description: 'General-purpose coding assistant with neutral working guidance',
    category: 'general',
    builtin: true,
    content: 'You are Juggler, an AI coding assistant.\n\n' + GLOBAL_GUIDANCE
  },
  {
    id: 'minimal',
    name: 'Minimal',
    version: '2.0.0',
    description: 'Just the role — no added guidance',
    category: 'general',
    builtin: true,
    content: 'You are Juggler, a coding assistant.'
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    version: '2.0.0',
    description: 'Review-focused: examines changes for correctness, edge cases, and clarity',
    category: 'specialized',
    builtin: true,
    content:
			'You are Juggler, an AI coding assistant focused on reviewing code. Examine changes for ' +
			'correctness, edge cases, and clarity, and explain the reasoning behind each point you raise.\n\n' +
			GLOBAL_GUIDANCE
  }
];

for (const preset of BUILTIN_PRESETS) {
  systemPromptRegistry.register(preset);
}

/**
 * Get the built-in default preset's content — the universal fallback prompt body
 * used when a conversation has no stored prompt text. Available in every context
 * (including the engine) because the built-ins register at module load.
 * @returns {string} Default prompt body (no env block)
 */
export function getDefaultIdentityText() {
  const preset = systemPromptRegistry.getPreset(BUILTIN_DEFAULT_ID);
  return preset ? preset.content : '';
}

export { systemPromptRegistry, SystemPromptRegistry, GLOBAL_GUIDANCE };
