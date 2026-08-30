//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two pinned buttons above a command list — "Edit custom slash commands…"
 * and "Browse built-in commands…" — shared by every surface that lists slash
 * commands: the typed-`/` completion menu, the composer's `/` button dropdown,
 * and the mobile actions sheet.
 *
 * That a user can write their own commands is not something a list of commands
 * conveys — `/commands` sitting among them reads as one more command to run, not
 * as the way in. Each surface therefore pins the editor as a button above its
 * list and drops the plain `/commands` row, since the button IS that command:
 * two rows for one action would be worse than none. The second button hands the
 * built-ins to the place that already documents every capability the app loads,
 * so neither list has to be two lists.
 * @module services/command-manager-entry
 */

/** Id of the built-in command that opens the manager. */
export const MANAGER_COMMAND_ID = 'commands';

/** Label of the button opening the custom-command manager. */
export const MANAGE_COMMANDS_LABEL = 'Edit custom slash commands…';

/** Label of the button opening the built-ins in the Extensions settings. */
export const BROWSE_COMMANDS_LABEL = 'Browse built-in commands…';

/**
 * A command list with the manager command removed — for surfaces showing the
 * pinned button in its place.
 * @template {{name: string}} T
 * @param {T[]} commands - Commands to filter
 * @returns {T[]} The list without the manager command
 */
export function withoutManagerCommand(commands) {
  return commands.filter((c) => c.name !== MANAGER_COMMAND_ID);
}

/**
 * Build a pinned row: the label alone, with no `/` glyph. The other rows earn
 * their slash by being the command you type; these are buttons, and a bare `/`
 * beside "Edit custom slash commands…" only reads as a command name that went
 * missing. The caller owns the click wiring, since each surface dismisses itself
 * differently.
 * @param {string} label - Button text
 * @param {string} extraClass - Surface-specific class alongside the shared ones
 * @param {boolean} last - True for the final button of the pair, which carries
 *   the rule separating the pair from the commands below it
 * @returns {HTMLLIElement} The row element
 */
function buildPinnedRow(label, extraClass, last) {
  const row = document.createElement('li');
  row.className = ('menu-item slash-command-pinned ' + (last ? 'slash-command-pinned-last ' : '') + extraClass).trim();

  const text = document.createElement('span');
  text.className = 'slash-command-pinned-label';
  text.textContent = label;
  row.appendChild(text);

  return row;
}

/**
 * Build the "Edit custom slash commands…" row.
 * @param {string} [extraClass] - Surface-specific class alongside the shared ones
 * @returns {HTMLLIElement} The row element
 */
export function buildManageCommandsRow(extraClass = '') {
  const row = buildPinnedRow(MANAGE_COMMANDS_LABEL, extraClass, false);
  row.dataset.command = MANAGER_COMMAND_ID;
  return row;
}

/**
 * Build the "Browse built-in commands…" row.
 * @param {string} [extraClass] - Surface-specific class alongside the shared ones
 * @returns {HTMLLIElement} The row element
 */
export function buildBrowseCommandsRow(extraClass = '') {
  return buildPinnedRow(BROWSE_COMMANDS_LABEL, extraClass, true);
}
