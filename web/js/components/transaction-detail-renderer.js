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
 *
 * Two things shape the layout. The output is the answer, so it comes first;
 * the input is reference material you consult, so it comes second and arrives
 * as a list of rows — one per message, each carrying its estimated share of
 * the context — rather than one unreadable dump. A row builds its body the
 * first time it is opened, so a hundred-message history costs nothing to show.
 */

import { formatNumber, formatTokens } from '../utils/format.js';
import { escapeJsonContent } from '../../sdk/lib/html.js';
import { createCopyButton } from '../utils/properties-panel-helpers.js';
import { estimateValueTokens, LONG_TEXT_CHARS } from '../utils/token-estimate.js';

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
 * @property {number} [inputTokens] - Provider-reported input tokens, or a fallback estimate when inputTokensApproximate is true.
 * @property {boolean} [inputTokensApproximate] - Whether inputTokens is a local fallback estimate.
 * @property {number} [outputTokens] - Output token count reported by the provider.
 * @property {number} [cachedTokens] - Input tokens served from prompt cache.
 * @property {number} [cacheWriteTokens] - Input tokens written to the prompt cache this turn.
 * @property {string} [stopReason] - Provider stop reason ('end_turn', 'tool_use', 'error', etc.).
 * @property {{provider?: string, model?: string}} [modelConfig] - Provider/model that handled this round-trip.
 * @property {TransactionBlobInput} [input] - Input context sent to the LLM.
 * @property {{blocks?: TransactionBlobOutputBlock[], error?: string}} [output] - Response blocks returned by the LLM, plus an error string if the round-trip failed.
 */

/** Longest row label shown before the browser's own ellipsis takes over. */
const LABEL_CHARS = 200;

/**
 * Render the full transaction detail into `parent` (cleared first).
 * @param {HTMLElement} parent - Container to render into.
 * @param {TransactionBlob|null} blob - Parsed blob, or null if not found.
 * @param {string} [emptyMessage] - What to say instead when there is no blob.
 *   The default covers a blob that should exist and doesn't; callers that know
 *   the item never had a round-trip say so instead.
 */
export function renderTransactionDetail(parent, blob, emptyMessage = 'No transaction data.') {
  parent.innerHTML = '';
  if (!blob) {
    const empty = document.createElement('div');
    empty.className = 'properties-panel-text';
    empty.textContent = emptyMessage;
    parent.appendChild(empty);
    return;
  }

  parent.appendChild(_buildMetadataBar(blob));

  const sections = document.createElement('properties-panel-tx-sections');
  sections.appendChild(_buildOutputSection(blob));
  sections.appendChild(_buildInputSection(blob));
  parent.appendChild(sections);
}

// ============================================================================
// Section builders
// ============================================================================

/**
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Metadata bar element with tokens/cache/duration/stop/time/model.
 */
function _buildMetadataBar(blob) {
  const bar = document.createElement('properties-panel-tx-metadata');
  const add = (/** @type {string} */ text) => {
    const span = document.createElement('span');
    span.className = 'meta-item';
    span.textContent = text;
    bar.appendChild(span);
  };
  if (blob.inputTokens || blob.outputTokens) {
    add(`Tokens: ${blob.inputTokensApproximate ? '~' : ''}${formatNumber(blob.inputTokens ?? 0)} in \u2192 ${formatNumber(blob.outputTokens ?? 0)} out`);
  }
  if (blob.cachedTokens !== undefined || blob.cacheWriteTokens !== undefined) {
    // A key that is present but 0 is a provider-reported zero; format it as a
    // real number. Only a fully absent pair means the provider reported no
    // cache usage at all.
    const read = blob.cachedTokens !== undefined ? formatNumber(blob.cachedTokens) : '?';
    const write = blob.cacheWriteTokens !== undefined ? formatNumber(blob.cacheWriteTokens) : '?';
    add(`Cache: ${read} read / ${write} written`);
  } else if (blob.inputTokens) {
    add('Cache: not reported');
  }
  if (blob.duration) {
    add(`Duration: ${(blob.duration / 1000).toFixed(2)}s`);
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
 * LLM Output: the response blocks, each rendered as what it is — text and
 * thinking as text, a tool call as its name and arguments — rather than as one
 * JSON dump with every newline escaped. Copying still yields the whole blob.
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Output section element.
 */
function _buildOutputSection(blob) {
  const output = blob.output;
  const blocks = output?.blocks || [];
  const error = output?.error;

  const reconstructed = {
    blocks,
    stopReason: blob.stopReason,
    inputTokens: blob.inputTokens,
    outputTokens: blob.outputTokens,
    // Absent means the provider reported no cache usage (unknown, not 0);
    // JSON.stringify drops the undefined key so the copy stays honest.
    cachedTokens: blob.cachedTokens
  };

  const section = _section('LLM Output', {
    summary: blob.outputTokens ? `${blob.outputTokens.toLocaleString()} tokens` : '',
    copyText: JSON.stringify(reconstructed, null, 2),
    copyLabel: 'Copy the output as JSON'
  });

  if (error) {
    const errEl = document.createElement('pre');
    errEl.className = 'properties-panel-result error';
    errEl.textContent = error;
    section.appendChild(errEl);
  }

  if (blocks.length) {
    for (const block of blocks) section.appendChild(_buildOutputBlock(block));
  } else if (!error) {
    const msg = blob.stopReason === 'cancelled' ? 'Cancelled before any output.' : 'The model returned nothing.';
    section.appendChild(_textBlock(msg));
  }

  return section;
}

/**
 * @param {TransactionBlobOutputBlock} block - One response block.
 * @returns {HTMLElement} Rendered block, labelled with its kind.
 */
function _buildOutputBlock(block) {
  const el = document.createElement('div');
  el.className = 'tx-out-block';

  const kind = document.createElement('div');
  kind.className = 'tx-out-kind';
  kind.textContent = block.type === 'tool_use' && block.toolName
    ? `tool_use · ${block.toolName}`
    : (block.type || 'block');
  el.appendChild(kind);

  if (block.type === 'text' || block.type === 'thinking') {
    el.appendChild(_textBlock(block.content ?? block.thinking ?? ''));
    return el;
  }

  const { type: _t, ...rest } = block;
  _appendValue(el, rest, 0);
  return el;
}

/**
 * LLM Input as a list of rows — the system prompt, the tool definitions, then
 * one row per message — each carrying its estimated share of the context, so
 * "what is in here and what is eating it" is answerable at a glance. The final
 * message opens by default: it is the one this round-trip was actually
 * responding to.
 * @param {TransactionBlob} blob
 * @returns {HTMLElement} Input section element.
 */
function _buildInputSection(blob) {
  const input = blob.input;
  const messages = input?.messages || [];
  const tools = input?.tools || [];
  const systemPrompt = input?.systemPrompt || '';

  const fullJson = JSON.stringify({
    systemPrompt: input?.systemPrompt ?? null,
    messages,
    tools
  }, null, 2);

  const section = _section('LLM Input', {
    summary: _inputSummary(blob, { systemPrompt, messages, tools }),
    copyText: fullJson,
    copyLabel: 'Copy the whole input as JSON'
  });

  if (!input || (!systemPrompt && !messages.length && !tools.length)) {
    section.appendChild(_textBlock('No input recorded.'));
    return section;
  }

  const rows = document.createElement('div');
  rows.className = 'tx-rows';

  if (systemPrompt) {
    rows.appendChild(_row('system prompt', _firstLine(systemPrompt), systemPrompt));
  }
  if (tools.length) {
    rows.appendChild(_row('tools', `${tools.length} available`, tools));
  }

  const displayMessages = _transformMessagesForDisplay(messages);
  displayMessages.forEach((msg, i) => {
    const kind = typeof msg.type === 'string' && msg.type ? msg.type : 'message';
    rows.appendChild(_row(kind, _messageLabel(msg), msg, { open: i === displayMessages.length - 1 }));
  });

  section.appendChild(rows);
  return section;
}

/**
 * The input's own size line: what we estimate, checked against what the
 * provider reported. Seeing both is what tells the user how far to trust the
 * per-row estimates below.
 * @param {TransactionBlob} blob
 * @param {{systemPrompt: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>}} parts
 * @returns {string} Summary line for the section header.
 */
function _inputSummary(blob, parts) {
  const estimated = estimateValueTokens(parts.systemPrompt)
    + estimateValueTokens(parts.messages)
    + estimateValueTokens(parts.tools);
  const bits = [`~${formatTokens(estimated)} estimated`];
  if (blob.inputTokens && !blob.inputTokensApproximate) {
    bits.push(`${blob.inputTokens.toLocaleString()} reported`);
  }
  return bits.join(' · ');
}

// ============================================================================
// Rows
// ============================================================================

/**
 * One collapsible row: kind, a one-line label, and the entry's estimated token
 * cost. The body is built on first open — a long history stays cheap until the
 * user actually asks for a message.
 * @param {string} kind - Row kind shown in the leading lozenge (e.g. 'tool-use').
 * @param {string} label - One-line preview, ellipsised by CSS when it overflows.
 * @param {unknown} value - The entry itself; rendered as the body, measured for the size.
 * @param {{open?: boolean}} [options] - `open` renders the row expanded.
 * @returns {HTMLElement} The row element.
 */
function _row(kind, label, value, { open = false } = {}) {
  const row = document.createElement('details');
  row.className = 'tx-row';

  const summary = document.createElement('summary');
  summary.className = 'tx-row-summary';

  const kindEl = document.createElement('span');
  kindEl.className = 'tx-row-kind';
  kindEl.textContent = kind;
  summary.appendChild(kindEl);

  const labelEl = document.createElement('span');
  labelEl.className = 'tx-row-label';
  labelEl.textContent = label;
  labelEl.title = label;
  summary.appendChild(labelEl);

  const sizeEl = document.createElement('span');
  sizeEl.className = 'tx-row-size';
  sizeEl.textContent = `~${formatTokens(estimateValueTokens(value))}`;
  sizeEl.title = 'Estimated tokens (~4 characters per token)';
  summary.appendChild(sizeEl);

  summary.appendChild(createCopyButton(
    () => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
    'properties-panel-header-icon-btn tx-row-copy',
    'Copy this entry'
  ));

  row.appendChild(summary);

  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    row.appendChild(_buildEntryBody(value));
  };
  row.addEventListener('toggle', () => {
    if (row.open) build();
  });
  if (open) {
    row.open = true;
    build();
  }

  return row;
}

/**
 * A one-line preview of a message for its row label: the tool name (plus its
 * most identifying argument) for a tool call, otherwise the first line of the
 * content.
 * @param {Record<string, any>} msg - Message entry.
 * @returns {string} Label text.
 */
function _messageLabel(msg) {
  if (msg.type === 'tool-use') {
    const name = typeof msg.toolName === 'string' ? msg.toolName : '';
    const arg = _firstStringValue(msg.toolInput);
    return arg ? `${name} · ${arg}` : name;
  }
  if (typeof msg.content === 'string') return _firstLine(msg.content);
  return _firstLine(_firstStringValue(msg));
}

/**
 * @param {unknown} value - Object to scan.
 * @returns {string} The first string value on the object, or ''.
 */
function _firstStringValue(value) {
  if (!value || typeof value !== 'object') return '';
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * @param {string} text - Source text.
 * @returns {string} The first non-empty line, capped for the label slot.
 */
function _firstLine(text) {
  if (!text) return '';
  const line = String(text).split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, LABEL_CHARS);
}

// ============================================================================
// Value rendering
// ============================================================================

/**
 * @param {unknown} value - The entry to render.
 * @returns {HTMLElement} The row body element.
 */
function _buildEntryBody(value) {
  const body = document.createElement('div');
  body.className = 'tx-row-body';
  _appendValue(body, value, 0);
  return body;
}

/**
 * Render a value so that prose reads as prose: any long or multi-line string
 * becomes its own text block under its key, and the remaining short fields
 * stay together as compact JSON. Without this every newline in a system prompt
 * or a file body renders as a literal `\n` on one enormous line.
 * @param {HTMLElement} parent - Element to append into.
 * @param {unknown} value - Value to render.
 * @param {number} depth - Current nesting depth (bounded, so a pathological blob can't recurse forever).
 */
function _appendValue(parent, value, depth) {
  if (typeof value === 'string') {
    parent.appendChild(_textBlock(value));
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 3) {
    parent.appendChild(_jsonBlock(value));
    return;
  }

  /** @type {Record<string, unknown>} */
  const compact = {};
  /** @type {Array<[string, unknown]>} */
  const expanded = [];
  for (const [key, v] of Object.entries(value)) {
    if (_isLongText(v) || _holdsLongText(v)) expanded.push([key, v]);
    else compact[key] = v;
  }

  if (Object.keys(compact).length > 0) parent.appendChild(_jsonBlock(compact));

  for (const [key, v] of expanded) {
    const field = document.createElement('div');
    field.className = 'tx-field';
    const keyEl = document.createElement('div');
    keyEl.className = 'tx-field-key';
    keyEl.textContent = key;
    field.appendChild(keyEl);
    _appendValue(field, v, depth + 1);
    parent.appendChild(field);
  }
}

/**
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for a string worth its own text block.
 */
function _isLongText(value) {
  return typeof value === 'string' && (value.includes('\n') || value.length > LONG_TEXT_CHARS);
}

/**
 * @param {unknown} value - Candidate object.
 * @returns {boolean} True when an object holds a long string one level down.
 */
function _holdsLongText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(_isLongText);
}

// ============================================================================
// Tiny DOM helpers
// ============================================================================

/**
 * @param {string} title - Section title.
 * @param {{summary?: string, copyText?: string, copyLabel?: string}} [options] - Right-hand size line and copy-all button.
 * @returns {HTMLElement} Subsection wrapper with a header row.
 */
function _section(title, { summary = '', copyText = '', copyLabel = 'Copy to clipboard' } = {}) {
  const el = document.createElement('properties-panel-subsection');

  const head = document.createElement('div');
  head.className = 'tx-section-head';

  const h = document.createElement('h4');
  h.className = 'properties-panel-subtitle';
  h.textContent = title;
  head.appendChild(h);

  if (summary) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'tx-section-summary';
    summaryEl.textContent = summary;
    head.appendChild(summaryEl);
  }
  if (copyText) {
    head.appendChild(createCopyButton(copyText, 'properties-panel-header-icon-btn', copyLabel));
  }

  el.appendChild(head);
  return el;
}

/**
 * @param {string} text - Text to show.
 * @returns {HTMLElement} Plain text block styled like other panel text.
 */
function _textBlock(text) {
  const el = document.createElement('pre');
  el.className = 'properties-panel-text tx-text';
  el.textContent = text;
  return el;
}

/**
 * @param {unknown} value - Value to render as syntax-highlighted JSON.
 * @returns {HTMLElement} The rendered block.
 */
function _jsonBlock(value) {
  const pre = document.createElement('pre');
  pre.className = 'properties-panel-json-display';
  pre.innerHTML = _formatJson(value);
  return pre;
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
