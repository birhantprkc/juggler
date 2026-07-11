//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';

/**
 * Commands manager - open the user-defined slash-command manager.
 *
 * Lists every slash command grouped by origin (built-in / this project / all
 * projects) with edit, delete, and "new command" actions. The dialog itself is
 * a host UI surface, so this command only declares the intent via a side effect.
 */
class CommandsCommandType extends CommandType {
  static MANIFEST = {
    id: 'commands',
    name: 'Manage Commands',
    version: '1.0.0',
    description: 'Create and manage user-defined slash commands',
    icon: 'icon-slash',
  };

  /**
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute() {
    return { handled: true, sideEffects: [{ type: 'openCommandManager' }] };
  }
}

export default CommandsCommandType;
