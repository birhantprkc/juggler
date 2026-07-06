//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Compaction utilities shared by the /compact plugin and the auto-compact
 * observer.
 */

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * Default summarization prompt used by the compact commands.
 * @param {number} [_messageCount] - Number of messages being summarized (unused)
 * @returns {string} Summarization prompt text
 */
export function defaultSummarizationPrompt(_messageCount) {
  return `You are creating a handoff summary of the conversation so far. Another instance of yourself will use ONLY this summary (plus the most recent messages) to continue the work seamlessly, so completeness matters more than brevity — never drop information you cannot reconstruct later.

First, in <analysis> tags, walk the conversation chronologically: note each user request, each significant action you took, every error hit and how it was resolved, and what is in flight right now. This is your scratchpad.

Then write the summary with these sections:

1. Intent & explicit requests — the user's goals and EVERY explicit instruction or constraint, quoted or closely paraphrased. Do not summarize these away.
2. Files modified — each path, what changed, and why. Include key signatures, identifiers, and snippets verbatim where they matter.
3. Key technical decisions — what was decided and the reasoning, so the choice isn't relitigated.
4. Errors & fixes — problems encountered and their resolutions, so they aren't repeated.
5. Current state — what is done, what is in progress right now.
6. Next step — the immediate next action, which must follow directly from the most recent work above. If continuing an interrupted task, quote the relevant request verbatim. Do not introduce new direction the user didn't ask for.
7. Open issues — anything unresolved or uncertain.

Be precise and technical within each section; compress prose, never facts. Then call return_result, passing the summary (sections 1–7, not the <analysis>) in its "result" argument.`;
}

/**
 * Wrap a message that carries image attachments so any summariser reading its
 * `content` sees a short textual stand-in per attachment ("[image: <name>]")
 * instead of trying to re-embed the image bytes. The wrapper is read-only and
 * delegates everything to the underlying item — it NEVER mutates the doc; the
 * stand-in exists only in the value returned to summarisation callers. Messages
 * without attachments are returned unchanged (identity preserved).
 * @param {Message} item - Message (Y.Map-like, with a `get` accessor)
 * @returns {Message} The original item, or a read-only stand-in wrapper
 */
function withAttachmentStandin(item) {
  const att = item?.get?.('attachments');
  if (!Array.isArray(att) || att.length === 0) return item;
  const standin = att
    .map(a => `\n[image: ${(a && (a.filename || a.id)) || 'image'}]`)
    .join('');
  return /** @type {Message} */ (new Proxy(item, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (/** @type {string} */ key) => {
          const v = target.get(key);
          if (key === 'content') return (typeof v === 'string' ? v : '') + standin;
          return v;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    }
  }));
}

/**
 * Get content messages from a message thread (filtering UI-only types).
 *
 * User messages that carry image attachments are returned as read-only
 * stand-in wrappers whose `content` appends "[image: <filename>]" per
 * attachment — so a summarisation turn built from these messages describes the
 * image by name rather than re-embedding its bytes. The wrapper does not mutate
 * the doc.
 * @param {import('../model/message-thread.js').MessageThread} messageThread - Message thread
 * @returns {Message[]} Content messages
 */
export function getContentMessages(messageThread) {
  if (!messageThread) return [];
  return messageThread.getMessages()
    .filter(m =>
      ['user', 'assistant', 'tool-action', 'thread'].includes(m.get('type'))
    )
    .map(withAttachmentStandin);
}

/** Track pending compactions to prevent duplicates */
const pendingCompactions = new Set();

/**
 * Check if a compaction is already in progress
 * @param {string} conversationId - Conversation ID
 * @returns {boolean} True if compaction in progress
 */
export function isCompactionPending(conversationId) {
  return pendingCompactions.has(conversationId);
}

/**
 * Mark compaction as started
 * @param {string} conversationId - Conversation ID
 */
export function startCompaction(conversationId) {
  pendingCompactions.add(conversationId);
}

/**
 * Mark compaction as finished
 * @param {string} conversationId - Conversation ID
 */
export function endCompaction(conversationId) {
  pendingCompactions.delete(conversationId);
}

