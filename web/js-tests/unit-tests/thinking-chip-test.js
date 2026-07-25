//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Composer-button thinking-chip render-rule unit tests.
 *
 * `ModelSelector._thinkingChipHTML` must always show the EFFECTIVE level for a
 * selected thinking-capable model: an explicit advertised level ⇒ solid chip;
 * no explicit level ⇒ hollow `.default` variant showing `defaultThinkingLevel`
 * (or "def" when the model declares none); non-thinking models ⇒ no chip at
 * all. Tested on a real (registered) model-selector instance created via
 * `document.createElement` but never appended — connectedCallback never runs,
 * so no network fetch, render, or WebSocket subscription happens — with
 * `providers`/`provider`/`model`/`_currentConfig` stubbed directly, following
 * the stubbed-instance pattern of other component unit tests.
 * @module unit-tests/thinking-chip-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/model-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Build a detached model-selector instance with one provider/model stubbed in.
 * @param {object} opts - Scenario knobs.
 * @param {string[]} [opts.levels] - `thinkingLevels` the model advertises, as
 *   native level strings shown verbatim (omit for a non-thinking model).
 * @param {string} [opts.defaultLevel] - The model's `defaultThinkingLevel`.
 * @param {string} [opts.thinking] - Explicit level in the current config.
 * @returns {any} The stubbed (never-connected) element.
 */
function makeSelector({ levels, defaultLevel, thinking }) {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  /** @type {any} */
  const modelEntry = { id: 'model-x', contextWindow: 200000 };
  if (levels) modelEntry.thinkingLevels = levels;
  if (defaultLevel) modelEntry.defaultThinkingLevel = defaultLevel;
  el.providers = [{ name: 'prov', displayName: 'Prov', available: true, modelsWithContext: [modelEntry] }];
  el.provider = 'prov';
  el.model = 'model-x';
  el._currentConfig = thinking
    ? { provider: 'prov', model: 'model-x', thinking }
    : { provider: 'prov', model: 'model-x' };
  return el;
}

/**
 * Parse chip HTML into an element for class/text assertions.
 * @param {string} html - The `_thinkingChipHTML()` return value.
 * @returns {Element|null} The chip element, or null for empty HTML.
 */
function chipOf(html) {
  if (!html) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.firstElementChild;
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('explicit advertised level renders a solid chip', () => {
    const el = makeSelector({ levels: ['low', 'medium', 'high'], defaultLevel: 'high', thinking: 'medium' });
    const chip = chipOf(el._thinkingChipHTML());
    assert(chip !== null, 'a chip must render for an explicit level');
    assert(chip.classList.contains('thinking-chip') && !chip.classList.contains('default'),
      `explicit level ⇒ solid (no .default) — got class "${chip.className}"`);
    assert(chip.textContent === 'medium', `the native level is shown verbatim ("medium"), got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('Thinking: medium'),
      `title names the explicit level — got "${chip.getAttribute('title')}"`);
  });

  await run('no explicit level renders the hollow .default variant with the model default', () => {
    const el = makeSelector({ levels: ['low', 'high'], defaultLevel: 'high' });
    const chip = chipOf(el._thinkingChipHTML());
    assert(chip !== null, 'a chip must render for a thinking model with a default level');
    assert(chip.classList.contains('thinking-chip') && chip.classList.contains('default'),
      `default level ⇒ hollow .default variant — got class "${chip.className}"`);
    assert(chip.textContent === 'high', `the model default is shown, got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('(default)'),
      `title marks the level as the default — got "${chip.getAttribute('title')}"`);
  });

  await run('no defaultThinkingLevel and no explicit level renders hollow def', () => {
    const el = makeSelector({ levels: ['low', 'high'] });
    const chip = chipOf(el._thinkingChipHTML());
    assert(chip !== null, 'a thinking-capable model must always render a chip');
    assert(chip.classList.contains('thinking-chip') && chip.classList.contains('default'),
      `undeclared default ⇒ hollow .default variant — got class "${chip.className}"`);
    assert(chip.textContent === 'def', `the fallback label is "def", got "${chip.textContent}"`);
    assert((chip.getAttribute('title') || '').includes('Thinking: default'),
      `title names the default selection — got "${chip.getAttribute('title')}"`);
  });

  await run('non-thinking model ⇒ no chip, even with a stale config level', () => {
    const el = makeSelector({ thinking: 'high' });
    assert(el._thinkingChipHTML() === '', 'a model without thinkingLevels must never grow a chip');
  });

  await run('a native level string is shown verbatim on the chip', () => {
    // codex-max advertises a native "xhigh" level: the chip shows it as-is.
    const el = makeSelector({ levels: ['high', 'xhigh'], thinking: 'xhigh' });
    const chip = chipOf(el._thinkingChipHTML());
    assert(chip !== null && !chip.classList.contains('default'), 'an explicit advertised level ⇒ solid chip');
    assert(chip.textContent === 'xhigh', `the native level is shown, got "${chip.textContent}"`);
  });

  await run('a stale explicit level the model no longer advertises falls back to the hollow default', () => {
    const el = makeSelector({ levels: ['low', 'high'], defaultLevel: 'high', thinking: 'medium' });
    const chip = chipOf(el._thinkingChipHTML());
    assert(chip !== null && chip.classList.contains('default'),
      'an unadvertised stored level means "default", so the chip goes hollow');
    assert(chip.textContent === 'high', `the fallback shows the model default, got "${chip.textContent}"`);
  });

  return { passed, failed, errors };
}
