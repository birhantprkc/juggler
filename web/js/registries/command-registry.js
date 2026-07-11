//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import BaseRegistry from './base-registry.js';
import { getExtensionCapabilities } from '../services/extensions.js';
import { getRegisterableUserCommands } from '../services/user-commands.js';
import { makeUserCommandClass } from '../plugins/user-command-factory.js';

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
   *
   * After loading extension-provided command modules (the base `init`), the
   * declarative user-defined commands are synthesised and registered as a second
   * source. They register *after* extensions so a user command can never shadow
   * a built-in/extension command — `registerClass` refuses the collision and it
   * surfaces in the manager UI.
   * @returns {Promise<void>}
   */
  async init() {
    await super.init();
    await this._registerUserCommands();
    this._buildAliasMap();
  }

  /**
   * Fetch the registerable user-command definitions (valid, project-shadowed)
   * and register a synthesised class for each. Failures are non-fatal — a broken
   * definition never blocks the built-in commands from loading.
   * @returns {Promise<void>}
   * @private
   */
  async _registerUserCommands() {
    try {
      const defs = await getRegisterableUserCommands();
      for (const def of defs) {
        const CommandClass = makeUserCommandClass(def);
        this.registerClass(CommandClass, {
          extensionId: null,
          modulePath: `user-command:${def.scope}/${def.name}`,
        });
      }
    } catch (err) {
      console.warn('[CommandRegistry] Failed to register user commands:', err);
    }
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
