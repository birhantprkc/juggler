//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Text-selection highlight colour.
 *
 * Without an authored `::selection` rule every engine substitutes its own
 * highlight — on Linux that is the GTK theme's accent, which is commonly a red
 * or pink. The app therefore paints the selection itself, from `--selection-bg`,
 * and this test holds the three properties that makes it worth having: the
 * variable resolves, it is declared in BOTH theme blocks (a variable declared
 * only in the dark block is inherited by light and would never flip), and the
 * document-level `::selection` rule actually paints it.
 * @module unit-tests/selection-colour-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Resolves a colour string through the engine so declarations written in
 * different syntaxes (`rgb(a b c / 80%)` vs `rgba(a, b, c, 0.8)`) compare equal.
 * @param {string} value - Any CSS colour
 * @returns {string} The computed form, or '' if the engine rejected it
 */
function canonicalColour(value) {
  const probe = document.createElement('div');
  probe.style.backgroundColor = '';
  probe.style.backgroundColor = value.trim();
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return probe.style.backgroundColor === '' ? '' : computed;
}

/**
 * Every `::selection` rule the page carries, from every stylesheet it loaded.
 *
 * Read off the cascade rather than out of `getComputedStyle(el, '::selection')`
 * because the two engines answer that differently: WebKit resolves a highlight
 * pseudo against the element it covers, Chromium against the highlight
 * inheritance chain, so the computed `color` there says which engine is running
 * and not what the app authored.
 * @returns {CSSStyleRule[]} The rules, in the order the sheets declare them.
 */
function selectionRules() {
  /** @type {CSSStyleRule[]} */
  const found = [];
  /** @param {CSSRuleList} rules */
  const walk = (rules) => {
    for (const rule of rules) {
      const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (grouped) walk(grouped);
      const selector = /** @type {CSSStyleRule} */ (rule).selectorText;
      if (selector?.includes('::selection')) found.push(/** @type {CSSStyleRule} */ (rule));
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin refuses to be read; the app's own are same-origin.
    }
  }
  return found;
}

/**
 * @returns {string} The current theme's `--selection-bg`, resolved
 */
function selectionVar() {
  return getComputedStyle(document.documentElement).getPropertyValue('--selection-bg').trim();
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

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

  const originalTheme = document.documentElement.getAttribute('data-theme');

  try {
    document.documentElement.setAttribute('data-theme', 'dark');
    const dark = selectionVar();
    document.documentElement.setAttribute('data-theme', 'light');
    const light = selectionVar();

    run('both themes define a selection colour', () => {
      assert(dark !== '', 'dark theme should define --selection-bg');
      assert(light !== '', 'light theme should define --selection-bg');
    });

    run('the two themes differ', () => {
      // A variable declared only in the dark block is inherited by light, so an
      // equal pair means the light block is missing its declaration.
      assert(canonicalColour(dark) !== canonicalColour(light),
        `light and dark must declare their own colour, both are ${dark}`);
    });

    run('the colour is translucent so it tints rather than fills', () => {
      // Selection lands over bubbles, code blocks and images alike; an opaque
      // fill hides whatever it covers.
      for (const [theme, value] of [['dark', dark], ['light', light]]) {
        const computed = canonicalColour(value);
        assert(computed.startsWith('rgba('), `${theme} --selection-bg should carry alpha: ${value} -> ${computed}`);
      }
    });

    run('::selection paints the variable', () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      const el = document.createElement('div');
      el.textContent = 'selection';
      document.body.appendChild(el);
      try {
        const painted = getComputedStyle(el, '::selection').backgroundColor;
        assert(painted === canonicalColour(dark),
          `::selection should paint --selection-bg (${canonicalColour(dark)}), got ${painted}`);
      } finally {
        el.remove();
      }
    });

    run('::selection leaves the text colour alone', () => {
      // Setting `color` would flatten syntax highlighting inside a selection,
      // and leaving it unset is also what stops the platform substituting its
      // own selected-text colour: a rule that matches at all is enough.
      const rules = selectionRules();
      assert(rules.length > 0, 'the app should author ::selection somewhere');
      for (const rule of rules) {
        for (const property of ['color', '-webkit-text-fill-color']) {
          const declared = rule.style.getPropertyValue(property);
          assert(declared === '',
            `${rule.selectorText} should leave the text colour alone, it sets ${property}: ${declared}`);
        }
      }
    });
  } finally {
    if (originalTheme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', originalTheme);
  }

  return { passed, failed, errors };
}
