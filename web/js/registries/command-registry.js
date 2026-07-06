//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';

/**
 * CommandRegistry - JavaScript-based command registry system
 *
 * Manages command plugin loading and lookup.
 * Commands are user-initiated operations (via /command or menu) that execute
 * immediately without LLM involvement or approval flows.
 * @augments {BaseRegistry<typeof import('juggler/command-type').default>}
 */
class CommandRegistry extends BaseRegistry {
  /**
   * Create a new command registry
   */
  constructor() {
    super('CommandRegistry', ['id', 'name', 'version', 'description']);

    /**
     * Map of alias to command ID
     * @type {Map<string, string>}
     * @private
     */
    this._aliasMap = new Map();
  }

  /**
   * Get command capability descriptors (implements abstract method)
   *
   * Returns the command capabilities of every enabled extension — the
   * `@juggler/core` builtin extension and any user/project extensions. The ID is
   * extracted from each class's MANIFEST.id property.
   * @returns {Promise<import('../services/extensions.js').CapabilityRef[]>} Capability descriptors
   * @protected
   */
  async getModulePaths() {
    return getExtensionCapabilities('command');
  }

  /**
   * Initialize the registry, building alias map
   * @returns {Promise<void>}
   */
  async init() {
    await super.init();
    this._buildAliasMap();
  }

  /**
   * Build the alias map from registered commands
   * @private
   */
  _buildAliasMap() {
    this._aliasMap.clear();
    for (const { class: CommandClass } of this.getAll()) {
      const CommandClassTyped = /** @type {any} */ (CommandClass);
      const manifest = CommandClassTyped.MANIFEST;
      if (manifest.alias) {
        this._aliasMap.set(manifest.alias.toLowerCase(), manifest.id);
      }
    }
  }

  /**
   * Get command class by name or alias
   *
   * Looks up a command by its ID or alias (case-insensitive).
   * @param {string} name - Command name or alias
   * @returns {typeof import('juggler/command-type').default|undefined} Command class or undefined
   */
  getByNameOrAlias(name) {
    const lower = name.toLowerCase();

    // Try direct ID first
    const cls = this.get(lower);
    if (cls) return cls;

    // Try alias
    const id = this._aliasMap.get(lower);
    if (id) return this.get(id);

    return undefined;
  }

  /**
   * Check if a command exists by name or alias
   * @param {string} name - Command name or alias
   * @returns {boolean} True if command exists
   */
  hasByNameOrAlias(name) {
    return this.getByNameOrAlias(name) !== undefined;
  }
}

// Create and export singleton registry instance
const commandRegistry = new CommandRegistry();

export default commandRegistry;
