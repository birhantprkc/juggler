//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * conversation-area-scroll — the scroll controller for conversation-area.js.
 *
 * Each function takes the ConversationArea instance (`area`) as its first
 * argument, in the conversation-area-rendering.js shape. The widget keeps only
 * thin delegates for the entry points other files call.
 *
 * All scrolling is direct, clamped scrollTop math against the #message-list
 * (scrollEndIntoView / scrollElementIntoView), not Element.scrollIntoView:
 * scrollTop is container-scoped and auto-clamped to [0, scrollHeight -
 * clientHeight], so it can neither overshoot nor scroll a parent (e.g. the
 * horizontal column container) as a side effect. The list wrapper never overlaps
 * the composer, so the one correct "end of conversation" position is simply
 * scrollTop = 0 in the column-reverse scroller, which clamps to "end of content
 * at the bottom edge, above the box". Selecting the tail item and every
 * follow-target update share that path.
 *
 * UX rules 6-11 (numbering continues the selection rules in
 * conversation-area-selection.js, which drives most of these):
 *   6/7. Selection (user or auto) of an item → bring the item fully into view
 *      with minimal, clamped movement (scrollElementIntoView). The tail item
 *      routes to scrollEndIntoView (it IS the end).
 *   8. New items arrive but none auto-selected → scroll the follow target
 *      (status spinner or footer) into view, if near bottom.
 *   9. Streaming content grows → keep follow target visible, but only while the
 *      user was already near bottom.
 *  10. LLM busy indicator appears → scroll follow target into view (same
 *      conditions as rule 9).
 *  11. User scrolls far from the bottom (>~20rem) → stop auto-scrolling. No
 *      fighting. Scrolling near the bottom (~20rem) allows auto-scrolling to
 *      continue.
 *
 * The follow target (see getFollowTarget) always sits at the end of the
 * conversation, in priority order:
 *   selected busy thread > any busy thread > footer spinner > footer.
 *   Revealing any of them is the same scrollEndIntoView call.
 *
 * A selection scroll is re-asserted one frame later (see selectItem): the
 * selection triggers a column rebuild whose own rAF callbacks would otherwise
 * perturb scrollTop right after our scroll. Chrome's scroll anchoring hid that;
 * Safari (which has none) showed it as a just-selected tail item jumping down
 * behind the composer. The re-assert makes our scroll the final word.
 *
 * The one call back into the selection engine (the tail test in
 * scrollItemIntoView) goes through the element's public
 * `getSelectableItemIds()`, so this module has no import cycle with its
 * counterpart.
 * @module components/conversation-area-scroll
 */

import { saveScrollState, getScrollState } from '../utils/scroll-persistence.js';
import { MESSAGE_TAGS } from './conversation-area-rendering.js';

/**
 * Rules 6–7: Scroll a selected item into view (minimal movement).
 * Used for user-initiated and auto selection.
 *
 * Selecting the TAIL item means "show me the end of the conversation", so it
 * routes through the one layout-guaranteed scroll (scrollEndIntoView) — the
 * footer, and the composer just below it, pinned to the bottom of the
 * viewport. Any other item gets a minimal, clamped scroll. Neither path uses
 * scrollIntoView, whose ancestor-walking + nearest/end alignment guesswork is
 * exactly what parked the footer past the scroll clamp and shoved the clicked
 * item behind the (tall) composer.
 * `smooth` only applies to the tail/end path (the auto-follow case); a non-tail
 * item gets the same minimal, instant nudge regardless — it's inspection, not
 * an end-follow.
 * @param {any} area - ConversationArea instance
 * @param {string} itemId
 * @param {boolean} [smooth=false]
 */
export function scrollItemIntoView(area, itemId, smooth = false) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return;
  itemId = area._displayIdFor(itemId);
  const el = messageList.querySelector(`[message-id="${itemId}"]`);
  if (!el) return;
  // Detect the tail by SELECTABLE order, not DOM adjacency: a
  // `nextElementSibling === footer` test misfires when a non-selectable
  // trailing element (e.g. a transaction marker) sits between the last
  // selectable item and the footer, which would route a tail selection to the
  // minimal-scroll path instead of the scroll-to-end path.
  const ids = area.getSelectableItemIds();
  if (ids.length > 0 && ids[ids.length - 1] === itemId) {
    scrollEndIntoView(area, smooth);
    return;
  }
  scrollElementIntoView(area, el);
}

/**
 * The single layout-guaranteed scroll: pin the END of all content (the whole
 * footer, plus any queued-message bubbles rendered below it) to the bottom of
 * the message-list viewport. The scroller is column-reverse, so the content
 * end sits at the flex-start edge and "scroll to the end" is simply
 * scrollTop = 0 — clamped by construction, it can neither overshoot nor scroll
 * an ancestor. This is the consistent code-path for "scroll the end of the
 * conversation into view", shared by tail selection and follow-target updates.
 * No scrollIntoView.
 *
 * `smooth` animates the move (used when auto-following the growing end of the
 * conversation), riding the scroller's `scroll-behavior: smooth`. Selection
 * passes `false` to override that with an instant scroll, where a glide would
 * read as lag.
 * @param {any} area - ConversationArea instance
 * @param {boolean} [smooth=false]
 */
export function scrollEndIntoView(area, smooth = false) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return;
  // Reversed scroller: the end of the content sits at the flex-start edge, so
  // "scroll to the end of the conversation" is simply scrollTop = 0 — clamped
  // by construction, it can neither overshoot nor scroll an ancestor. The glide
  // comes from the scroller's CSS scroll-behavior; `instant` opts out per-call.
  messageList.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
}

/**
 * Minimal-movement scroll to bring an element fully into the message-list
 * viewport. Scrolls ONLY the message-list — assigning scrollTop auto-clamps to
 * [0, scrollHeight − clientHeight], so nothing can be driven past the end —
 * never scrollIntoView (which would also scroll ancestors and guess an edge).
 * @param {any} area - ConversationArea instance
 * @param {Element} el
 */
function scrollElementIntoView(area, el) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return;
  const listRect = messageList.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  let delta = 0;
  if (elRect.top < listRect.top) delta = -(listRect.top - elRect.top);
  else if (elRect.bottom > listRect.bottom) delta = elRect.bottom - listRect.bottom;
  if (delta === 0) return;
  // Relative nudge: `delta` comes from viewport rects (direction-agnostic), and
  // in the reversed scroller scrollTop increases toward the content end exactly
  // as it does in a normal column, so the same offset brings the element into
  // view. Clamped, so it can't overshoot. Instant (overriding the scroller's
  // scroll-behavior: smooth) — selection inspection shouldn't glide.
  messageList.scrollTo({ top: messageList.scrollTop + delta, behavior: 'instant' });
}

/**
 * Find the most relevant follow target when auto-following.
 *
 * Key principle: if there's content *after* a candidate, the user has
 * moved past it. Only follow a busy thread when it's the tail of the
 * conversation; otherwise follow the footer (or its spinner). This
 * keeps the auto-follow target glued to where new content is actually
 * appearing, not to a sub-thread tile that happens to still be running
 * higher up the list.
 *
 * Preference order:
 *   1. The currently-selected item, but only if it's a busy thread AND
 *      it sits at the tail of the list (otherwise the selection is an
 *      inspection target, not an "I'm watching this" target).
 *   2. The footer's processing spinner (if visible).
 *   3. A busy thread at the tail of the list.
 *   4. The footer itself.
 *   5. The last rendered element.
 * @param {any} area - ConversationArea instance
 * @returns {Element|null} Element to keep visible while auto-following
 */
function getFollowTarget(area) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return null;

  const footer = messageList.querySelector('conversation-footer');
  const tailEl = footer?.previousElementSibling || messageList.lastElementChild;
  const tailIsBusyThread = tailEl?.tagName === 'THREAD-MESSAGE'
    && !tailEl.getAttribute('result');

  if (area._localSelectedItemId) {
    const selected = messageList.querySelector(`[message-id="${area._localSelectedItemId}"]`);
    if (selected && selected === tailEl && tailIsBusyThread) return selected;
  }

  if (footer) {
    const processing = footer.querySelector('footer-processing');
    if (processing && !processing.classList.contains('hidden')) {
      return processing;
    }
  }

  if (tailIsBusyThread) return tailEl;

  if (footer) return footer;

  return messageList.lastElementChild;
}

/**
 * Rules 7–10: Keep the end of the conversation visible. By default skips work
 * when the view is already pinned to the very bottom of all content (avoids
 * fighting the user's scroll position or causing jank). Pass `force = true` to
 * scroll even from a partially-scrolled position — used on edges that must
 * reveal the end completely (e.g. the processing spinner just becoming visible
 * after a user submit; rules 8 + 10).
 * @param {any} area - ConversationArea instance
 * @param {boolean} [force=false]
 */
export function scrollToFollowIfNeeded(area, force = false) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return;
  if (!getFollowTarget(area)) return;

  if (!force) {
    // "Already there?" — in the reversed scroller the very bottom of ALL
    // content (footer + any queued bubbles) sits at scrollTop 0, so the
    // distance from the bottom is just |scrollTop| (WebKit reports it negative
    // when scrolled up). No scrollHeight/clientHeight arithmetic needed.
    if (Math.abs(messageList.scrollTop) <= 1) return;
  }

  // One consistent, layout-safe code-path: pin the very end of the content
  // (footer + queued items) above the composer, no matter how tall the
  // growable box currently is. Direct clamped scrollTop, never scrollIntoView.
  // Smooth-scroll: this is the deliberate auto-follow of the growing end of the
  // conversation, where a glide reads well. (Selection-driven and correction
  // scrolls call scrollEndIntoView() with no arg and stay instant.)
  scrollEndIntoView(area, true);
}

/**
 * Check if user is currently scrolled near bottom
 * @param {any} area - ConversationArea instance
 * @returns {boolean} True if within 320px (~20rem) of bottom
 */
export function isScrolledNearBottom(area) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return true;

  // Reversed scroller: distance from the bottom is |scrollTop| (0 at bottom).
  if (Math.abs(messageList.scrollTop) <= 320) return true;

  // Last message is at least partially visible (handles tall elements like long responses)
  const footer = messageList.querySelector('conversation-footer');
  const lastMessage = footer?.previousElementSibling;
  if (lastMessage) {
    return lastMessage.getBoundingClientRect().bottom < messageList.getBoundingClientRect().bottom;
  }

  return false;
}

/**
 * The topmost message element still touching the viewport (its bottom edge is
 * at or below the viewport top). Used as the anchor for element-based scroll
 * restore and for holding the reader's place while the tail bubble streams.
 * @param {any} area - ConversationArea instance
 * @returns {HTMLElement|null} Anchor element, or null if the list is empty.
 */
export function topVisibleMessageElement(area) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return null;
  const content = area.querySelector('#message-list-inner');
  if (!content) return null;
  const listTop = messageList.getBoundingClientRect().top;
  for (const el of Array.from(content.children)) {
    if (!MESSAGE_TAGS.has(el.tagName)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > listTop) {
      return /** @type {HTMLElement} */ (el);
    }
  }
  return null;
}

/**
 * Id of the topmost message element whose top edge is at or below the
 * viewport top. Used as the anchor for element-based restore.
 * @param {any} area - ConversationArea instance
 * @returns {string|null} Anchor item id, or null if the list is empty.
 */
function getTopVisibleItemId(area) {
  const el = topVisibleMessageElement(area);
  return el ? el.getAttribute('message-id') : null;
}

/**
 * Persist current scroll state (atBottom + element anchor) to localStorage.
 * Called on pagehide; element-anchored so restore survives content height
 * changes that would invalidate an absolute scrollTop.
 * @param {any} area - ConversationArea instance
 */
export function saveScrollPositionImmediately(area) {
  if (!area._conversation) return;
  saveScrollState(area._conversation.id, {
    atBottom: isScrolledNearBottom(area),
    topItemId: getTopVisibleItemId(area),
  });
}

/**
 * Restore scroll position from localStorage. Called by conversation-tab
 * after messages are rendered. Only restores once per conversation load.
 * @param {any} area - ConversationArea instance
 */
export function restoreScrollPosition(area) {
  if (area._initialScrollRestored) return;
  area._initialScrollRestored = true;

  if (!area._conversation) return;
  const state = getScrollState(area._conversation.id);
  if (!state || state.atBottom) {
    scrollToBottom(area, true);
    return;
  }

  if (state.topItemId) {
    const messageList = area.querySelector('#message-list');
    const anchor = messageList?.querySelector(`[message-id="${state.topItemId}"]`);
    if (anchor) {
      // Restoring to a mid-conversation anchor. scrollIntoView is
      // direction-agnostic — it computes the scrollport offset to land the
      // anchor at block-start regardless of the scroller's flex direction.
      // Instant: this is a one-shot restore on load, not a navigation glide,
      // so it must override the scroller's scroll-behavior: smooth.
      anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
      return;
    }
  }
  scrollToBottom(area, true);
}

/**
 * Scroll to bottom if conditions allow
 * @param {any} area - ConversationArea instance
 * @param {boolean} [force=false] - If true, scroll regardless of user position
 */
export function scrollToBottom(area, force = false) {
  const messageList = area.querySelector('#message-list');
  if (!messageList) return;

  // Don't auto-scroll if user has scrolled away, unless forced
  if (!force && !isScrolledNearBottom(area)) {
    return;
  }

  // Cancel any pending scroll animation to prevent multiple queued scrolls
  if (area._scrollAnimationFrame !== null) {
    window.cancelAnimationFrame(area._scrollAnimationFrame);
  }

  // Queue a single scroll operation
  area._scrollAnimationFrame = window.requestAnimationFrame(() => {
    scrollEndIntoView(area);
    area._scrollAnimationFrame = null;
  });
}
