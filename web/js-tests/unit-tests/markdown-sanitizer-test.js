//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Markdown sanitizer test.
 *
 * The frontend renders LLM/user/tool output through renderMarkdown into the
 * DOM via innerHTML in many places. This test pins the sanitizer behavior so
 * a regression in escaping turns into a red test rather than an XSS vector.
 *
 * The renderer is not a full sanitizer (marked.js by itself isn't): it relies
 * on escapeXmlTagsForMarkdown to neutralize raw HTML/script content outside
 * code blocks. These cases lock that in.
 * @module unit-tests/markdown-sanitizer-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { renderMarkdown } = await import('../../sdk/lib/markdown.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('escapes <script> tags', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert(!html.includes('<script>'), `output should not contain raw <script>: ${html}`);
    assert(!html.toLowerCase().includes('alert(1)') || html.includes('&'), `script payload must be neutralized: ${html}`);
  });

  run('escapes <img onerror>', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    assert(!html.includes('<img'), `output should not contain raw <img>: ${html}`);
  });

  run('escapes <iframe>', () => {
    const html = renderMarkdown('<iframe src="javascript:alert(1)"></iframe>');
    assert(!html.includes('<iframe'), `output should not contain raw <iframe>: ${html}`);
  });

  run('escapes inline event handlers in attributes', () => {
    const html = renderMarkdown('<a href="#" onclick="alert(1)">x</a>');
    // The raw <a ...> must be escaped; an unescaped element with an
    // inline handler would be a live XSS sink. The escaped form
    // (`&lt;a ...&gt;`) is fine — it's text content, not markup.
    assert(!/<a\b[^>]*\bonclick=/i.test(html), `unescaped <a onclick=...> must not survive: ${html}`);
  });

  run('preserves code blocks (script inside ``` is data, not markup)', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    assert(html.includes('<code'), `code block should render: ${html}`);
    assert(!/<script>(?!&lt;)/.test(html), `script inside fence must be escaped: ${html}`);
  });

  run('plain markdown still works', () => {
    const html = renderMarkdown('**bold** and _italic_');
    assert(html.includes('<strong>bold</strong>'), `bold should render: ${html}`);
    assert(html.includes('<em>italic</em>'), `italic should render: ${html}`);
  });

  run('autolink does not break on javascript: URLs', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    assert(!/href="javascript:/i.test(html), `javascript: URL must not appear in href: ${html}`);
  });

  run('neutralizes a custom element that slips past the backtick pre-escaper', () => {
    // Real bug (thread-summary "mirror input box"): an unbalanced backtick
    // earlier in the text desyncs the naive escapeXmlTagsForMarkdown pass from
    // marked's own code-span parsing. The escaper believes it is inside a code
    // span (so it passes `<input-box>` through verbatim) while marked treats the
    // lone backtick as a literal and emits the tag as raw HTML — which the
    // browser then upgrades into a live, in-sync copy of the composer.
    const html = renderMarkdown('use the `-x flag, then <input-box></input-box> shows up');
    assert(!/<input-box\b/i.test(html), `raw <input-box> must not survive into the DOM: ${html}`);
    assert(!/<[a-z][a-z0-9]*-[a-z0-9-]*/i.test(html), `no raw custom-element (hyphenated) tag may survive: ${html}`);
  });

  run('neutralizes raw custom elements even with escapeXml disabled', () => {
    // The plan renderer calls renderMarkdown(..., { escapeXml: false }), so no
    // pre-escaping runs at all. The post-parse output sanitizer is the
    // authoritative boundary and must still strip custom elements.
    const html = renderMarkdown('<input-box></input-box> and <my-widget>x</my-widget>', { escapeXml: false });
    assert(!/<input-box\b/i.test(html), `raw <input-box> must not survive: ${html}`);
    assert(!/<my-widget\b/i.test(html), `raw custom element must not survive: ${html}`);
  });

  run('strips inline event handlers from otherwise-allowed tags', () => {
    // With escapeXml off, a plain <a> is allowed markup, but an inline handler
    // on it is a live XSS sink and must be removed by the sanitizer.
    const html = renderMarkdown('<a href="#" onclick="alert(1)">x</a>', { escapeXml: false });
    assert(!/\bonclick=/i.test(html), `inline event handler must be stripped: ${html}`);
  });

  return { passed, failed, errors };
}
