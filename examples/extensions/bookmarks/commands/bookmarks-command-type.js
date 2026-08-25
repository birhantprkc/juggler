//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { loadBookmarks, formatBookmarks } from '../lib/bookmark-store.js';

/**
 * `/bookmarks` — show the saved bookmarks, without spending a model turn on it.
 *
 * A command is the simplest capability: no LLM, no approval, no tool schema. It
 * runs the moment the user invokes it and returns a message.
 * @augments CommandType
 */
class BookmarksCommandType extends CommandType {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'List the bookmarks saved in this project',
    author: 'Juggler Team'
    // No `mutatesConversation` and no `coalesceUndo`: this command only reads.
    // Set both on any command that writes to the conversation — the first makes
    // the host settle a live turn before execute() runs, the second makes a
    // multi-step change revert as a single undo.
  };

  /**
   * Commands cannot perform host side-effects directly (opening a thread,
   * setting the composer draft). They declare them on `sideEffects` and the host
   * dispatches. This one needs none — it just reports.
   * @param {string[]} args - Arguments after the command name
   * @returns {Promise<import('juggler/command-type').CommandResult>} What to show the user
   */
  async execute(args) {
    const bookmarks = await loadBookmarks();
    if (bookmarks.length === 0) {
      return { handled: true, message: 'Nothing bookmarked yet.' };
    }

    // `/bookmarks foo` filters; bare `/bookmarks` lists everything.
    const filter = (args[0] ?? '').trim().toLowerCase();
    const shown = filter
      ? bookmarks.filter(b => b.name.toLowerCase().includes(filter)
        || b.path.toLowerCase().includes(filter))
      : bookmarks;

    if (shown.length === 0) {
      return { handled: true, message: `Nothing matching "${filter}".` };
    }
    return { handled: true, message: formatBookmarks(shown) };
  }
}

export default BookmarksCommandType;
