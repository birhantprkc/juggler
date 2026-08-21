//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Serving-tier ("Speed") control unit tests for the model selector.
 *
 * Two properties matter here and neither is visible by inspection:
 *
 *   1. The control renders only for a model that advertises `serviceTiers`,
 *      shows the provider's own labels, and treats standard serving as the
 *      ABSENCE of a tier rather than an empty-string one.
 *   2. The two per-model dials share one `modelConfig` object, and every write
 *      path rebuilds that object from scratch. So setting the thinking level
 *      must preserve `serviceTier` and setting the tier must preserve
 *      `thinking` — a regression here silently reverts a choice the user is
 *      paying a premium for, with nothing on screen to show it happened.
 *
 * Tested on a real (registered) model-selector created via
 * `document.createElement` but never appended — connectedCallback never runs,
 * so no network fetch, render, or WebSocket subscription happens — following
 * the stubbed-instance pattern of the other component unit tests.
 * @module unit-tests/service-tier-control-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/model-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

const FAST = { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' };

/**
 * Build a detached model-selector with one provider/model stubbed in, plus a
 * capture of whatever config the write path produces.
 * @param {object} opts - Scenario knobs.
 * @param {Array<{id: string, name?: string, description?: string}>} [opts.tiers] - Tiers the model advertises.
 * @param {string[]} [opts.levels] - `thinkingLevels` the model advertises.
 * @param {string} [opts.thinking] - Explicit level in the current config.
 * @param {string} [opts.serviceTier] - Explicit tier in the current config.
 * @returns {any} The stubbed (never-connected) element; `written` holds the last write.
 */
function makeSelector({ tiers, levels, thinking, serviceTier }) {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  /** @type {any} */
  const modelEntry = { id: 'model-x', contextWindow: 200000 };
  if (tiers) modelEntry.serviceTiers = tiers;
  if (levels) modelEntry.thinkingLevels = levels;
  el.providers = [{ name: 'prov', displayName: 'Prov', available: true, modelsWithContext: [modelEntry] }];
  el.provider = 'prov';
  el.model = 'model-x';
  /** @type {any} */
  const cfg = { provider: 'prov', model: 'model-x' };
  if (thinking) cfg.thinking = thinking;
  if (serviceTier) cfg.serviceTier = serviceTier;
  el._currentConfig = cfg;
  // Capture the write instead of touching a Yjs doc; mirrors what the real
  // `_writeOrDefer` hands to the thread/conversation.
  el.written = null;
  el._writeOrDefer = (/** @type {any} */ next) => { el.written = next; return true; };
  return el;
}

/**
 * Parse control HTML into a container for querying.
 * @param {string} html - The `_generateServiceTierControl()` return value.
 * @returns {Element|null} The control's root element, or null for empty HTML.
 */
function controlOf(html) {
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

  await run('a model with no serviceTiers renders no speed control', () => {
    const el = makeSelector({ levels: ['low', 'high'] });
    const html = el._generateServiceTierControl({ provider: 'prov', model: 'model-x' }, el.providers[0].modelsWithContext[0]);
    assert(html === '', 'a standard-only model must not grow a speed control');
  });

  await run('an advertised tier renders Standard plus the provider label and blurb', () => {
    const el = makeSelector({ tiers: [FAST] });
    const root = controlOf(el._generateServiceTierControl(
      { provider: 'prov', model: 'model-x' }, el.providers[0].modelsWithContext[0]));
    assert(root !== null, 'an advertising model must render the control');
    const segs = [...root.querySelectorAll('.tier-seg')];
    assert(segs.length === 2, `Standard + one tier = 2 segments, got ${segs.length}`);
    assert(segs[0].getAttribute('data-service-tier') === '',
      'standard serving is the empty tier id, never a named one');
    assert(segs[0].textContent === 'Standard', `first segment reads "Standard", got "${segs[0].textContent}"`);
    assert(segs[1].getAttribute('data-service-tier') === 'priority',
      `the wire id is the identity, got "${segs[1].getAttribute('data-service-tier')}"`);
    assert(segs[1].textContent === 'Fast',
      `the provider's own label is shown, not the id — got "${segs[1].textContent}"`);
    assert(segs[1].getAttribute('title') === '1.5x speed, increased usage',
      `the provider's blurb is the title — got "${segs[1].getAttribute('title')}"`);
  });

  await run('standard is active when no tier is chosen', () => {
    const el = makeSelector({ tiers: [FAST] });
    const root = controlOf(el._generateServiceTierControl(
      { provider: 'prov', model: 'model-x' }, el.providers[0].modelsWithContext[0]));
    const segs = [...root.querySelectorAll('.tier-seg')];
    assert(segs[0].classList.contains('active'), 'absent tier ⇒ Standard is the active segment');
    assert(segs[0].getAttribute('aria-checked') === 'true', 'the active segment reports aria-checked');
    assert(!segs[1].classList.contains('active'), 'the paid tier must not look selected by default');
  });

  await run('a stale tier the model no longer advertises falls back to Standard', () => {
    const el = makeSelector({ tiers: [FAST] });
    const root = controlOf(el._generateServiceTierControl(
      { provider: 'prov', model: 'model-x', serviceTier: 'flex' }, el.providers[0].modelsWithContext[0]));
    const segs = [...root.querySelectorAll('.tier-seg')];
    assert(segs[0].classList.contains('active'),
      'an unadvertised stored tier means standard serving, not a phantom selection');
  });

  await run('applyServiceTier writes the id and omits it for Standard', () => {
    const el = makeSelector({ tiers: [FAST] });
    assert(el.applyServiceTier('priority') === true, 'the write must report success');
    assert(el.written.serviceTier === 'priority', `wrote "${el.written.serviceTier}", want "priority"`);

    assert(el.applyServiceTier('') === true, 'clearing back to Standard must report success');
    assert(!('serviceTier' in el.written),
      'Standard deletes the key — an empty-string tier would be stored and re-read as a choice');
  });

  await run('setting a thinking level preserves the serving tier', () => {
    const el = makeSelector({ tiers: [FAST], levels: ['low', 'high'], serviceTier: 'priority' });
    assert(el.applyThinkingLevel('high') === true, 'the write must report success');
    assert(el.written.thinking === 'high', `thinking = "${el.written.thinking}", want "high"`);
    assert(el.written.serviceTier === 'priority',
      'a thinking change must not silently revert the tier the user is paying for');
  });

  await run('setting a serving tier preserves the thinking level', () => {
    const el = makeSelector({ tiers: [FAST], levels: ['low', 'high'], thinking: 'high' });
    assert(el.applyServiceTier('priority') === true, 'the write must report success');
    assert(el.written.serviceTier === 'priority', `tier = "${el.written.serviceTier}", want "priority"`);
    assert(el.written.thinking === 'high', 'a tier change must not silently reset the thinking level');
  });

  await run('clearing one dial leaves the other intact', () => {
    const el = makeSelector({ tiers: [FAST], levels: ['low', 'high'], thinking: 'high', serviceTier: 'priority' });
    el.applyThinkingLevel('');
    assert(!('thinking' in el.written), 'Default deletes the thinking key');
    assert(el.written.serviceTier === 'priority', 'clearing the level must not clear the tier');
  });

  await run('currentConfigPair reports both dials, normalising unadvertised values away', () => {
    const el = makeSelector({ tiers: [FAST], levels: ['low', 'high'], thinking: 'high', serviceTier: 'priority' });
    const pair = el.currentConfigPair();
    assert(pair.thinking === 'high' && pair.serviceTier === 'priority',
      `both dials must survive, got ${JSON.stringify(pair)}`);

    const stale = makeSelector({ tiers: [FAST], levels: ['low', 'high'], thinking: 'medium', serviceTier: 'flex' });
    const stalePair = stale.currentConfigPair();
    assert(!('thinking' in stalePair) && !('serviceTier' in stalePair),
      `unadvertised values normalise away, got ${JSON.stringify(stalePair)}`);
  });

  await run('supportedServiceTiers lists advertised ids in order, empty when none', () => {
    const el = makeSelector({ tiers: [{ id: 'flex', name: 'Flex' }, FAST] });
    const ids = el.supportedServiceTiers();
    assert(ids.length === 2 && ids[0] === 'flex' && ids[1] === 'priority',
      `advertised order is the provider's decision, got ${JSON.stringify(ids)}`);
    assert(makeSelector({ levels: ['low'] }).supportedServiceTiers().length === 0,
      'a standard-only model advertises no tiers');
  });

  return { passed, failed, errors };
}
