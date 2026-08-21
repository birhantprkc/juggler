//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scoped-CSS rendering against a real assistant message.
 *
 * The message reproduced in helpers/todo-preview-message.js is the actual reply
 * that reported this bug: a design preview whose `<style>` block rendered as
 * text and whose inline styles were stripped. This test renders that message
 * and asserts the properties the fix exists to give it — CSS applied but
 * confined, styles intact — without pinning its every byte.
 * @module unit-tests/markdown-scoped-css-test
 */

import { assert } from '../utilities/test-helpers.js';
import { TODO_PREVIEW_MESSAGE } from '../utilities/todo-preview-message.js';

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

  const { renderAssistantContentWrapped } = await import('../../sdk/lib/markdown.js');

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

  /** The rendered output of the real message. */
  let html = '';
  run('renders the real preview message', () => {
    html = renderAssistantContentWrapped(TODO_PREVIEW_MESSAGE);
    assert(html.includes('markdown-html-scope'), `message with CSS should be boxed: ${html.slice(0, 300)}`);
  });

  run('no style rule reaches the document unscoped', () => {
    // Every selector the message authored sits under the per-render scope. If
    // even one escaped, it would restyle every message in the column.
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const css = Array.from(tpl.content.querySelectorAll('style')).map((s) => s.textContent || '').join('\n');
    // Rule selectors are the lines ending in `{`. Strip the @keyframes blocks
    // first: their `0% { … }` keyframe selectors are offsets, not selectors,
    // and are rightly unprefixed. Nested/one-line rules share their line with
    // declarations, so only whole-line selectors count.
    const withoutKeyframes = css.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '');
    const selectors = withoutKeyframes.split('\n').filter((l) => /^\s*[^@\s][^{]*\{\s*$/.test(l) || /^[^@{}]+\{[^}]*\}\s*$/.test(l.trim() === '' ? '' : l));
    assert(selectors.length > 10, `expected the message's many rules to be present: found ${selectors.length}`);
    const unscoped = selectors.filter((l) => !l.includes('[data-markdown-scope'));
    assert(unscoped.length === 0, `${unscoped.length} selector(s) escaped the scope: ${unscoped.slice(0, 3).join(' | ')}`);
  });

  run('the panel and its variables land on the scope element', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const box = tpl.content.querySelector('.markdown-html-scope');
    assert(box !== null, `box should exist: ${html.slice(0, 200)}`);
    const panel = box?.querySelector('.tbx-panel');
    assert(panel !== null, `the message's own panel markup should render: ${box?.innerHTML.slice(0, 200)}`);
    // The variables are defined on .tbx-panel, which is inside the scope, so
    // the scoped `.tbx .tbx-panel` rule must survive intact.
    const css = box?.querySelector('style')?.textContent || '';
    assert(css.includes('.tbx-panel'), `panel rule should survive: ${css.slice(0, 200)}`);
    assert(css.includes('--accent-green'), `CSS variables should survive: ${css.slice(0, 200)}`);
  });

  run('keyframes are renamed and still referenced', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const css = tpl.content.querySelector('style')?.textContent || '';
    assert(!/@keyframes\s+tbx-fade\s*{/.test(css), `app-colliding name must be renamed: ${css.slice(0, 120)}`);
    assert(/@keyframes\s+tbx-fade-md\d+/.test(css), `keyframes should be suffixed: ${css.slice(0, 120)}`);
    assert(/tbx-fade-md\d+/.test(css.replace(/@keyframes\s+tbx-fade-md\d+/g, '')), `animation shorthand should use the renamed keyframes: ${css.slice(0, 200)}`);
  });

  run('media queries survive with their contents scoped', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const css = tpl.content.querySelector('style')?.textContent || '';
    assert(css.includes('prefers-reduced-motion'), `the reduced-motion guard should survive: ${css.slice(0, 120)}`);
    assert(/@media[^{]*\{[\s\S]*\[data-markdown-scope/.test(css), `rules inside @media should be scoped: ${css.slice(0, 200)}`);
  });

  run('inline styles on the message\'s elements survive', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    assert(tpl.content.querySelector('.big[style*="display"]') !== null, `the 3x-scale swatch spans keep their inline style: ${html.slice(0, 200)}`);
    assert(tpl.content.querySelector('[style*="flex"]') !== null, `the side-by-side comparison keeps its flex layout style`);
  });

  run('checkbox inputs and their data attributes survive', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const boxes = tpl.content.querySelectorAll('input.tb');
    assert(boxes.length >= 5, `the five state checkboxes should render: found ${boxes.length}`);
    assert(tpl.content.querySelector('input[data-task-state="in_progress"]') !== null, `task-state attributes should survive`);
    // The message's checkboxes are authored preview markup, not task-list
    // markers: the tick-box decoration must leave them as the inputs they are.
    assert(!tpl.content.querySelector('li .task-box'), `authored checkboxes must not be swapped for tick boxes: ${tpl.content.querySelector('li .task-box')?.outerHTML}`);
    assert(tpl.content.querySelector('ol.demo li input.tb') !== null, `the plan list at the bottom keeps its inputs`);
  });

  run('data-URL SVG glyphs survive untouched', () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const css = tpl.content.querySelector('style')?.textContent || '';
    // The baked-white check glyph is a data: URL inside url(...) — it must come
    // through the CSSOM round-trip intact, or every box renders empty.
    assert(css.includes('data:image/svg+xml'), `the SVG tick glyph should survive: ${css.slice(0, 120)}`);
    assert((css.match(/data:image\/svg\+xml/g) || []).length >= 4, `all four state glyphs should survive`);
  });

  return { passed, failed, errors };
}
