//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * External-link resolution test.
 *
 * Markdown-rendered LLM output emits <a href> anchors. Clicking one must never
 * navigate the app's webview off its page — externalURLFromHref decides which
 * anchors open in the system browser instead, recovering the author's intent
 * from a scheme-less bare-domain href. These cases pin that behaviour.
 * @module unit-tests/external-link-test
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

  const { externalURLFromHref } = await import('../../sdk/lib/window-control.js');

  const ORIGIN = 'http://127.0.0.1:8080';

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

  /**
   * Mimic how the browser resolves a raw href against the current page.
   * @param {string} raw
   * @returns {string} resolved absolute href
   */
  const resolve = (raw) => new URL(raw, `${ORIGIN}/`).href;

  /**
   * @param {string} raw
   * @returns {string|null} The external URL to open, or null when the link should not open externally.
   */
  const decide = (raw) => externalURLFromHref(raw, resolve(raw), ORIGIN);

  run('cross-origin https link opens externally as-is', () => {
    assert(decide('https://github.com/u/r') === 'https://github.com/u/r',
      'full https link should open externally');
  });

  run('cross-origin http link opens externally as-is', () => {
    assert(decide('http://example.com/page') === 'http://example.com/page',
      'full http link should open externally');
  });

  run('scheme-less bare-domain link is re-qualified to https (the repo bug)', () => {
    // Without this, the browser resolves it same-origin and the click
    // navigates the webview to http://<app>/github.com/u/r, tearing the app
    // off its page.
    assert(decide('github.com/u/r') === 'https://github.com/u/r',
      `bare github.com/u/r should become https: ${decide('github.com/u/r')}`);
  });

  run('scheme-less www host is re-qualified even without a path', () => {
    assert(decide('www.example.com') === 'https://www.example.com',
      `www.example.com should become https: ${decide('www.example.com')}`);
  });

  run('genuine relative file link is left alone', () => {
    assert(decide('readme.md') === null, `relative readme.md must not be hijacked: ${decide('readme.md')}`);
  });

  run('genuine relative path is left alone', () => {
    assert(decide('docs/guide') === null, `relative docs/guide must not be hijacked: ${decide('docs/guide')}`);
  });

  run('in-page hash anchor is left alone', () => {
    assert(decide('#section') === null, 'hash anchor must not open externally');
  });

  run('same-origin explicit link is left alone', () => {
    assert(externalURLFromHref(`${ORIGIN}/app`, `${ORIGIN}/app`, ORIGIN) === null,
      'same-origin link must not open externally');
  });

  run('absolute same-origin path is left alone', () => {
    assert(decide('/api/health') === null, 'absolute same-origin path must not open externally');
  });

  run('non-web scheme is left alone (handler defers to default)', () => {
    assert(externalURLFromHref('mailto:x@y.com', 'mailto:x@y.com', ORIGIN) === null,
      'mailto must be left to default handling');
    assert(externalURLFromHref('javascript:alert(1)', 'javascript:alert(1)', ORIGIN) === null,
      'javascript: must not be opened externally');
  });

  run('empty href is left alone', () => {
    assert(externalURLFromHref('', `${ORIGIN}/`, ORIGIN) === null, 'empty href must be a no-op');
  });

  // End-to-end through the markdown→HTML step: this is where the destructive
  // navigation originates, so the rewrite must happen on the rendered anchor.
  const { renderMarkdown } = await import('../../sdk/lib/markdown.js');

  run('markdown bare-domain link renders as external https _blank anchor (the repo bug)', () => {
    const html = renderMarkdown('[repo](github.com/owner/name)');
    assert(/href="https:\/\/github\.com\/owner\/name"/.test(html),
      `bare-domain link must render absolute https href: ${html}`);
    assert(/target="_blank"/.test(html), `external link must open in a new context: ${html}`);
    assert(/rel="noopener noreferrer"/.test(html), `external link must carry noopener: ${html}`);
    // The destructive form — a same-window relative-looking href — must be gone.
    assert(!/href="github\.com/.test(html), `scheme-less href must not survive: ${html}`);
  });

  run('markdown full https link gets target=_blank', () => {
    const html = renderMarkdown('[x](https://example.com/page)');
    assert(/href="https:\/\/example\.com\/page"/.test(html), `https link preserved: ${html}`);
    assert(/target="_blank"/.test(html), `https link must open externally: ${html}`);
  });

  run('markdown relative link is NOT externalized', () => {
    const html = renderMarkdown('[doc](docs/guide.md)');
    assert(!/target="_blank"/.test(html), `relative link must stay in-app: ${html}`);
    assert(/href="docs\/guide\.md"/.test(html), `relative href preserved: ${html}`);
  });

  return { passed, failed, errors };
}
