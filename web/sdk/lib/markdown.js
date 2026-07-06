//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Markdown rendering utilities with safe XML/HTML handling
 */

import { createCopyButton } from './copy-button.js';
import { externalURLFromHref } from './window-control.js';

/**
 * Escape XML/HTML tags that appear outside of code blocks
 * This prevents stray XML like <read_file> from vanishing in markdown rendering
 * Also wraps XML tags in inline code formatting for monospace display
 * @param {string} text - Raw text that may contain XML tags
 * @returns {string} Text with XML tags wrapped in inline code
 */
export function escapeXmlTagsForMarkdown(text) {
  // Strategy: Find XML tags and wrap them in inline code (`...`) for monospace display
  // We detect code blocks by looking for ``` fences and inline code with `

  let result = '';
  let inCodeBlock = false;
  let inInlineCode = false;
  let i = 0;

  while (i < text.length) {
    // Check for code fence (```)
    if (text.substr(i, 3) === '```') {
      inCodeBlock = !inCodeBlock;
      result += '```';
      i += 3;
      continue;
    }

    // Check for inline code (`)
    if (text[i] === '`' && !inCodeBlock) {
      inInlineCode = !inInlineCode;
      result += '`';
      i++;
      continue;
    }

    // If we're in a code context, don't escape
    if (inCodeBlock || inInlineCode) {
      result += text[i];
      i++;
      continue;
    }

    // Outside code: look for XML tags and wrap them in inline code
    if (text[i] === '<') {
      // Find the end of the tag
      let tagEnd = i + 1;
      while (tagEnd < text.length && text[tagEnd] !== '>') {
        tagEnd++;
      }

      if (tagEnd < text.length) {
        // Found complete tag, wrap it in inline code
        const tag = text.substring(i, tagEnd + 1);
        result += '`' + tag + '`';
        i = tagEnd + 1;
      } else {
        // Incomplete tag (just < without >), escape it
        result += '&lt;';
        i++;
      }
    } else if (text[i] === '>') {
      // Stray > without matching <, escape it
      result += '&gt;';
      i++;
    } else {
      result += text[i];
      i++;
    }
  }

  return result;
}

/**
 * Replace href/src URLs whose scheme is one of the script-execution sinks
 * (javascript:, vbscript:, data: when not a known-safe image type) with "#".
 * Operates on the rendered HTML string; we accept the small false-positive
 * cost (e.g. text content that literally contains the substring inside an
 * attribute) in exchange for not pulling in a full HTML parser.
 * @param {string} html - HTML to scrub
 * @returns {string} HTML with dangerous URLs neutralised
 */
function neutraliseDangerousUrls(html) {
  // Matches href= or src= followed by " or ' or no quote, then optional
  // whitespace, then one of the dangerous schemes.
  return html.replace(
    /(\b(?:href|src)\s*=\s*)(["']?)\s*(javascript:|vbscript:|data:text\/html)[^"'\s>]*/gi,
    (_match, attr, quote) => `${attr}${quote}#`
  );
}

/**
 * Rewrite every external link in rendered markdown so it opens outside the app
 * instead of navigating the in-process WebView off its page.
 *
 * This is the real fix for "an LLM-authored link hijacked my window": a markdown
 * link emits a plain same-window `<a href>` with no `target`, so a click makes
 * the WebView navigate away. We own the markdown→HTML step, so we neutralise it
 * here at the source. For each external (or scheme-less bare-domain) link we:
 *  - re-qualify the href to an absolute `https://` URL (a bare `github.com/u/r`
 *    would otherwise resolve same-origin and navigate the app to itself), and
 *  - add `target="_blank" rel="noopener noreferrer"`.
 *
 * In a normal browser `target="_blank"` opens a new tab. In the native WebView
 * `_blank` is swallowed (no navigation), and the delegated click handler in
 * app.js turns that click into a system-browser open via the loopback opener —
 * so the destructive navigation never happens regardless of which path runs.
 *
 * Genuine relative links (`readme.md`, `docs/guide`), in-page `#hash`, and
 * same-origin links are left untouched. Operates on the HTML string (consistent
 * with neutraliseDangerousUrls); marked emits `href` as the first anchor
 * attribute, so the targeted regex is sufficient.
 * @param {string} html - Rendered HTML.
 * @returns {string} HTML with external links rewritten to open externally.
 */
function externalizeLinks(html) {
  if (typeof window === 'undefined') return html;
  const origin = window.location.origin;
  const base = window.location.href;
  return html.replace(/<a\s+href="([^"]*)"([^>]*)>/gi, (match, href, rest) => {
    let resolved = href;
    try {
      resolved = new URL(href, base).href;
    } catch {
      // Leave unparseable hrefs to externalURLFromHref's own handling.
    }
    const external = externalURLFromHref(href, resolved, origin);
    if (!external) return match;
    // Drop any target/rel marked may have emitted; we set our own.
    const cleaned = rest.replace(/\s(?:target|rel)="[^"]*"/gi, '');
    return `<a href="${external}"${cleaned} target="_blank" rel="noopener noreferrer">`;
  });
}

/**
 * Tags marked (with gfm) legitimately emits, plus the handful of inline
 * formatting elements a summary/plan can carry. Everything else — most
 * importantly any hyphenated *custom element* like `<input-box>` — is neutralised
 * by {@link sanitizeRenderedHtml}. `input` is here only for gfm task-list
 * checkboxes; its attributes are still filtered against ALLOWED_ATTRS.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd',
  'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
]);

/**
 * Attributes allowed to survive on an allowlisted element. Anything else — and
 * every `on*` inline event handler regardless of this list — is stripped. URL
 * attributes (href/src) are additionally scrubbed by neutraliseDangerousUrls
 * before this pass runs.
 */
const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel', 'type',
  'checked', 'disabled', 'align', 'colspan', 'rowspan', 'start', 'width', 'height',
]);

/**
 * The authoritative HTML sanitiser for rendered markdown. marked (with gfm and
 * inline HTML on) happily emits any raw tag the source text contained, and
 * escapeXmlTagsForMarkdown is only a best-effort *pre*-pass whose naive backtick
 * accounting desyncs from marked's real code-span parsing — so a raw tag can
 * still reach the output string. Since callers drop that string into
 * `innerHTML`, a surviving *custom element* (e.g. `<input-box>`) is upgraded by
 * the browser into a live component (the "mirror input box in a thread summary"
 * bug). This pass is the real boundary: it parses the HTML into an inert
 * `<template>` (scripts don't run, images don't load, custom elements do NOT
 * upgrade), drops disallowed tags to visible escaped text, strips disallowed and
 * event-handler attributes, then re-serialises. Runs last so nothing downstream
 * can reintroduce raw markup.
 * @param {string} html - Rendered (and URL-scrubbed) HTML.
 * @returns {string} HTML containing only allowlisted tags and attributes.
 */
function sanitizeRenderedHtml(html) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    // No DOM to parse with. Every real caller runs in a DOM context (renderMarkdown
    // already depends on window.marked + document); this is only a defensive guard.
    return html;
  }
  const tpl = document.createElement('template');
  // Assigning to a <template>'s innerHTML parses into an inert document fragment:
  // custom elements are NOT upgraded and scripts do NOT execute here.
  tpl.innerHTML = html;

  /** @param {Node} parent */
  const walk = (parent) => {
    // Snapshot children first — we mutate the tree during iteration.
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 8 /* COMMENT_NODE */) {
        parent.removeChild(node);
        continue;
      }
      if (node.nodeType !== 1 /* ELEMENT_NODE */) continue;
      const el = /** @type {Element} */ (node);
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Neutralise: replace the element (and its subtree) with its serialised
        // markup as a text node. `<input-box></input-box>` becomes visible,
        // inert text (`&lt;input-box&gt;…`) instead of a live component.
        parent.replaceChild(document.createTextNode(el.outerHTML), el);
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
          el.removeAttribute(attr.name);
        }
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

/**
 * Render markdown with syntax highlighting and safe XML handling
 * @param {string} content - Markdown content to render
 * @param {object} [options] - Rendering options
 * @param {boolean} [options.escapeXml=true] - Whether to escape XML tags outside code blocks
 * @returns {string} Rendered HTML
 */
export function renderMarkdown(content, options = {}) {
  const { escapeXml = true } = options;

  /** @type {any} */
  const marked = /** @type {any} */(window).marked;

  if (!marked) {
    console.warn('[Markdown] marked.js not available, falling back to plain text');
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }

  try {
    // Pre-process: escape XML tags if enabled
    const processedContent = escapeXml ? escapeXmlTagsForMarkdown(content) : content;

    marked.setOptions({
      breaks: true,
      gfm: true
    });

    // Parse markdown, then strip dangerous URL schemes from the result.
    // marked.js does not filter javascript: / vbscript: / data: hrefs by
    // default, so a link like [click](javascript:alert(1)) would render
    // as a live XSS sink. Belt-and-braces neutralisation post-parse:
    const raw = marked.parse(processedContent);
    // Sanitise LAST: neutraliseDangerousUrls/externalizeLinks are string passes
    // that scrub URLs; sanitizeRenderedHtml is the authoritative tag/attribute
    // boundary that strips any raw markup (custom elements, script, stray HTML)
    // marked emitted, so nothing unsafe reaches the caller's innerHTML.
    return sanitizeRenderedHtml(externalizeLinks(neutraliseDangerousUrls(raw)));
  } catch (e) {
    console.error('[Markdown] Parsing error:', e);
    // Fall back to escaped content
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }
}

/**
 * Add our standard copy-to-clipboard button to the corner of every `<pre>`
 * code block inside a freshly-rendered markdown element.
 *
 * `renderMarkdown` returns an HTML string, so it cannot wire up live buttons;
 * callers that insert that HTML into the DOM call this on the container
 * afterwards. Each `<pre>` is wrapped in a non-scrolling positioning context
 * (`.code-block-wrap`) so the button stays pinned to the visible corner even
 * when the code scrolls horizontally. Idempotent: a `<pre>` already inside a
 * wrapper is skipped, so re-running on the same subtree is a no-op.
 * @param {HTMLElement|null|undefined} root - Container holding rendered markdown.
 */
export function decorateCodeBlocks(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  root.querySelectorAll('pre').forEach((pre) => {
    // Skip a <pre> we've already wrapped (e.g. on a redundant re-decorate).
    if (pre.parentElement?.classList.contains('code-block-wrap')) return;

    const wrap = document.createElement('div');
    wrap.className = 'code-block-wrap';
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const codeEl = pre.querySelector('code');
    wrap.appendChild(createCopyButton(
      () => (codeEl || pre).textContent || '',
      'code-copy-button'
    ));
  });
}

/**
 * Render markdown and wrap in a div with markdown class
 * @param {string} content - Markdown content to render
 * @param {object} [options] - Rendering options
 * @param {boolean} [options.escapeXml=true] - Whether to escape XML tags outside code blocks
 * @returns {string} Rendered HTML wrapped in div.markdown
 */
export function renderMarkdownWrapped(content, options = {}) {
  const html = renderMarkdown(content, options);
  return `<div class="markdown">${html}</div>`;
}
