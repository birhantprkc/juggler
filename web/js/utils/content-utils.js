//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Content utilities for processing LLM response content
 * @module content-utils
 */

/**
 * @typedef {import('../services/websocket.js').ContentBlock} ContentBlock
 */

/**
 * Strip <think>...</think> tags from content.
 * Handles matched pairs and unmatched </think> with garbage before (from streaming interrupts).
 * @param {string} content - Raw content
 * @returns {string} Content with thinking tags removed
 */
export function stripThinkingTags(content) {
  if (!content) return content;

  let cleanContent = content;
  let prevContent;
  do {
    prevContent = cleanContent;

    // Remove matched <think>...</think> pairs
    cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>/g, '');

    // Check for unmatched </think> (no <think> before it)
    const firstThinkClose = cleanContent.indexOf('</think>');
    if (firstThinkClose !== -1) {
      const beforeClose = cleanContent.substring(0, firstThinkClose);
      if (beforeClose.indexOf('<think>') === -1) {
        // Unmatched </think> - strip everything before and including it
        cleanContent = cleanContent.substring(firstThinkClose + '</think>'.length);
      }
    }
  } while (cleanContent !== prevContent);

  return cleanContent;
}

/**
 * Strip LLM control tags from content for display.
 * Removes <tool>, <action>, <drop>, <context-item>, and <think> tags.
 * @param {string} content - Raw LLM content
 * @returns {string} Cleaned content
 */
export function stripLLMTags(content) {
  if (!content) return content;
  let clean = stripThinkingTags(content);
  // Remove matched tag pairs: <tag ...>...</tag> (greedy attribute match, lazy content match)
  for (const tag of ['tool', 'action', 'drop', 'context-item']) {
    clean = clean.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
  }
  return clean.trim();
}

