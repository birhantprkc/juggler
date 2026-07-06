//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Syntax highlighting helpers — the single highlighting engine for item UIs.
 *
 * Every place that turns code + a language into coloured DOM funnels through
 * `highlightCode` here: tile summaries (`createHighlightedCode`), properties-
 * panel subsections (`createCopyableText({ language })`), the shared file-code
 * renderer (`createCodeBlock`), and the `<code-block>` element. Add a new
 * highlighted surface by calling one of these — don't reach for a second
 * highlighter.
 *
 * Thin wrapper over the vendored Prism.js loaded on `window` (see index.html).
 * We read `window.Prism` at call time — never import it — so this module stays
 * side-effect free and safe to load before Prism, and degrades to escaped plain
 * text when Prism or the requested grammar is unavailable (e.g. a worker
 * context, or a language whose component wasn't bundled).
 *
 * The tokens Prism emits carry `.token.<type>` classes; `css/prism-theme.css`
 * colours them, so any element produced here picks up the app theme for free.
 */

import { escapeHtml } from './html.js';

const BASH_SEGMENT_CLASS_COUNT = 6;
const BASH_OPERATOR_STARTS = new Set(['&', '|', ';', '<', '>', '\n']);
const BASH_THREE_CHAR_OPERATORS = new Set(['<<<', ';;&']);
const BASH_TWO_CHAR_OPERATORS = new Set(['&&', '||', '|&', ';;', ';&', '<<', '>>', '<&', '>&', '<>', '>|', '&>']);
const BASH_REDIRECT_OPERATORS = new Set(['<', '>', '<<', '>>', '<<<', '<&', '>&', '<>', '>|', '&>']);

/**
 * @typedef {{ kind: 'segment'|'operator', text: string }} BashPiece
 */

/**
 * Highlight a code string, returning safe HTML.
 *
 * Prism escapes the source as it tokenises, so the returned string is safe to
 * assign to `innerHTML`. When Prism or the grammar is missing we fall back to
 * `escapeHtml`, so the return value is always insertion-safe.
 * @param {string} code - Source code to highlight
 * @param {string} language - Prism language id (e.g. 'bash', 'json', 'python')
 * @returns {string} Highlighted (or escaped) HTML
 */
export function highlightCode(code, language) {
  const text = (code === null || code === undefined) ? '' : String(code);
  if (language === 'bash' || language === 'sh' || language === 'shell') {
    return highlightBashCommand(text);
  }

  /** @type {any} */
  const Prism = typeof window !== 'undefined' ? (/** @type {any} */ (window)).Prism : undefined;
  const grammar = Prism?.languages?.[language];
  if (Prism && grammar) {
    try {
      return Prism.highlight(text, grammar, language);
    } catch (error) {
      console.error('[syntax-highlight] highlighting failed:', error);
    }
  }
  return escapeHtml(text);
}

/**
 * Highlight shell commands for readability rather than language completeness.
 * The UI needs to show the top-level shape of long compound commands: sections,
 * connecting operators, the command word in each section, and its arguments.
 * @param {string} text - Bash command text
 * @returns {string} Safe highlighted HTML
 */
function highlightBashCommand(text) {
  const pieces = splitBashCommand(text);
  let segmentIndex = 0;
  let previousOperator = '';

  return pieces.map((piece) => {
    if (piece.kind === 'operator') {
      previousOperator = piece.text.trim();
      const redirectClass = isRedirectOperator(previousOperator) ? ' bash-command-redirect-operator' : '';
      return `<span class="token bash-command-operator${redirectClass}">${escapeHtml(piece.text)}</span>`;
    }

    const isRedirectTarget = isRedirectOperator(previousOperator);
    previousOperator = '';
    if (!piece.text.trim()) return escapeHtml(piece.text);

    const className = `token bash-command-segment bash-command-segment-${segmentIndex % BASH_SEGMENT_CLASS_COUNT}`;
    segmentIndex++;
    return `<span class="${className}">${highlightBashSegment(piece.text, isRedirectTarget)}</span>`;
  }).join('');
}

/**
 * Split a shell command at top-level operators, preserving quotes and common
 * substitutions well enough for display. This is a highlighter, not a shell
 * parser: incomplete syntax just remains part of the nearest text section.
 * @param {string} input
 * @returns {BashPiece[]} The command split into operator and text pieces.
 */
function splitBashCommand(input) {
  /** @type {BashPiece[]} */
  const pieces = [];
  let segmentStart = 0;
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let parenDepth = 0;
  let braceDepth = 0;

  const pushSegment = (/** @type {number} */ end) => {
    if (end > segmentStart) pieces.push({ kind: 'segment', text: input.slice(segmentStart, end) });
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1] || '';

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (singleQuoted) {
      if (ch === "'") singleQuoted = false;
      i++;
      continue;
    }

    if (backtickQuoted) {
      if (ch === '`') backtickQuoted = false;
      i++;
      continue;
    }

    if (ch === "'" && !doubleQuoted) {
      singleQuoted = true;
      i++;
      continue;
    }

    if (ch === '`' && !doubleQuoted) {
      backtickQuoted = true;
      i++;
      continue;
    }

    if (ch === '"') {
      doubleQuoted = !doubleQuoted;
      i++;
      continue;
    }

    if (!doubleQuoted) {
      if (ch === '$' && next === '(') {
        parenDepth++;
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        braceDepth++;
        i += 2;
        continue;
      }
      if (parenDepth > 0 && ch === '(') {
        parenDepth++;
        i++;
        continue;
      }
      if (parenDepth > 0 && ch === ')') {
        parenDepth--;
        i++;
        continue;
      }
      if (braceDepth > 0 && ch === '}') {
        braceDepth--;
        i++;
        continue;
      }
    }

    if (!doubleQuoted && parenDepth === 0 && braceDepth === 0) {
      const operator = readBashOperator(input, i);
      if (operator) {
        pushSegment(i);
        pieces.push({ kind: 'operator', text: operator });
        i += operator.length;
        segmentStart = i;
        continue;
      }
    }

    i++;
  }

  pushSegment(input.length);
  return pieces;
}

/**
 * @param {string} input
 * @param {number} i
 * @returns {string} The operator starting at `i`, or `''` if none starts there.
 */
function readBashOperator(input, i) {
  const ch = input[i] || '';
  if (!BASH_OPERATOR_STARTS.has(ch)) return '';
  if (isFileDescriptorDuplicationAt(input, i)) return '';

  const three = input.slice(i, i + 3);
  if (BASH_THREE_CHAR_OPERATORS.has(three)) return three;

  const fdRedirect = input.slice(i).match(/^\d*(?:>>?|<<?|<>|>&|<&)/);
  if (fdRedirect) return fdRedirect[0];

  const two = input.slice(i, i + 2);
  if (BASH_TWO_CHAR_OPERATORS.has(two)) return two;

  return ch;
}

/**
 * Treat compact fd duplication like `2>&1` or `1<&0` as an argument-shaped word.
 * Splitting inside it adds visual noise without helping users parse command flow.
 * @param {string} input
 * @param {number} i
 * @returns {boolean} True when the character at `i` is part of an fd duplication like `2>&1`.
 */
function isFileDescriptorDuplicationAt(input, i) {
  const ch = input[i];
  const prev = input[i - 1] || '';
  const prevPrev = input[i - 2] || '';
  const next = input[i + 1] || '';
  if ((ch === '>' || ch === '<') && next === '&') {
    return /\d/.test(prev) && /\d|-/.test(input[i + 2] || '');
  }
  if (ch === '&' && (prev === '>' || prev === '<')) {
    return /\d/.test(prevPrev) && /\d|-/.test(next);
  }
  return false;
}

/**
 * @param {string} operator
 * @returns {boolean} True when `operator` redirects a stream (e.g. `>`, `2>>`).
 */
function isRedirectOperator(operator) {
  return BASH_REDIRECT_OPERATORS.has(operator) || /^\d*(?:>>?|<<?|<>|>&|<&)$/.test(operator);
}

/**
 * Render one command section. The first non-assignment word is highlighted as
 * the command head, while later words are quieter arguments of the same hue.
 * @param {string} text
 * @param {boolean} isRedirectTarget
 * @returns {string} HTML for the segment, with command and argument spans.
 */
function highlightBashSegment(text, isRedirectTarget) {
  const tokens = splitBashWords(text);
  let commandSeen = false;

  return tokens.map((token) => {
    if (/^\s+$/.test(token)) return escapeHtml(token);

    const quotedClass = /^(['"])/.test(token) ? ' bash-command-string' : '';
    if (isRedirectTarget) {
      return `<span class="bash-command-redirect-target${quotedClass}">${escapeHtml(token)}</span>`;
    }
    if (!commandSeen && isAssignmentWord(token)) {
      return `<span class="bash-command-assignment${quotedClass}">${escapeHtml(token)}</span>`;
    }
    if (!commandSeen) {
      commandSeen = true;
      return `<span class="bash-command-head${quotedClass}">${escapeHtml(token)}</span>`;
    }
    return `<span class="bash-command-arg${quotedClass}">${escapeHtml(token)}</span>`;
  }).join('');
}

/**
 * Split a command segment into whitespace and word tokens, keeping quoted strings
 * as part of the word so command/argument styling preserves shell grouping.
 * @param {string} text
 * @returns {string[]} Alternating whitespace and word tokens, quotes preserved.
 */
function splitBashWords(text) {
  /** @type {string[]} */
  const tokens = [];
  let start = 0;
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;

  const push = (/** @type {number} */ end) => {
    if (end > start) tokens.push(text.slice(start, end));
  };

  while (i < text.length) {
    const ch = text[i] || '';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (singleQuoted) {
      if (ch === "'") singleQuoted = false;
      i++;
      continue;
    }
    if (doubleQuoted) {
      if (ch === '"') doubleQuoted = false;
      i++;
      continue;
    }
    if (backtickQuoted) {
      if (ch === '`') backtickQuoted = false;
      i++;
      continue;
    }
    if (ch === "'") {
      singleQuoted = true;
      i++;
      continue;
    }
    if (ch === '"') {
      doubleQuoted = true;
      i++;
      continue;
    }
    if (ch === '`') {
      backtickQuoted = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      push(i);
      start = i;
      while (i < text.length && /\s/.test(text[i] || '')) i++;
      push(i);
      start = i;
      continue;
    }
    i++;
  }

  push(text.length);
  return tokens;
}

/**
 * @param {string} token
 * @returns {boolean} True when `token` is a `NAME=value` assignment word.
 */
function isAssignmentWord(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/.test(token);
}

/**
 * Build an element containing highlighted code.
 *
 * The element carries `language-<id>` (so Prism's theme selectors match) plus
 * `syntax-highlight` (an integration hook for callers that need to tune
 * wrapping/sizing to their surrounding layout).
 * @param {string} code - Source code to highlight
 * @param {string} language - Prism language id (e.g. 'bash')
 * @param {string} [tag='code'] - Element tag to create
 * @returns {HTMLElement} Element with highlighted content
 */
export function createHighlightedCode(code, language, tag = 'code') {
  const el = document.createElement(tag);
  el.className = `syntax-highlight language-${language}`;
  el.innerHTML = highlightCode(code, language);
  return el;
}
