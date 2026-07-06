//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Render the input/output detail view for one LLM round-trip.
 *
 * The blob is loaded lazily from the per-conversation transaction store
 * (`.juggler/{convID}.txns/{txnID}.json`) when the user opens the View
 * Transaction panel. Shape mirrors what the worker writes in
 * `cmd/juggler/worker/strategy.go:saveTransactionBlob`.
 */

import { formatNumber } from '../utils/format.js';
import { escapeJsonContent } from '../../sdk/lib/html.js';
import { createCopyButton } from '../utils/properties-panel-helpers.js';

/**
 * @typedef {object} TransactionBlobInput
 * @property {string|null} [systemPrompt] - System prompt sent to the LLM.
 * @property {Array<Record<string, unknown>>} [messages] - Provider-format message history.
 * @property {Array<Record<string, unknown>>} [tools] - Tool definitions advertised to the LLM.
 */

/**
 * @typedef {object} TransactionBlobOutputBlock
 * @property {string} type - 'text' | 'thinking' | 'tool_use'
 * @property {string} [content] - Text content when type='text'.
 * @property {string} [thinking] - Thinking content.
 * @property {string} [toolUseId] - Tool-use id when type='tool_use'.
 * @property {string} [toolName] - Tool name when type='tool_use'.
 * @property {Record<string, unknown>} [toolInput] - Tool input args when type='tool_use'.
 */

/**
 * @typedef {object} TransactionBlob
 * @property {string} id - Transaction id (matches the file stem on disk).
 * @property {string} [timestamp] - ISO8601 round-trip start time.
 * @property {number} [duration] - Round-trip duration in milliseconds.
 * @property {number} [inputTokens] - Input token count reported by the provider.
 * @property {number} [outputTokens] - Output token count reported by the provider.
 * @property {number} [cachedTokens] - Input tokens served from prompt cache.
 * @property {number} [cacheWriteTokens] - Input tokens written to the prompt cache this turn.
 * @property {string} [stopReason] - Provider stop reason ('end_turn', 'tool_use', 'error', etc.).
 * @property {{provider?: string, model?: string}} [modelConfig] - Provider/model that handled this round-trip.
 * @property {TransactionBlobInput} [input] - Input context sent to the LLM.
 * @property {{blocks?: TransactionBlobOutputBlock[], error?: string}} [output] - Response blocks returned by the LLM, plus an error string if the round-trip failed.
 */

/**
 * Render the full transaction detail into `parent` (cleared first).
 * @param {HTMLElement} parent - Container to render into.
 * @param {TransactionBlob|null} blob - Parsed blob, or null if not found.
 */
export function renderTransactionDetail(parent, blob) {
  parent.innerHTML = '';
  if (!blob) {
    const empty = document.createElement('div');
    empty.className = 'properties-panel-text';
    empty.textContent = 'No transaction data available.';
    parent.appendChild(empty);
    return;
  }

  parent.appendChild(_buildMetadataBar(blob));

  const sections = document.createElement('properties-panel-tx-sections');
  sections.appendChild(_buildFullInputSection(blob));
  const lastMsg = _buildLastMessageSection(blob);
  if (lastMsg) sections.appendChild(lastMsg);
  sections.appendChild(_buildOutputSection(blob));
  parent.appendChild(sections);
}

// ============================================================================
// Section builders
// ============================================================================

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Metadata bar element with duration/tokens/stop/time/model.
 */
function _buildMetadataBar(blob) {
  const bar = document.createElement('properties-panel-tx-metadata');
  const add = (/** @type {string} */ text) => {
    const span = document.createElement('span');
    span.className = 'meta-item';
    span.textContent = text;
    bar.appendChild(span);
  };
  if (blob.duration) {
    add(`Duration: ${(blob.duration / 1000).toFixed(2)}s`);
  }
  if (blob.inputTokens || blob.outputTokens) {
    add(`Tokens: ${formatNumber(blob.inputTokens ?? 0)} in \u2192 ${formatNumber(blob.outputTokens ?? 0)} out`);
  }
  if (blob.cachedTokens || blob.cacheWriteTokens) {
    const read = blob.cachedTokens ?? 0;
    const write = blob.cacheWriteTokens ?? 0;
    add(`Cache: ${formatNumber(read)} read / ${formatNumber(write)} written`);
  }
  if (blob.stopReason) {
    add(`Stop: ${blob.stopReason}`);
  }
  if (blob.timestamp) {
    add(`Time: ${new Date(blob.timestamp).toLocaleTimeString()}`);
  }
  if (blob.modelConfig?.model) {
    add(`Model: ${blob.modelConfig.model}`);
  }
  return bar;
}

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} LLM Input section: system prompt, messages, tools.
 */
function _buildFullInputSection(blob) {
  const section = _section('LLM Input');
  const input = blob.input;
  if (!input || (!input.systemPrompt && !input.messages?.length && !input.tools?.length)) {
    section.appendChild(_textBlock('No input recorded.'));
    return section;
  }

  const transformedMessages = _transformMessagesForDisplay(input.messages || []);
  const display = {
    systemPrompt: input.systemPrompt ?? null,
    messages: transformedMessages,
    toolsAvailable: input.tools ? input.tools.length : 0
  };

  const fullJson = JSON.stringify({
    systemPrompt: input.systemPrompt ?? null,
    messages: input.messages || [],
    tools: input.tools || []
  }, null, 2);

  section.appendChild(_copyableJson(display, fullJson));
  return section;
}

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement|null} Last-message section showing just the final entry in input.messages, or null if there are none.
 */
function _buildLastMessageSection(blob) {
  const messages = blob.input?.messages;
  if (!messages?.length) return null;

  const lastMessage = messages[messages.length - 1];
  const section = _section('Last Message');
  const copyText = JSON.stringify(lastMessage, null, 2);
  section.appendChild(_copyableJson(lastMessage, copyText));
  return section;
}

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} LLM Output section: response blocks + token totals (or an error notice when the round-trip failed).
 */
function _buildOutputSection(blob) {
  const section = _section('LLM Output');
  const output = blob.output;
  const blocks = output?.blocks || [];
  const error = output?.error;

  if (error) {
    const errEl = document.createElement('pre');
    errEl.className = 'properties-panel-result error';
    errEl.textContent = error;
    section.appendChild(errEl);
  }

  if (blocks.length) {
    const reconstructed = {
      blocks,
      stopReason: blob.stopReason,
      inputTokens: blob.inputTokens,
      outputTokens: blob.outputTokens,
      cachedTokens: blob.cachedTokens || 0
    };
    section.appendChild(_copyableJson(reconstructed, JSON.stringify(reconstructed, null, 2)));
  } else if (!error) {
    const msg = blob.stopReason === 'cancelled' ? 'Cancelled before any output.' : 'No response data available.';
    section.appendChild(_textBlock(msg));
  }

  return section;
}

// ============================================================================
// Tiny DOM helpers
// ============================================================================

/**
 * @param {string} title
 * @returns {HTMLElement} Subsection wrapper with an h4 subtitle.
 */
function _section(title) {
  const el = document.createElement('properties-panel-subsection');
  const h = document.createElement('h4');
  h.className = 'properties-panel-subtitle';
  h.textContent = title;
  el.appendChild(h);
  return el;
}

/**
 * @param {string} text
 * @returns {HTMLElement} Plain text block styled like other panel text.
 */
function _textBlock(text) {
  const el = document.createElement('div');
  el.className = 'properties-panel-text';
  el.textContent = text;
  return el;
}

/**
 * Render `display` as syntax-highlighted JSON, copying `copyText` on click.
 * @param {unknown} display
 * @param {string} copyText
 * @returns {HTMLElement} Wrapper containing the rendered JSON and a copy button.
 */
function _copyableJson(display, copyText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'properties-panel-copyable';

  const copyHeader = document.createElement('div');
  copyHeader.className = 'properties-panel-copy-header';
  copyHeader.appendChild(createCopyButton(copyText));
  wrapper.appendChild(copyHeader);

  const pre = document.createElement('pre');
  pre.className = 'properties-panel-json-display';
  pre.innerHTML = _formatJson(display);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Reorder messages so that tool-result entries are nested under their
 * matching tool-use.
 * @param {Array<Record<string, unknown>>} messages
 * @returns {Array<Record<string, unknown>>} Messages with tool-results folded into their tool-use entry.
 */
function _transformMessagesForDisplay(messages) {
  /** @type {Map<string, Record<string, unknown>>} */
  const resultsByToolUseId = new Map();
  for (const msg of messages) {
    if (msg.type === 'tool-result' && typeof msg.toolUseId === 'string') {
      const { type: _t, toolUseId: _id, ...rest } = msg;
      resultsByToolUseId.set(msg.toolUseId, rest);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const msg of messages) {
    if (msg.type === 'tool-result') continue;
    const { type, ...rest } = msg;
    /** @type {Record<string, unknown>} */
    const reordered = { type, ...rest };
    if (type === 'tool-use' && typeof msg.toolUseId === 'string') {
      const result = resultsByToolUseId.get(msg.toolUseId);
      if (result) reordered.result = result;
    }
    out.push(reordered);
  }
  return out;
}

/**
 * Render an arbitrary value as syntax-highlighted JSON HTML.
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {string} HTML markup for the JSON-rendered value.
 */
function _formatJson(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const padNext = '  '.repeat(indent + 1);

  if (value === null) return '<span class="json-null">null</span>';
  if (value === undefined) return '<span class="json-undefined">undefined</span>';

  const t = typeof value;
  if (t === 'boolean') return `<span class="json-boolean">${String(value)}</span>`;
  if (t === 'number') return `<span class="json-number">${String(value)}</span>`;
  if (t === 'string') return `<span class="json-string">"${escapeJsonContent(/** @type {string} */ (value))}"</span>`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="json-bracket">[]</span>';
    let out = '<span class="json-bracket">[</span>\n';
    value.forEach((entry, i) => {
      out += padNext + _formatJson(entry, indent + 1);
      if (i < value.length - 1) out += '<span class="json-comma">,</span>';
      out += '\n';
    });
    out += pad + '<span class="json-bracket">]</span>';
    return out;
  }

  if (t === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj);
    if (keys.length === 0) return '<span class="json-bracket">{}</span>';
    let out = '<span class="json-bracket">{</span>\n';
    keys.forEach((key, i) => {
      out += padNext + `<span class="json-key">"${escapeJsonContent(key)}"</span>: ` + _formatJson(obj[key], indent + 1);
      if (i < keys.length - 1) out += '<span class="json-comma">,</span>';
      out += '\n';
    });
    out += pad + '<span class="json-bracket">}</span>';
    return out;
  }

  return String(value);
}
