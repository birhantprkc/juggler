//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import InfoCardType from 'juggler/info-card-type';
import { loadBookmarks } from '../lib/bookmark-store.js';

/** How often to re-read the store while the card is on screen. */
const REFRESH_MS = 15000;

/**
 * Last known bookmarks, held OUTSIDE the class on purpose.
 *
 * The rail drops the lowest-priority card when the column runs short of room and
 * rebuilds it from scratch when the room comes back, so `mount()` runs far more
 * often than a card's lifetime suggests. Caching here means a resize repaints
 * from memory instead of firing a read per mount.
 * @type {import('../lib/bookmark-store.js').Bookmark[]}
 */
let cached = [];

/**
 * Sidebar tile listing the current bookmarks.
 *
 * Info cards are viewer-only — they touch the DOM and never run in the engine,
 * so unlike the other capability types there is no worker twin to worry about.
 * @augments InfoCardType
 */
class BookmarksCard extends InfoCardType {
  static MANIFEST = {
    id: 'bookmarks',
    name: 'Bookmarks',
    version: '1.0.0',
    description: 'List this project’s saved bookmarks in the sidebar.',
    eyebrow: 'Bookmarks',
    // Lower priority than the built-in cards, so this one is dropped first when
    // the rail runs out of room rather than pushing Git status off the bottom.
    priority: 5
  };

  /**
   * Drop the card from the rail entirely when there is nothing to show, rather
   * than occupying space with an empty state.
   * @returns {boolean} Whether there is anything to render
   */
  hasContent() {
    return cached.length > 0;
  }

  /**
   * Paint from cache immediately, then refresh quietly.
   *
   * The teardown return is not optional bookkeeping: without it the interval
   * outlives the element and every rail resize leaves another one running.
   * @param {HTMLElement} contentEl - The content region to populate
   * @returns {() => void} Teardown
   */
  mount(contentEl) {
    let disposed = false;

    const paint = () => {
      contentEl.replaceChildren();
      const list = document.createElement('ul');
      for (const bookmark of cached.slice(-8).reverse()) {
        const li = document.createElement('li');
        // textContent, never innerHTML: these strings came from a file on disk.
        li.textContent = bookmark.line ? `${bookmark.name} — ${bookmark.path}:${bookmark.line}`
          : `${bookmark.name} — ${bookmark.path}`;
        list.appendChild(li);
      }
      contentEl.appendChild(list);
    };

    const refresh = async () => {
      const bookmarks = await loadBookmarks();
      if (disposed) return;
      cached = bookmarks;
      paint();
    };

    paint();
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }
}

export default BookmarksCard;
