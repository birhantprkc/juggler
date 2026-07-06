//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import slashCommandHandler from '../services/slash-command-handler.js';
import { longestCommonPrefix } from './completion-menu.js';

/**
 * The `/` slash-command completion source for {@link CompletionMenu}.
 *
 * Fires only when the message begins with `/` and the caret is still inside
 * that first command token (no space typed yet) — so it never competes with an
 * `@` mention or a `/` typed mid-sentence, and matches the "slash at the start
 * of the message" affordance. Accepting a command inserts its text (`/name `)
 * and leaves the caret there; the user presses Enter to run it, exactly like
 * an accepted `@` mention only splices text.
 * @module components/slash-command-provider
 */

/**
 * The `/` slash-command completion provider.
 * @type {import('./completion-menu.js').CompletionProvider}
 */
export const slashCommandProvider = {
  id: 'slash-command',
  emptyLabel: 'No commands',

  detect(textBefore) {
    // Start-anchored: the `/` must be the first character of the message and
    // everything up to the caret must still be command-name chars (no space —
    // once the user types an argument the command name is settled).
    const match = textBefore.match(/^\/([a-zA-Z][\w-]*)?$/);
    if (!match) return null;
    return { anchorPos: 0, query: match[1] ?? '' };
  },

  async fetch(query) {
    await slashCommandHandler.init();
    const q = query.toLowerCase();
    return slashCommandHandler.getCommands()
      .filter(c => c.name.toLowerCase().startsWith(q) || (c.label?.toLowerCase().startsWith(q) ?? false))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  renderItem(cmd) {
    const li = document.createElement('li');
    li.className = 'menu-item slash-command-item' + (cmd.danger ? ' danger' : '');
    li.dataset.command = cmd.name;

    const code = document.createElement('code');
    code.className = 'menu-item-command';
    code.textContent = '/' + cmd.name;
    li.appendChild(code);

    const desc = document.createElement('span');
    desc.className = 'menu-item-desc';
    desc.textContent = cmd.label || (cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1));
    li.appendChild(desc);

    return li;
  },

  insert(cmd) {
    return '/' + cmd.name + ' ';
  },

  tabCompleteReplacement(items, query) {
    const lcp = longestCommonPrefix(items.map(c => c.name));
    return lcp.length > query.length ? '/' + lcp : null;
  },
};
