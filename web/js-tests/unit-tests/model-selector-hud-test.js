//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model-selector cycling HUD behavior regressions, plus the list rules the HUD
 * is a view of. The rows live in `<model-picker>`; the freeze/refresh mechanics
 * live in the `<model-selector>` host that presents it.
 * @module unit-tests/model-selector-hud-test
 */

import { assert } from '../utilities/test-helpers.js';
import recentModels from '../../js/services/recent-models.js';
import '../../js/components/model-selector.js';
import '../../js/components/model-picker/model-picker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

/**
 * The provider list both the selector and the standalone pickers are given.
 * @returns {any[]} A fresh provider list.
 */
const PROVIDERS = () => [{
  name: 'p',
  displayName: 'Provider',
  available: true,
  modelsWithContext: [
    { id: 'm', displayName: 'Model', contextWindow: 1000, thinkingLevels: ['low', 'high'] },
    { id: 'other', displayName: 'Other', contextWindow: 1000 },
  ],
}];

/**
 * Seed the recent-model cache without depending on the server.
 * @param {any[]} models
 * @returns {Promise<void>}
 */
async function seedRecents(models) {
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ models }) }));
  try {
    await recentModels.refresh();
  } finally {
    window.fetch = originalFetch;
  }
}

/**
 * Create a connected selector with network/background refresh work disabled.
 * @returns {any} Connected model selector.
 */
function makeSelector() {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  el.fetchProviders = async () => {};
  el._refreshProvidersInBackground = () => {};
  el.providers = PROVIDERS();
  document.body.appendChild(el);
  return el;
}

/**
 * Build a detached, rendered `<model-picker>` — the same element the selector
 * presents, driven directly so the list rules can be asserted without a popup.
 * @param {object} opts - Scenario knobs.
 * @param {any[]} [opts.providers] - Provider list; defaults to the shared one.
 * @param {any} [opts.value] - The config in effect.
 * @param {string} [opts.noneLabel] - Label for the bottom row.
 * @returns {any} The rendered picker.
 */
function makePicker({ providers, value, noneLabel } = {}) {
  const el = /** @type {any} */ (document.createElement('model-picker'));
  el.providers = providers || PROVIDERS();
  el.value = value || null;
  if (noneLabel) el.noneLabel = noneLabel;
  el.render();
  return el;
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
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

  await run('Recent highlights the exact current model-and-thinking pair', async () => {
    await seedRecents([
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', thinking: 'high' },
      { provider: 'p', model: 'other' },
    ]);
    const picker = makePicker({ value: { provider: 'p', model: 'm', thinking: 'high' } });
    const rows = picker.querySelectorAll('.recent-model');
    assert(rows.length === 3, `expected three Recent rows, got ${rows.length}`);
    assert(!rows[0].classList.contains('active'), 'same model at Default must not highlight');
    assert(rows[1].classList.contains('active'), 'the exact high-thinking pair must highlight');
    assert(!rows[2].classList.contains('active'), 'a different model must not highlight');
  });

  await run('Recent hides entries that are not selectable', async () => {
    await seedRecents([
      { provider: 'missing', model: 'ghost' },
      { provider: 'p', model: 'removed' },
      { provider: 'p', model: 'm' },
    ]);
    const picker = makePicker();
    const rows = picker.querySelectorAll('.recent-model');
    assert(rows.length === 1, `expected one selectable Recent row, got ${rows.length}`);
    assert(rows[0].getAttribute('data-provider') === 'p'
      && rows[0].getAttribute('data-model') === 'm',
    'Recent must contain only a model present on an available provider');
  });

  await run('synchronous model observers preserve the open HUD and anchor', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el._currentConfig = { provider: 'p', model: 'm' };
      el.provider = 'p';
      el.model = 'm';
      const thread = {
        _modelConfig: el._currentConfig,
        get modelConfig() { return this._modelConfig; },
        set modelConfig(next) {
          this._modelConfig = next;
          // Reproduce the real reactive delivery: the model-config observer
          // synchronously re-syncs the selector during applyConfigPair's write.
          el._syncModelDisplay();
        },
      };
      el._messageThread = thread;
      el.render();
      el.open();

      const surface = el._picker;
      const anchor = el.querySelector('.model-selector-button');
      assert(!!surface, 'opening creates a live model picker');
      assert(!!anchor && anchor.isConnected, 'the picker anchor starts connected');
      assert(surface.parentElement === document.body, 'the live picker is hosted by document.body');

      assert(el.applyConfigPair({ provider: 'p', model: 'other' }), 'the next model applies');

      const surfaces = document.querySelectorAll('.model-picker');
      assert(surfaces.length === 1, `exactly one model picker remains, got ${surfaces.length}`);
      assert(surfaces[0] === surface && el._picker === surface,
        'the original live picker remains the presented surface');
      assert(anchor.isConnected && el.querySelector('.model-selector-button') === anchor,
        'the original anchor remains connected');
      assert(!el.querySelector('.model-picker'), 'no duplicate picker is left inside the selector');
      assert(!!surface.querySelector('.model-selection-item.active[data-model="other"]'),
        'the live picker highlights the newly selected model');
      assert(anchor.textContent.includes('Other'), 'the anchor label updates in place');
    } finally {
      el.close();
      el.remove();
    }
  });

  await run('reopening never leaves a second picker behind', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.open();
      el.close();
      el.open();
      const surfaces = document.querySelectorAll('.model-picker');
      assert(surfaces.length === 1, `exactly one model picker may exist, got ${surfaces.length}`);
      assert(el._picker === surfaces[0], 'the live surface belongs to the current opening');
    } finally {
      el.close();
      el.remove();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  await run('hidden models are kept out of the model list', async () => {
    await seedRecents([]);
    const providers = PROVIDERS();
    providers[0].modelsWithContext[1].hidden = true;
    const picker = makePicker({ providers, value: { provider: 'p', model: 'm' } });
    const rows = [...picker.querySelectorAll('.model-selection-item')]
      .map(r => (r.textContent || '').trim());
    assert(rows.some(t => t.includes('Model')), 'the visible model is still offered');
    assert(!rows.some(t => t.includes('Other')), 'the hidden model must not be offered');
  });

  await run('the model in use stays listed even when hidden, and says so', async () => {
    // Hiding the model a conversation is already on must not strip its label:
    // the picker would then read "No model" for something plainly running.
    await seedRecents([]);
    const providers = PROVIDERS();
    providers[0].modelsWithContext[0].hidden = true;
    const picker = makePicker({ providers, value: { provider: 'p', model: 'm' } });
    const current = [...picker.querySelectorAll('.model-selection-item')]
      .find(r => (r.textContent || '').includes('Model'));
    assert(!!current, 'the in-use model must still be listed');
    const note = current?.querySelector('.menu-item-note');
    assert((note?.textContent || '') === 'hidden', 'it is marked "hidden"');
  });

  await run('a provider whose every model is hidden drops out of the menu', async () => {
    await seedRecents([]);
    const providers = PROVIDERS();
    for (const m of providers[0].modelsWithContext) m.hidden = true;
    const picker = makePicker({ providers });
    assert(!picker.querySelector('.provider-menu-header'),
      'a provider with nothing left to offer must not render a header');
  });

  return { passed, failed, errors };
}
