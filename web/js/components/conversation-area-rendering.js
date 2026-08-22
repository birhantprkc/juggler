//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * conversation-area-rendering — pure-function helpers for conversation-area.js,
 * keeping the widget itself focused on lifecycle, selection, scroll, and footer
 * state.
 *
 * Each helper takes the ConversationArea instance (`area`) as its first
 * argument when it needs to read widget state. Otherwise they're plain
 * DOM-in/DOM-out functions.
 *
 * # ID-Based DOM diffing
 *
 * Conversation items don't map 1:1 to DOM elements — an item can produce
 * 0 elements (e.g. an empty assistant message, a context-item placeholder
 * with isNew=false, a tool-action whose result is a context item). So we
 * look up elements by `message-id`, never by position.
 *
 * Algorithm:
 *   1. Build Map<id, element> of current DOM.
 *   2. Build Set<id> of items that should be kept.
 *   3. Remove elements not in the keep-set (do this BEFORE positioning —
 *      stale elements break `nextSibling` checks).
 *   4. Iterate items backwards, `insertBefore(el, nextEl)`. If the element
 *      exists, move it if needed; otherwise create it.
 * @module components/conversation-area-rendering
 */

import {
  isUserMessage,
  isAssistantMessage,
  isThinkingMessage,
  isProviderStateMessage,
  isToolActionMessage,
  isErrorMessage,
  isNoticeMessage,
  isThreadMessage,
} from '../../sdk/lib/message.js';
import { isGroupEntry } from '../utils/item-grouping.js';
import { wrapWithIcon } from '../utils/icon-message-renderer.js';
import { normalizeAttachments } from '../utils/attachments.js';
import { renderAssistantContentWrapped, decorateCodeBlocks } from '../../sdk/lib/markdown.js';
import { stripThinkingTags } from '../utils/content-utils.js';
import { itemGoal } from '../model/thread-alias.js';

/** @typedef {import('../../sdk/lib/message.js').Message} Message */

// DOM element tag names - constants to avoid typos
const FOOTER_TAG = 'CONVERSATION-FOOTER';
const THREAD_ACTIONS_TAG = 'THREAD-COLUMN-ACTIONS';

// Synthesized non-item elements managed outside the item-diff (like the footer
// and context toggle): the terminal thread-result block. Excluded from
// buildElementMap/removeAllElements so the diff never tears it down.
const THREAD_RESULT_CLASS = 'thread-result-final';

// Queued-message zone: a managed non-item container rendered AFTER the footer,
// holding bubbles for messages typed while a turn was in flight. Its bubbles are
// nested (grandchildren of the message list) so the message-id item-diff never
// sees them, but they DO carry message-id so the standard id+DOM selection path
// treats them as first-class (select, properties panel, delete).
const PENDING_ZONE_CLASS = 'pending-messages';

// Corner-up-left "return" arrow — the summary is what the thread came back with.
const RESULT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14" fill="white"><path d="M280-200v-80h360q33 0 56.5-23.5T720-360q0-33-23.5-56.5T640-440H300l84 84-56 56-180-180 180-180 56 56-84 84h340q66 0 113 47t47 113q0 66-47 113t-113 47H280Z"/></svg>';

/**
 * True for a child managed outside the item-diff: the footer and synthesized
 * terminal thread-result block. These are not conversation items and must not be
 * removed by the message-id diff.
 * @param {Element} child
 * @returns {boolean} True if the element is a managed non-item.
 */
function isManagedNonItem(child) {
  return child.tagName === FOOTER_TAG ||
    child.tagName === THREAD_ACTIONS_TAG ||
    child.classList.contains(THREAD_RESULT_CLASS) ||
    child.classList.contains(PENDING_ZONE_CLASS);
}

/**
 * Render the thread's queued (pending) messages in a zone pinned after the
 * footer. Each queued message is a real user bubble carrying its message-id, so
 * the existing selection/properties/delete machinery treats it like any item.
 * Diffs by message-id within the zone so unchanged bubbles are preserved, and
 * removes the zone entirely when the queue drains.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} messageList
 */
export function ensurePendingMessages(area, messageList) {
  // A group column shares the parent column's thread, so its queue is the
  // parent's queue — messages typed against a thread, with nothing to do with
  // the run of tool rows this column shows. Treated as empty, which also clears
  // the zone from a column reused as a group column.
  const thread = area?._isGroupColumn ? null : area?._messageThread;
  const pending = (thread && 'pendingItems' in thread) ? thread.pendingItems : [];

  let zone = /** @type {HTMLElement|null} */ (messageList.querySelector(`.${PENDING_ZONE_CLASS}`));

  // The queue can also hold @-mention / dropped-file reads enqueued alongside a
  // message typed while busy (see MessageThread.enqueuePendingItem). Those are
  // not user messages and have no queued bubble of their own — they surface in
  // the main list when the worker promotes the group. Only user messages get a
  // queued bubble here, so the zone is driven purely by the queued user messages
  // (a queue holding only not-yet-joined reads shows nothing).
  const pendingUsers = (pending || []).filter((/** @type {any} */ it) => isUserMessage(it));

  if (pendingUsers.length === 0) {
    if (zone) zone.remove();
    return;
  }

  if (!zone) {
    zone = document.createElement('div');
    zone.className = PENDING_ZONE_CLASS;
    const label = document.createElement('div');
    label.className = 'pending-messages-label';
    label.textContent = 'Queued';
    zone.appendChild(label);
  }
  // Keep the zone pinned at the very end (after the footer).
  if (messageList.lastElementChild !== zone) {
    messageList.appendChild(zone);
  }

  // Diff bubbles by message-id; drop any whose pending item is gone.
  const wantedIds = new Set(pendingUsers.map((/** @type {any} */ it) => it.get('itemId')));
  for (const child of Array.from(zone.querySelectorAll('[message-id]'))) {
    if (!wantedIds.has(child.getAttribute('message-id'))) child.remove();
  }
  // Create/reposition bubbles in queue order (re-append keeps the label first).
  for (const item of pendingUsers) {
    const id = item.get('itemId');
    let el = /** @type {HTMLElement|null} */ (zone.querySelector(`[message-id="${id}"]`));
    if (!el) {
      el = createUserBubble(item);
      if (el) el.classList.add('queued-message');
    }
    if (el) {
      zone.appendChild(el);
      ensureQueuedDeleteButton(area, el, id);
    }
  }
}

/**
 * Ensure a queued message has its inline remove-from-queue affordance. Kept
 * outside `<article>` so user-message can keep rendering/copy behavior exactly
 * like a normal user bubble while the pending zone adds queue-only controls.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} el - The queued user-message element
 * @param {string} itemId - Pending item id
 */
function ensureQueuedDeleteButton(area, el, itemId) {
  let button = /** @type {HTMLButtonElement|null} */ (el.querySelector(':scope > .queued-message-delete-btn'));
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'queued-message-delete-btn icon-btn';
    button.title = 'Remove from queue';
    button.setAttribute('aria-label', 'Remove queued message');
    button.innerHTML = '<span class="icon-trashcan"></span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      area?._messageThread?.removeItemById?.(itemId);
    });
    el.appendChild(button);
  }
}

// Message types - elements are identified by message-id attribute
export const MESSAGE_TAGS = new Set([
  'USER-MESSAGE',
  'ASSISTANT-MESSAGE',
  'THINKING-MESSAGE',
  'CONTEXT-ITEM-MESSAGE',
  'ERROR-MESSAGE',
  'NOTICE-MESSAGE',
  'COMPACT-SUMMARY-MESSAGE',
  'TOOL-ACTION-MESSAGE',
  'TOOL-GROUP-MESSAGE'
]);

// Element ID format helpers
const INVALID_ID_MARKER = 'null';  // IDs containing this are invalid

/**
 * Get unique ID for an item. INVARIANT: items MUST have itemId.
 * @param {any} item
 * @returns {string} Item ID (e.g., "message:abc123")
 */
export function getItemId(item) {
  const message = /** @type {any} */ (item);
  return `message:${message.get('itemId') || ''}`;
}

/**
 * Get unique ID for a DOM element. INVARIANT: elements MUST have message-id.
 * @param {Element} element
 * @returns {string} Element ID (e.g., "message:abc123")
 */
function getElementId(element) {
  return `message:${element.getAttribute('message-id') || ''}`;
}

/**
 * Ensure footer element exists in message list. Creates it if missing.
 * @param {any} area - ConversationArea instance (provides _messageThread)
 * @param {HTMLElement} messageList
 * @returns {HTMLElement} Footer element
 */
export function ensureFooterExists(area, messageList) {
  let footer = /** @type {import('./conversation-footer.js').default|null} */ (messageList.querySelector('conversation-footer'));
  if (!footer) {
    footer = /** @type {import('./conversation-footer.js').default} */ (document.createElement('conversation-footer'));
    /** @type {any} */ (footer).setMessageThread(area._messageThread);
    messageList.appendChild(footer);
  }
  return footer;
}

/**
 * Remove all elements from message list except footer and context toggle.
 * @param {HTMLElement} messageList
 */
export function removeAllElements(messageList) {
  const children = Array.from(messageList.children);
  for (const child of children) {
    if (!isManagedNonItem(child)) {
      child.remove();
    }
  }
}

/**
 * Ensure the terminal thread-result block reflects a compaction fold's `result`.
 *
 * `result` is a field on the thread Y.Map, not an item, so the item list never
 * renders it. This synthesizes a terminal block from that field and keeps it
 * pinned just before the footer. Idempotent: updates in place, repositions, or
 * removes.
 *
 * A compaction fold alone renders it. The fold's transcript is folded away and
 * the summariser's text is all that stands for it, so the block IS the column —
 * and it carries the Re-summarise button, the only way to write that text again.
 * Every other thread answers its caller through its runs and ends on the reply
 * its last run came to rest on, so a block underneath that message would say the
 * same thing twice.
 * @param {any} area - ConversationArea instance (provides `_threadYMap`).
 * @param {HTMLElement} messageList
 * @param {HTMLElement} footer
 */
export function ensureThreadResult(area, messageList, footer) {
  const existing = /** @type {HTMLElement|null} */ (
    messageList.querySelector(`.${THREAD_RESULT_CLASS}`));

  const threadYMap = area?._threadYMap;
  const isFold = threadYMap?.get?.('boundedCompaction') === true;
  const result = threadYMap?.get?.('result');
  const text = (isFold && typeof result === 'string') ? result : '';

  if (!text) {
    if (existing) existing.remove();
    return;
  }

  if (existing) {
    // Re-render the body only when the result text actually changed, so a
    // routine re-render doesn't thrash the DOM.
    if (existing.dataset.result !== text) {
      existing.dataset.result = text;
      const body = /** @type {HTMLElement|null} */ (existing.querySelector('.thread-result-body'));
      if (body) {
        body.innerHTML = renderAssistantContentWrapped(stripThinkingTags(text));
        decorateCodeBlocks(body);
      }
    }
    // Keep it pinned immediately before the footer (after the last item).
    if (existing.nextSibling !== footer) {
      messageList.insertBefore(existing, footer);
    }
    return;
  }

  const block = document.createElement('div');
  block.className = `conversation-item ${THREAD_RESULT_CLASS}`;
  block.dataset.result = text;

  const content = document.createElement('div');
  content.className = 'thread-result-content';

  const header = document.createElement('div');
  header.className = 'thread-result-header';
  const label = document.createElement('div');
  label.className = 'thread-result-label';
  label.textContent = 'Summary';
  header.appendChild(label);

  const headerActions = document.createElement('div');
  headerActions.className = 'thread-result-header-actions';
  header.appendChild(headerActions);

  // A fold is frozen transcript whose summary the folded-compaction summariser
  // wrote once; nothing else will ever refresh it, so Re-summarise is the only
  // route to a different one.
  const resummariseBtn = document.createElement('button');
  resummariseBtn.type = 'button';
  resummariseBtn.className = 'thread-result-resummarise-btn';
  resummariseBtn.title = 'Summarise this fold again';
  resummariseBtn.setAttribute('aria-label', 'Summarise this fold again');
  resummariseBtn.textContent = 'Re-summarise';
  resummariseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const tid = threadYMap?.get?.('itemId');
    if (!tid || !area?._conversation) return;
    void area._conversation.resolveMessageThread(tid).resummariseFold();
  });
  headerActions.appendChild(resummariseBtn);

  // Expand and Promote live at the start of the thread's scrollable transcript.

  const body = document.createElement('div');
  body.className = 'thread-result-body markdown';
  body.innerHTML = renderAssistantContentWrapped(stripThinkingTags(text));
  decorateCodeBlocks(body);
  content.appendChild(header);
  content.appendChild(body);

  block.appendChild(wrapWithIcon(content, { color: 'purple', iconSvg: RESULT_ICON_SVG }));
  messageList.insertBefore(block, footer);
}

/**
 * Build map of existing elements by ID.
 * @param {HTMLElement} messageList
 * @returns {Map<string, HTMLElement>} Map of element ID to element
 */
export function buildElementMap(messageList) {
  const elementMap = new Map();
  const children = Array.from(messageList.children);
  for (const child of children) {
    if (isManagedNonItem(child)) continue;

    const id = getElementId(/** @type {HTMLElement} */ (child));
    if (id && !id.includes(INVALID_ID_MARKER)) {
      elementMap.set(id, /** @type {HTMLElement} */ (child));
    }
  }
  return elementMap;
}

/**
 * Identify which elements should be kept (exist in items).
 * @param {Array<any>} items
 * @param {Map<string, HTMLElement>} currentElements
 * @returns {Set<string>} Set of element IDs to keep
 */
export function identifyElementsToKeep(items, currentElements) {
  const idsToKeep = new Set();
  for (const item of items) {
    if (!item) continue;
    const itemId = getItemId(item);
    if (currentElements.has(itemId)) {
      idsToKeep.add(itemId);
    }
  }
  return idsToKeep;
}

/**
 * Remove elements that are no longer in items.
 * CRITICAL: Must happen BEFORE positioning (affects nextSibling checks).
 * @param {Map<string, HTMLElement>} currentElements
 * @param {Set<string>} elementsToKeep
 */
export function removeDeletedElements(currentElements, elementsToKeep) {
  for (const [id, element] of currentElements) {
    if (!elementsToKeep.has(id)) {
      element.remove();
      currentElements.delete(id);
    }
  }
}

/**
 * Position elements in correct order (backwards iteration, insert before next).
 * Elements handle their own updates via Yjs observers - this just creates/removes/positions.
 * @param {any} area - ConversationArea instance (passed to bubble creators that need _messageThread)
 * @param {HTMLElement} messageList
 * @param {HTMLElement} footer
 * @param {Array<any>} items
 * @param {Map<string, HTMLElement>} currentElements
 */
export function positionElements(area, messageList, footer, items, currentElements) {
  let insertBefore = footer;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;

    const itemId = getItemId(item);
    const existingElement = currentElements.get(itemId);

    if (existingElement) {
      // Update item-index attribute to match current position
      const currentIndex = existingElement.getAttribute('item-index');
      if (currentIndex !== i.toString()) {
        existingElement.setAttribute('item-index', i.toString());
      }

      // Sync content from live Yjs item for streamable elements
      if (typeof /** @type {any} */ (existingElement).updateFromItem === 'function') {
        /** @type {any} */ (existingElement).updateFromItem(item);
      }

      // Reposition if needed
      if (existingElement.nextSibling !== insertBefore) {
        messageList.insertBefore(existingElement, insertBefore);
      }
      insertBefore = existingElement;
    } else {
      // CREATE new element(s)
      const newElements = createBubblesForEvent(area, /** @type {Message} */ (item), i);
      for (const el of newElements) {
        messageList.insertBefore(el, insertBefore);
        insertBefore = el;
      }
    }
  }
}

/**
 * Create message element(s) for a single message.
 * @param {any} area - ConversationArea instance (provides _messageThread for context items)
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement[]} Created elements (zero or more).
 */
function createBubblesForEvent(area, message, itemIndex) {
  // Durable provider continuation state is conversation history, not a
  // user-facing message or a standing context item.
  if (isProviderStateMessage(message)) return [];

  /** @type {HTMLElement[]} */
  const elements = [];

  if (isGroupEntry(message)) {
    const live = area?._snapshotLiveStatus?.() || null;
    elements.push(createToolGroupTile(/** @type {any} */ (message), itemIndex, live));
  } else if (isUserMessage(message)) {
    const el = createUserBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isAssistantMessage(message) || isThinkingMessage(message)) {
    const el = createAssistantBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isToolActionMessage(message)) {
    const el = createToolActionElement(message, itemIndex);
    if (el) elements.push(el);
  } else if (isErrorMessage(message)) {
    const el = createErrorBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isNoticeMessage(message)) {
    const el = createNoticeBubble(message, itemIndex);
    if (el) elements.push(el);
  } else if (isThreadMessage(message)) {
    const live = area?._snapshotLiveStatus?.() || null;
    const el = createThreadBubble(message, itemIndex, live);
    if (el) elements.push(el);
  } else {
    const el = createContextItemBubble(area, message, itemIndex);
    if (el) elements.push(el);
  }

  return elements;
}

/**
 * Create a message element with common attributes.
 * CRITICAL: ensures message-id is ALWAYS set (required for ID-based diffing).
 * @param {string} tagName
 * @param {object} options
 * @param {string|undefined} options.itemId
 * @param {number} [options.itemIndex]
 * @param {Record<string, string>} [options.attributes]
 * @returns {HTMLElement} Created element.
 */
function createMessageElement(tagName, options) {
  const { itemId, itemIndex, attributes = {} } = options;

  const element = document.createElement(tagName);
  element.classList.add('conversation-item');
  element.setAttribute('message-id', itemId || '');

  if (itemIndex !== undefined && itemIndex >= 0) {
    element.setAttribute('item-index', itemIndex.toString());
  }

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }

  return element;
}

/**
 * Create a user message element, or null for a message that paints nothing.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null.
 */
function createUserBubble(message, itemIndex) {
  const msg = /** @type {import('../../sdk/lib/message.js').UserMessage} */ (message);
  // A Continue's marker is a run record, not a message: it holds the outcome of
  // the run that click started (worker/sessions.go continuationMarker) and says
  // nothing. Painting it would put an empty bubble where a Continue has always
  // left the transcript alone. Mirrored by rendersNothing in utils/item-grouping.js.
  if (msg.get('continuation')) return null;
  /** @type {Record<string, string>} */
  const attributes = { content: msg.get('content') || '' };
  const attachments = normalizeAttachments(msg.get('attachments'));
  if (attachments.length > 0) {
    attributes.attachments = JSON.stringify(attachments);
  }
  return createMessageElement('user-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes
  });
}

/**
 * Create an assistant or thinking message bubble.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createAssistantBubble(message, itemIndex) {
  let textContent = '';

  if (isAssistantMessage(message)) {
    textContent = message.get('content') || '';
  } else if (isThinkingMessage(message)) {
    textContent = message.get('content') || '';
  }

  // Strip ephemeral <plan> tags before checking — plan content is displayed
  // via the next-steps indicator, not as an assistant message
  const visibleContent = textContent.replace(/<plan>[\s\S]*?<\/plan>/g, '').replace(/<plan[\s\S]*$/, '').trim();

  // Only create element if there's actual non-whitespace content
  if (!visibleContent) {
    return null;
  }

  const msg = /** @type {any} */ (message);
  const tagName = isThinkingMessage(message) ? 'thinking-message' : 'assistant-message';

  return createMessageElement(tagName, {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes: { content: textContent }
  });
}

/**
 * Create tool-action element (self-rendering component).
 * The tool-action-message component handles all states internally.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createToolActionElement(message, itemIndex) {
  if (message.get('type') !== 'tool-action') {
    return null;
  }

  const msg = /** @type {import('../../sdk/lib/message.js').ToolActionMessage} */ (message);

  // Context item results are rendered by context item messages, not here
  const result = msg.get('result');
  if ((result?.get ? result.get('resultType') : result?.resultType) === 'context') {
    return null;
  }

  const el = document.createElement('tool-action-message');
  el.classList.add('conversation-item');
  el.setAttribute('message-id', msg.get('itemId') || '');
  if (itemIndex !== undefined && itemIndex >= 0) {
    el.setAttribute('item-index', itemIndex.toString());
  }
  return el;
}

/**
 * Create an error message element.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement} Created element.
 */
function createErrorBubble(message, itemIndex) {
  return createMessageElement('error-message', {
    itemId: message.get('itemId'),
    itemIndex,
    attributes: { content: message.get('summary') || message.get('message') || message.get('content') || 'An error occurred' }
  });
}

/**
 * Create a notice message element — a durable record of something that happened
 * to a turn, standing where it happened. Only the title crosses into the row;
 * the detail is the properties panel's, which reads it from the item itself.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement} Created element.
 */
function createNoticeBubble(message, itemIndex) {
  return createMessageElement('notice-message', {
    itemId: message.get('itemId'),
    itemIndex,
    attributes: { 'notice-title': message.get('summary') || '' }
  });
}

/**
 * Create a context item message element with enhanced preview.
 * Renders for all context items to provide inline visibility.
 * @param {any} area - ConversationArea instance (for _messageThread lookup)
 * @param {Message} message
 * @param {number} [itemIndex]
 * @returns {HTMLElement|null} Created element, or null if the item has no visible body.
 */
function createContextItemBubble(area, message, itemIndex) {
  const msg = /** @type {import('../../sdk/lib/message.js').ContextItemMessage} */ (message);

  // Only render items with a registered context item plugin
  const contextItem = msg.get('itemId') ? area._messageThread?.getContextItem(msg.get('itemId')) : null;
  if (!contextItem) return null;
  // Items may opt out of a standing transcript card while still contributing
  // to LLM context and persisting their data (e.g. the todo list, whose live
  // state shows on each tool-action row and will move to the pinboard).
  if (!contextItem.isVisible()) return null;
  const itemType = contextItem.type;
  const badge = contextItem?.getBadgeOptions() ?? /** @type {{color: string, icon?: string}} */ ({ color: 'slate' });
  const colorPreset = badge.color;
  const icon = badge.icon;

  /** @type {Record<string, string>} */
  const attrs = {
    'item-type': itemType,
    'color-preset': colorPreset,
  };

  if (icon) attrs['icon'] = icon;
  if (msg.get('itemId')) attrs['item-id'] = msg.get('itemId');
  if (msg.get('error')) attrs['error'] = msg.get('error');

  return createMessageElement('context-item-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes: attrs
  });
}

/**
 * Create the collapsed tile for a folded run of tool rows. The tile stands in
 * for items that are still in the document untouched; selecting it opens them
 * in the next column.
 * @param {import('../utils/item-grouping.js').ItemGroup} group - The group entry.
 * @param {number} [itemIndex]
 * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Conversation's live LLM status snapshot.
 * @returns {HTMLElement} Created element.
 */
function createToolGroupTile(group, itemIndex, live) {
  const el = createMessageElement('tool-group-message', {
    itemId: group.get('itemId'),
    itemIndex,
    attributes: { 'child-count': String(group.members.length) }
  });
  /** @type {any} */ (el).updateFromItem?.(group, live);
  return el;
}

/**
 * Create a thread message element.
 * @param {Message} message
 * @param {number} [itemIndex]
 * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} [live] - Conversation's live LLM status snapshot.
 * @returns {HTMLElement} Created element.
 */
function createThreadBubble(message, itemIndex, live) {
  const msg = /** @type {import('../../sdk/lib/message.js').ThreadMessage} */ (message);

  // Count child items in the thread's nested Y.Array
  const itemsArray = msg.get('items');
  const childCount = itemsArray ? itemsArray.length : 0;

  /** @type {Record<string, string>} */
  const attributes = {
    goal: itemGoal(msg),
    'child-count': childCount.toString()
  };

  const el = createMessageElement('thread-message', {
    itemId: msg.get('itemId'),
    itemIndex,
    attributes
  });
  if (el) {
    /** @type {any} */ (el).updateFromItem?.(msg, live);
  }
  return el;
}
