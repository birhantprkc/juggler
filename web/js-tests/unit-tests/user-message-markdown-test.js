//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * User-message Markdown rendering tests.
 *
 * The <user-message> bubble renders its text through renderMarkdownWrapped in
 * `escapeXml: true` mode (the untrusted-input mode also used for thread goals).
 * These cases pin two contracts a future refactor could silently break:
 *  - the bubble DOM shows FORMATTED markdown (emphasis, code, links), and
 *  - user-typed markup is neutralised — a literal custom-element/script tag
 *    becomes inert visible text, never a live element or an executed script,
 *  - while the raw source still round-trips verbatim via the `content` getter,
 *    which is what copy / rollback / branch read (never the rendered DOM).
 * @module unit-tests/user-message-markdown-test
 */

import '../../js/components/user-message.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused; no backend needed)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Create a connected <user-message> with the given raw content.
   * @param {string} content - Raw (markdown) message source
   * @returns {HTMLElement} The connected element (caller removes it)
   */
  const make = (content) => {
    const el = document.createElement('user-message');
    el.setAttribute('message-id', 'M_test');
    el.setAttribute('content', content);
    document.body.appendChild(el);
    return el;
  };

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

  run('renders emphasis and inline code as markdown', () => {
    const el = make('**bold** and `code`');
    const text = el.querySelector('.user-message-text');
    assert(!!text, 'a .user-message-text block should be rendered');
    assert(!!text.querySelector('strong'), 'bold markdown should render a <strong>');
    assert(!!text.querySelector('code'), 'inline code should render a <code>');
    el.remove();
  });

  run('renders a markdown link as an anchor with its href preserved', () => {
    const el = make('see [docs](https://example.com/x)');
    const a = el.querySelector('.user-message-text a');
    assert(!!a, 'a markdown link should render an <a>');
    assert(/example\.com\/x/.test(a.getAttribute('href') || ''), `href should be preserved; got: ${a && a.getAttribute('href')}`);
    el.remove();
  });

  run('neutralises a literal custom-element tag to inert visible text', () => {
    const el = make('paste <input-box></input-box> here');
    assert(!el.querySelector('input-box'), 'a literal <input-box> must not become a live element');
    const txt = el.querySelector('.user-message-text').textContent || '';
    assert(txt.includes('<input-box>'), `the literal tag should survive as visible text; got: ${txt}`);
    el.remove();
  });

  run('does not inject or execute a script tag', () => {
    // @ts-ignore - test-only sentinel
    delete window.__userMsgXss;
    const el = make('<script>window.__userMsgXss = 1</script>');
    assert(!el.querySelector('script'), 'no live <script> may be injected into the bubble');
    // @ts-ignore - test-only sentinel
    assert(typeof window.__userMsgXss === 'undefined', 'script content must never execute');
    el.remove();
  });

  run('content getter returns the raw source verbatim (copy / rollback path)', () => {
    const src = '# heading\n\n- one\n- two';
    const el = make(src);
    assert(el.content === src, `raw markdown source must round-trip for copy/rollback; got: ${JSON.stringify(el.content)}`);
    el.remove();
  });

  return { passed, failed, errors };
}
