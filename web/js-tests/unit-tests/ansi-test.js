//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ANSI renderer unit test.
 *
 * Bash output shown in the properties panel can carry ANSI escape sequences.
 * utils/ansi.js turns the SGR colour/style subset into styled DOM spans and
 * drops non-display escapes. This pins that behaviour: colours map to the
 * theme's --ansi-* variables, styled runs become spans, plain runs stay text,
 * and stray cursor/erase escapes never reach the visible text.
 * @module unit-tests/ansi-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

const ESC = '\x1b';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { ansiToFragment, applyAnsi, stripAnsi } = await import('../../sdk/lib/ansi.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {string} text
   * @returns {HTMLElement} a <pre> element with the ANSI-styled text applied
   */
  const render = (text) => {
    const pre = document.createElement('pre');
    applyAnsi(pre, text);
    return pre;
  };

  run('plain text is a single text node', () => {
    const frag = ansiToFragment('hello world');
    assert(frag.childNodes.length === 1, `expected 1 node, got ${frag.childNodes.length}`);
    assert(frag.childNodes[0].nodeType === Node.TEXT_NODE, 'should be a text node');
    assert(frag.textContent === 'hello world', `text mismatch: ${frag.textContent}`);
  });

  run('empty string yields empty fragment', () => {
    const frag = ansiToFragment('');
    assert(frag.textContent === '', 'empty in, empty out');
  });

  run('foreground colour becomes a styled span', () => {
    const pre = render(`${ESC}[31mred${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(!!span, 'expected a span');
    assert(span.textContent === 'red', `span text: ${span.textContent}`);
    assert(span.style.color === 'var(--ansi-fg-red)', `colour was: ${span.style.color}`);
    assert(pre.textContent === 'red', `visible text: ${pre.textContent}`);
  });

  run('bright foreground maps to bright var', () => {
    const pre = render(`${ESC}[91mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.color === 'var(--ansi-fg-bright-red)', `colour was: ${span.style.color}`);
  });

  run('background colour sets background', () => {
    const pre = render(`${ESC}[42mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.backgroundColor === 'var(--ansi-bg-green)', `bg was: ${span.style.backgroundColor}`);
  });

  run('fg/bg of same colour resolve to distinct role palettes', () => {
    // Regression: `[43;30m` (bg yellow, fg black) must not collapse to one
    // palette. Backgrounds use --ansi-bg-*, foregrounds --ansi-fg-*, so a
    // black-on-yellow highlight stays legible in light theme too.
    const pre = render(`${ESC}[43;30mWARNING${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.backgroundColor === 'var(--ansi-bg-yellow)', `bg was: ${span.style.backgroundColor}`);
    assert(span.style.color === 'var(--ansi-fg-black)', `fg was: ${span.style.color}`);
  });

  run('bold + italic + underline apply', () => {
    const pre = render(`${ESC}[1;3;4mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.fontWeight === 'bold', `weight: ${span.style.fontWeight}`);
    assert(span.style.fontStyle === 'italic', `style: ${span.style.fontStyle}`);
    assert(span.style.textDecoration.includes('underline'), `deco: ${span.style.textDecoration}`);
  });

  run('reset returns to plain text node', () => {
    const frag = ansiToFragment(`${ESC}[31ma${ESC}[0mb`);
    // 'a' styled span, 'b' plain text node
    assert(frag.childNodes.length === 2, `expected 2 nodes, got ${frag.childNodes.length}`);
    assert(frag.childNodes[0].nodeName.toLowerCase() === 'span', 'first is span');
    assert(frag.childNodes[1].nodeType === Node.TEXT_NODE, 'second is text');
    assert(frag.textContent === 'ab', `text: ${frag.textContent}`);
  });

  run('256-colour cube resolves to rgb', () => {
    const pre = render(`${ESC}[38;5;196mx${ESC}[0m`);
    const span = pre.querySelector('span');
    // index 196 -> cube (5,0,0) -> rgb(255 0 0)
    assert(span.style.color === 'rgb(255, 0, 0)', `colour was: ${span.style.color}`);
  });

  run('256-colour low index maps to named var', () => {
    const pre = render(`${ESC}[38;5;1mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.color === 'var(--ansi-fg-red)', `colour was: ${span.style.color}`);
  });

  run('truecolor resolves to literal rgb', () => {
    const pre = render(`${ESC}[38;2;10;20;30mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.color === 'rgb(10, 20, 30)', `colour was: ${span.style.color}`);
  });

  run('inverse swaps fg/bg', () => {
    const pre = render(`${ESC}[31;7mx${ESC}[0m`);
    const span = pre.querySelector('span');
    assert(span.style.backgroundColor === 'var(--ansi-bg-red)', `bg: ${span.style.backgroundColor}`);
    assert(span.style.color === 'var(--ansi-bg-default)', `fg: ${span.style.color}`);
  });

  run('non-SGR CSI escapes are dropped, not displayed', () => {
    const pre = render(`${ESC}[2K${ESC}[1;1Hhello`);
    assert(pre.textContent === 'hello', `visible text: ${JSON.stringify(pre.textContent)}`);
    assert(pre.querySelectorAll('span').length === 0, 'no styled spans for cursor/erase codes');
  });

  run('OSC title sequence is dropped', () => {
    const pre = render(`${ESC}]0;my title${'\x07'}body`);
    assert(pre.textContent === 'body', `visible text: ${JSON.stringify(pre.textContent)}`);
  });

  run('stripAnsi removes all escape codes', () => {
    const out = stripAnsi(`${ESC}[31mred${ESC}[0m ${ESC}[2Kplain`);
    assert(out === 'red plain', `stripped: ${JSON.stringify(out)}`);
  });

  run('stripAnsi is a no-op for plain text', () => {
    assert(stripAnsi('nothing here') === 'nothing here', 'plain unchanged');
  });

  run('applyAnsi replaces previous content', () => {
    const pre = document.createElement('pre');
    applyAnsi(pre, 'first');
    applyAnsi(pre, `${ESC}[32msecond${ESC}[0m`);
    assert(pre.textContent === 'second', `text: ${pre.textContent}`);
    assert(pre.querySelectorAll('span').length === 1, 'only the second render remains');
  });

  return { passed, failed, errors };
}
