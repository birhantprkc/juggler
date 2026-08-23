//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model-chip serving-tier pill render-rule unit tests.
 *
 * `ModelChip.serviceTierChipHTML` is the only on-screen evidence that a
 * conversation is being served at a premium tier, so two rules matter and
 * neither is visible by inspection:
 *
 *   1. It renders ONLY for an explicit tier the model still advertises. Standard
 *      serving is the absence of a tier, so there is no hollow "inherited"
 *      variant — the button must be byte-identical for every model and every
 *      turn that isn't buying one.
 *   2. The label is the provider's own name for the tier, verbatim. Tier ids and
 *      labels come from the catalog, so nothing may assume a tier means "fast".
 *
 * Tested on a real (registered) `<model-chip>` created via
 * `document.createElement` but never appended, with `providers` and `config`
 * set directly — the chip is controlled, so that is its whole input.
 * @module unit-tests/service-tier-chip-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/model-picker/model-chip.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

const FAST = { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' };

/**
 * Build a detached model-chip with one provider/model set on it.
 * @param {object} opts - Scenario knobs.
 * @param {Array<{id: string, name?: string, description?: string}>} [opts.tiers] - Tiers the model advertises (omit for a standard-only model).
 * @param {string[]} [opts.levels] - `thinkingLevels` the model advertises.
 * @param {string} [opts.serviceTier] - Explicit tier in the current config.
 * @returns {any} The (never-connected) chip element.
 */
function makeChip({ tiers, levels, serviceTier }) {
  const el = /** @type {any} */ (document.createElement('model-chip'));
  /** @type {any} */
  const modelEntry = { id: 'model-x', contextWindow: 200000 };
  if (tiers) modelEntry.serviceTiers = tiers;
  if (levels) modelEntry.thinkingLevels = levels;
  /** @type {any} */
  const cfg = { provider: 'prov', model: 'model-x' };
  if (serviceTier) cfg.serviceTier = serviceTier;
  el.update({
    providers: [{ name: 'prov', displayName: 'Prov', available: true, modelsWithContext: [modelEntry] }],
    config: cfg,
  });
  return el;
}

/**
 * Parse chip HTML into an element for class/text assertions.
 * @param {string} html - The `serviceTierChipHTML()` return value.
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

  await run('an explicit advertised tier renders a chip under the provider\'s own name', () => {
    const el = makeChip({ tiers: [FAST], serviceTier: 'priority' });
    const chip = chipOf(el.serviceTierChipHTML());
    assert(chip !== null, 'a bought tier must be visible on the button');
    assert(chip.classList.contains('service-tier-chip'), `got class "${chip.className}"`);
    assert(chip.textContent === 'Fast',
      `the provider's label is shown verbatim ("Fast"), got "${chip.textContent}"`);
  });

  await run('the chip title carries the tier description it is sold with', () => {
    const el = makeChip({ tiers: [FAST], serviceTier: 'priority' });
    const chip = chipOf(el.serviceTierChipHTML());
    const title = chip.getAttribute('title') || '';
    assert(title.includes('Fast'), `title names the tier — got "${title}"`);
    assert(title.includes('1.5x speed, increased usage'),
      `title carries the provider's blurb — got "${title}"`);
  });

  await run('standard serving ⇒ no chip, so the button never grows for it', () => {
    const el = makeChip({ tiers: [FAST] });
    assert(el.serviceTierChipHTML() === '',
      'no tier in the config means standard serving, which has no chip of its own');
  });

  await run('a stale tier the model no longer advertises ⇒ no chip', () => {
    const el = makeChip({ tiers: [FAST], serviceTier: 'flex' });
    assert(el.serviceTierChipHTML() === '',
      'an unadvertised stored tier is dropped from the request, so it must not be shown as active');
  });

  await run('a model advertising no tiers ⇒ no chip, even with a stale config tier', () => {
    const el = makeChip({ serviceTier: 'priority' });
    assert(el.serviceTierChipHTML() === '',
      'a standard-only model must never grow a chip');
  });

  await run('a tier with no provider label falls back to its id', () => {
    const el = makeChip({ tiers: [{ id: 'flex' }], serviceTier: 'flex' });
    const chip = chipOf(el.serviceTierChipHTML());
    assert(chip !== null && chip.textContent === 'flex',
      `an unlabelled tier shows its id, got "${chip ? chip.textContent : null}"`);
  });

  await run('the chip reaches the collapsed button, alongside the thinking chip', () => {
    const el = makeChip({ tiers: [FAST], levels: ['low', 'high'], serviceTier: 'priority' });
    const html = el._contentHTML({ modelDisplay: 'Model X', hasOverride: false });
    assert(html.includes('service-tier-chip'), 'the button markup must carry the tier chip');
    assert(html.includes('thinking-chip'), 'the thinking chip must survive alongside it');
    assert(html.indexOf('thinking-chip') < html.indexOf('service-tier-chip'),
      'the tier chip follows the thinking chip');
  });

  await run('the button is unchanged for a model with no tier bought', () => {
    const withTiers = makeChip({ tiers: [FAST], levels: ['low', 'high'] });
    const standardOnly = makeChip({ levels: ['low', 'high'] });
    const state = { modelDisplay: 'Model X', hasOverride: false };
    assert(withTiers._contentHTML(state) === standardOnly._contentHTML(state),
      'offering a tier must not itself alter the button — only buying one does');
  });

  return { passed, failed, errors };
}
