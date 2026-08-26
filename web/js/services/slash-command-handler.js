//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Slash Command Handler - Manages text-based slash commands
 * @module services/slash-command-handler
 */

import commandRegistry from '../registries/command-registry.js';

/**
 * @typedef {object} SlashCommandResult
 * @property {boolean} handled - Whether the command was recognized and executed
 * @property {string} [message] - Optional message to display to user
 * @property {boolean} [error] - Whether this was an error
 * @property {import('juggler/command-type').CommandSideEffect[]} [sideEffects] - Declarative side-effects
 */

/**
 * @typedef {object} SlashCommand
 * @property {string} name - Command name (without /)
 * @property {string} [label] - Display label for menu (defaults to capitalized name)
 * @property {string} description - Help text for the command
 * @property {boolean} [danger] - Whether this is a destructive action (for menu styling)
 * @property {string} [icon] - CSS class for menu icon (e.g. 'icon-trashcan')
 * @property {boolean} [userDefined] - Whether this is a user-defined (declarative) command
 * @property {string} [scope] - Provenance scope of a user command ('user' | 'project')
 * @property {string} [argsHint] - Ghost-text hint shown after accepting the command
 */

/**
 * Handles slash command execution via plugin registry
 */
class SlashCommandHandler {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;
  }

  /**
   * Initialize the command registry
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      return;
    }
    await commandRegistry.init();
    this._initialized = true;
  }

  /**
   * Execute a slash command from user input.
   * Commands receive only the messageThread — they operate exclusively via the Yjs document.
   * @param {string} input - Full user input (e.g. "/clear")
   * @param {import('../model/message-thread.js').MessageThread} [messageThread] - Column-scoped message thread
   * @returns {Promise<SlashCommandResult>} The result of command execution
   */
  async execute(input, messageThread) {
    await this.init();

    if (!/^\/[a-zA-Z]/.test(input)) {
      return { handled: false };
    }

    const [commandName, ...args] = input.slice(1).split(/\s+/);
    const CommandClass = commandRegistry.getByNameOrAlias(/** @type {string} */ (commandName));

    if (!CommandClass) {
      return {
        handled: true,
        message: `Unknown command: /${commandName}`,
        error: true
      };
    }

    const conv = messageThread?.conversation;

    // Some mutations have no sensible mid-turn semantics. In particular, a
    // user-created thread cannot yet be queued like a regular message, so reject
    // it without interrupting the active agent. The UI mirrors this guard, but
    // enforcement belongs here so typed commands and other callers cannot bypass
    // it.
    if (CommandClass.MANIFEST?.rejectWhileBusy && conv?.isTurnActive()) {
      return {
        handled: true,
        message: 'Wait for the current turn to finish before creating a new thread.',
        error: true
      };
    }

    // Architectural invariant: commands that will mutate the conversation
    // (snapshot/move/delete items, clear history, insert threads) must
    // never run while a turn is in flight. The handler is the single
    // chokepoint that enforces this — individual commands stay ignorant
    // of cancel/settle semantics. Without this, /compact firing during a
    // live bash action snapshots a `state: 'running'` item into the new
    // sub-thread where nothing will ever flip it to cancelled/completed.
    if (CommandClass.MANIFEST?.mutatesConversation && conv) {
      await conv.cancelAndSettle('slash command');
    }

    const command = new CommandClass({
      messageThread: messageThread || undefined
    });

    // Close the worker UndoManager's capture window before the command
    // runs so its mutations (insertThread, etc.) form their own undo
    // group, separate from anything that happened in the prior 20 ms.
    // Commands that declare coalesceUndo want their whole (possibly async,
    // multi-step) mutation sequence to revert in a single undo — bracket
    // execute() with the worker's coalescing markers so every group it adds
    // collapses into one. The markers ride the same ordered worker channel
    // as the command's yjs-sync frames, so begin lands before the first
    // write and end after the last.
    const coalesceUndo = CommandClass.MANIFEST?.coalesceUndo && conv?.id;
    if (conv?.id) {
      const { default: workerManager } = await import('./worker-manager.js');
      workerManager.stopUndoCapturing(conv.id);
      if (coalesceUndo) await workerManager.beginUndoCoalescing(conv.id);
    }

    try {
      return await command.execute(args);
    } finally {
      if (coalesceUndo) {
        const { default: workerManager } = await import('./worker-manager.js');
        await workerManager.endUndoCoalescing(conv.id);
      }
    }
  }

  /**
   * Get all registered commands (for menu UI and /help)
   * @returns {SlashCommand[]} Array of registered commands
   */
  getCommands() {
    if (!this._initialized) {
      return [];
    }

    return commandRegistry.getAll().map((/** @type {{id: string, class: any}} */ item) => {
      const manifest = item.class.MANIFEST;
      return {
        name: manifest.id,
        label: manifest.name,
        description: manifest.description,
        danger: manifest.danger || false,
        icon: manifest.icon || '',
        userDefined: manifest.userDefined || false,
        scope: manifest.scope || '',
        argsHint: manifest.argsHint || ''
      };
    });
  }

  /**
   * Check if a command exists
   * @param {string} name - Command name or alias
   * @returns {boolean} True if command exists
   */
  hasCommand(name) {
    if (!this._initialized) {
      return false;
    }
    return commandRegistry.hasByNameOrAlias(name);
  }
}

// Export singleton instance
const slashCommandHandler = new SlashCommandHandler();
export default slashCommandHandler;
