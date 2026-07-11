//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import slashCommandHandler from '../services/slash-command-handler.js';
import { longestCommonPrefix } from './completion-menu.js';
import { openCommandEditor } from './command-editor-dialog.js';

/**
 * The `/` slash-command completion source for {@link CompletionMenu}.
 *
 * Fires only when the message begins with `/` and the caret is still inside
 * that first command token (no space typed yet) — so it never competes with an
 * `@` mention or a `/` typed mid-sentence, and matches the "slash at the start
 * of the message" affordance. Accepting a command inserts its text (`/name `)
 * and leaves the caret there; the user presses Enter to run it, exactly like
 * an accepted `@` mention only splices text.
 *
 * User-defined commands appear alongside built-ins with a small provenance badge
 * ("user"/"project"). A pinned "New command…" row is always offered last so that
 * typing a name that does not exist becomes the discovery path for creating one.
 * @module components/slash-command-provider
 */

/**
 * The sentinel item accepted to open the command editor. Kept distinct from a
 * real command (which has `name`) so `accept`/`insert` can special-case it.
 * @type {{action: 'new-command', query: string}}
 */
const NEW_COMMAND_SENTINEL = { action: 'new-command', query: '' };

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
    // Items are opaque to the menu, and the list mixes real commands with a
    // synthetic "New command…" row, so it is typed loosely.
    const matches = /** @type {any[]} */ (slashCommandHandler.getCommands()
      .filter(c => c.name.toLowerCase().startsWith(q) || (c.label?.toLowerCase().startsWith(q) ?? false))
      .sort((a, b) => a.name.localeCompare(b.name)));
    // Pin a "New command…" row at the end so an unmatched query (e.g. /standup)
    // becomes the create path. It carries the current query to pre-fill the name.
    matches.push({ ...NEW_COMMAND_SENTINEL, query });
    return matches;
  },

  renderItem(cmd) {
    if (cmd.action === 'new-command') {
      const li = document.createElement('li');
      li.className = 'menu-item slash-command-item slash-command-new';
      li.dataset.command = '__new__';
      const code = document.createElement('code');
      code.className = 'menu-item-command';
      code.textContent = cmd.query ? `New command “/${cmd.query}”…` : 'New command…';
      li.appendChild(code);
      return li;
    }

    const li = document.createElement('li');
    li.className = 'menu-item slash-command-item' + (cmd.danger ? ' danger' : '');
    li.dataset.command = cmd.name;

    const code = document.createElement('code');
    code.className = 'menu-item-command';
    code.textContent = '/' + cmd.name;
    li.appendChild(code);

    // Provenance badge for user-defined commands (built-ins carry none).
    if (cmd.userDefined && cmd.scope) {
      const badge = document.createElement('span');
      badge.className = 'slash-command-scope-badge slash-command-scope-' + cmd.scope;
      badge.textContent = cmd.scope;
      li.appendChild(badge);
    }

    const desc = document.createElement('span');
    desc.className = 'menu-item-desc';
    desc.textContent = cmd.description || cmd.label || (cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1));
    li.appendChild(desc);

    return li;
  },

  insert(cmd) {
    if (cmd.action === 'new-command') {
      // Opening the editor is a side effect; the accepted text is cleared so the
      // half-typed "/name" does not linger while the dialog is open.
      openCommandEditor({ name: cmd.query || '' });
      return '';
    }
    return '/' + cmd.name + ' ';
  },

  tabCompleteReplacement(items, query) {
    // Only real commands participate in prefix completion — the pinned row's
    // synthetic query field must not pollute the longest-common-prefix.
    const names = items.filter(c => c.action !== 'new-command').map(c => c.name);
    const lcp = longestCommonPrefix(names);
    return lcp.length > query.length ? '/' + lcp : null;
  },
};
