//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model-selector cycling HUD behavior regressions.
 * @module unit-tests/model-selector-hud-test
 */

import { assert } from '../utilities/test-helpers.js';
import recentModels from '../../js/services/recent-models.js';
import '../../js/components/model-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

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
  el.refresh = async () => {};
  el._refreshProvidersInBackground = () => {};
  el._refreshUsageStats = async () => {};
  el.providers = [{
    name: 'p',
    displayName: 'Provider',
    available: true,
    modelsWithContext: [
      { id: 'm', displayName: 'Model', contextWindow: 1000, thinkingLevels: ['low', 'high'] },
      { id: 'other', displayName: 'Other', contextWindow: 1000 },
    ],
  }];
  document.body.appendChild(el);
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
    const el = makeSelector();
    try {
      el.provider = 'p';
      el.model = 'm';
      el._currentConfig = { provider: 'p', model: 'm', thinking: 'high' };
      const host = document.createElement('div');
      host.innerHTML = el._generateRecentSection();
      const rows = host.querySelectorAll('.recent-model');
      assert(rows.length === 3, `expected three Recent rows, got ${rows.length}`);
      assert(!rows[0].classList.contains('active'), 'same model at Default must not highlight');
      assert(rows[1].classList.contains('active'), 'the exact high-thinking pair must highlight');
      assert(!rows[2].classList.contains('active'), 'a different model must not highlight');
    } finally {
      el.remove();
    }
  });

  await run('Recent hides entries that are not selectable', async () => {
    await seedRecents([
      { provider: 'missing', model: 'ghost' },
      { provider: 'p', model: 'removed' },
      { provider: 'p', model: 'm' },
    ]);
    const el = makeSelector();
    try {
      const host = document.createElement('div');
      host.innerHTML = el._generateRecentSection();
      const rows = host.querySelectorAll('.recent-model');
      assert(rows.length === 1, `expected one selectable Recent row, got ${rows.length}`);
      assert(rows[0].getAttribute('data-provider') === 'p'
        && rows[0].getAttribute('data-model') === 'm',
      'Recent must contain only a model present on an available provider');
    } finally {
      el.remove();
    }
  });

  await run('synchronous model observers preserve the open HUD and anchor', async () => {
    const originalRAF = window.requestAnimationFrame;
    /** @type {FrameRequestCallback[]} */
    const frames = [];
    window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return frames.length;
    };

    const el = makeSelector();
    try {
      el.provider = 'p';
      el.model = 'm';
      el._currentConfig = { provider: 'p', model: 'm' };
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
      const present = frames.shift();
      assert(!!present, 'opening schedules popup presentation');
      present(0);

      const surface = el._menu?.surface;
      const anchor = el.querySelector('.model-selector-button');
      assert(!!surface, 'opening creates a live model popup');
      assert(!!anchor && anchor.isConnected, 'the popup anchor starts connected');
      assert(surface.parentElement === document.body, 'the live popup is hosted by document.body');

      assert(el.applyConfigPair({ provider: 'p', model: 'other' }), 'the next model applies');

      const surfaces = document.querySelectorAll('.provider-dropdown[data-model-selector="true"]');
      assert(surfaces.length === 1, `exactly one model popup remains, got ${surfaces.length}`);
      assert(surfaces[0] === surface && el._menu?.surface === surface,
        'the original live popup remains the presented surface');
      assert(anchor.isConnected && el.querySelector('.model-selector-button') === anchor,
        'the original popup anchor remains connected');
      assert(!el.querySelector('.provider-dropdown.show'), 'no duplicate inline popup is created');
      assert(!!surface.querySelector('.model-selection-item.active[data-model="other"]'),
        'the live popup highlights the newly selected model');
      assert(anchor.textContent.includes('Other'), 'the anchor label updates in place');
    } finally {
      el.close();
      el.remove();
      window.requestAnimationFrame = originalRAF;
    }
  });

  await run('stale deferred opens cannot create a duplicate model popup', async () => {
    const originalRAF = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    /** @type {Map<number, FrameRequestCallback>} */
    const frames = new Map();
    let nextFrame = 1;
    window.requestAnimationFrame = (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = () => {};

    const el = makeSelector();
    try {
      el.open();
      const staleOpen = frames.get(1);
      assert(!!staleOpen, 'first open scheduled presentation');
      el.close();
      el.open();
      const currentOpen = frames.get(2);
      assert(!!currentOpen, 'second open scheduled presentation');

      // Deliberately deliver the cancelled frame to simulate a callback already
      // queued by the browser, then deliver the current opening.
      staleOpen(0);
      currentOpen(0);

      const surfaces = document.querySelectorAll('.provider-dropdown[data-model-selector="true"]');
      assert(surfaces.length === 1, `exactly one model popup may exist, got ${surfaces.length}`);
      assert(el._menu?.surface === surfaces[0], 'the live surface belongs to the current opening');
      assert(!el.querySelector('.provider-dropdown.show'), 'no duplicate inline popup remains in the selector');
    } finally {
      el.close();
      el.remove();
      document.querySelectorAll('.provider-dropdown[data-model-selector="true"]').forEach(node => node.remove());
      window.requestAnimationFrame = originalRAF;
      window.cancelAnimationFrame = originalCancel;
    }
  });

  await run('hidden models are kept out of the model list', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.providers[0].modelsWithContext[1].hidden = true;
      el.provider = 'p';
      el.model = 'm';
      const host = document.createElement('div');
      host.innerHTML = el._generateModelListContent();
      const rows = [...host.querySelectorAll('.model-selection-item')]
        .map(r => (r.textContent || '').trim());
      assert(rows.some(t => t.includes('Model')), 'the visible model is still offered');
      assert(!rows.some(t => t.includes('Other')), 'the hidden model must not be offered');
    } finally {
      el.remove();
    }
  });

  await run('the model in use stays listed even when hidden, and says so', async () => {
    // Hiding the model a conversation is already on must not strip its label:
    // the picker would then read "No model" for something plainly running.
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.providers[0].modelsWithContext[0].hidden = true;
      el.provider = 'p';
      el.model = 'm';
      const host = document.createElement('div');
      host.innerHTML = el._generateModelListContent();
      const current = [...host.querySelectorAll('.model-selection-item')]
        .find(r => (r.textContent || '').includes('Model'));
      assert(!!current, 'the in-use model must still be listed');
      const note = current?.querySelector('.menu-item-note');
      assert((note?.textContent || '') === 'hidden', 'it is marked "hidden"');
    } finally {
      el.remove();
    }
  });

  await run('a provider whose every model is hidden drops out of the menu', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      for (const m of el.providers[0].modelsWithContext) m.hidden = true;
      el.provider = '';
      el.model = '';
      const host = document.createElement('div');
      host.innerHTML = el._generateModelListContent();
      assert(!host.querySelector('.provider-menu-header'),
        'a provider with nothing left to offer must not render a header');
    } finally {
      el.remove();
    }
  });

  return { passed, failed, errors };
}
