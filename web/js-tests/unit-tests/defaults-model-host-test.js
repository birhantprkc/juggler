//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings › Defaults model-row tests.
 *
 * The two rows are hosts for the same picker the composer uses, so the only
 * thing left to get wrong is the request they turn a choice into. Three rules
 * matter and none is visible on screen:
 *
 *   1. Both dials ride along on both routes — including `serviceTier` on the
 *      cheap model, which the row now offers. A dropped tier is money spent (or
 *      not spent) with nothing to say so.
 *   2. Absent means neutral: the default level and standard serving are missing
 *      keys, never empty strings, and "Automatic" is the empty pair.
 *   3. Clearing the cheap model to Automatic re-reads it, because the status
 *      line then has to name whatever the server derived.
 * @module unit-tests/defaults-model-host-test
 */

import { assert } from '../utilities/test-helpers.js';
import { DefaultsTab } from '../../js/components/settings/defaults-tab.js';
import { MODEL_PICKER_OFF } from '../../js/components/model-picker/model-picker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

const FAST = { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' };

/**
 * @returns {any[]} A provider offering one tiered, thinking-capable model.
 */
function providers() {
  return [{
    name: 'p',
    displayName: 'Provider',
    available: true,
    modelsWithContext: [
      {
        id: 'm',
        displayName: 'Model',
        contextWindow: 1000,
        thinkingLevels: ['low', 'high'],
        serviceTiers: [FAST],
      },
      { id: 'other', displayName: 'Other', contextWindow: 1000 },
    ],
  }];
}

/**
 * A recorded request.
 * @typedef {{url: string, method: string, body: any}} Call
 */

/**
 * Build a tab over a throwaway host, with `fetch` recorded rather than sent.
 * @param {object} [opts] - Scenario knobs.
 * @param {boolean} [opts.connect] - Append the host to `<body>`.
 * @returns {{tab: any, host: HTMLElement, calls: Call[], restore: () => void}} The harness.
 */
function makeTab({ connect } = {}) {
  const host = document.createElement('div');
  host.innerHTML = '<div id="default-model-field-container"></div><div id="cheap-model-field-container"></div>';
  if (connect) document.body.appendChild(host);

  /** @type {Call[]} */
  const calls = [];
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    return { ok: true, status: 200, json: async () => ({ explicit: false, autoResolved: { provider: 'p', model: 'other' } }) };
  });

  const tab = /** @type {any} */ (new DefaultsTab(host));
  tab.providers = providers();
  return {
    tab,
    host,
    calls,
    restore: () => {
      window.fetch = originalFetch;
      host.remove();
    },
  };
}

/**
 * The last recorded request for a path.
 * @param {Call[]} calls
 * @param {string} path
 * @returns {Call|undefined} The most recent matching call.
 */
function lastCall(calls, path) {
  return [...calls].reverse().find(c => c.url === path);
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

  await run('the default-model row PUTs the whole config, dials included', async () => {
    const h = makeTab();
    try {
      await h.tab._saveDefaultModel({ provider: 'p', model: 'm', thinking: 'high', serviceTier: 'priority' });
      const call = lastCall(h.calls, '/api/default-model');
      assert(!!call && call.method === 'PUT', 'a choice is persisted immediately');
      assert(call.body.provider === 'p' && call.body.model === 'm',
        `the pair is named in full, got ${JSON.stringify(call.body)}`);
      assert(call.body.thinking === 'high' && call.body.serviceTier === 'priority',
        `both dials must reach the server, got ${JSON.stringify(call.body)}`);
    } finally {
      h.restore();
    }
  });

  await run('the cheap-model row PUTs the serving tier too', async () => {
    const h = makeTab();
    try {
      await h.tab._saveCheapModel({ provider: 'p', model: 'm', thinking: 'low', serviceTier: 'priority' });
      const call = lastCall(h.calls, '/api/cheap-model');
      assert(!!call && call.method === 'PUT', 'a choice is persisted immediately');
      assert(call.body.serviceTier === 'priority',
        `the cheap row offers speed, so it must send it — got ${JSON.stringify(call.body)}`);
      assert(call.body.thinking === 'low', `the level rides along too, got ${JSON.stringify(call.body)}`);
    } finally {
      h.restore();
    }
  });

  await run('unset dials are absent keys, not empty strings', async () => {
    const h = makeTab();
    try {
      await h.tab._saveDefaultModel({ provider: 'p', model: 'other' });
      const body = lastCall(h.calls, '/api/default-model').body;
      assert(!('thinking' in body) && !('serviceTier' in body),
        `the model's default level and standard serving are the absence of a key — got ${JSON.stringify(body)}`);
    } finally {
      h.restore();
    }
  });

  await run('Automatic clears the stored value on both routes', async () => {
    const h = makeTab();
    try {
      await h.tab._saveDefaultModel(null);
      const def = lastCall(h.calls, '/api/default-model').body;
      assert(def.provider === '' && def.model === '',
        `Automatic is the empty pair, got ${JSON.stringify(def)}`);
      assert(h.tab.defaultModel.explicit === false, 'the row falls back to its automatic state');

      await h.tab._saveCheapModel(null);
      const put = h.calls.find(c => c.url === '/api/cheap-model' && c.method === 'PUT');
      assert(!!put && put.body.provider === '' && put.body.model === '',
        `Automatic is the empty pair, got ${JSON.stringify(put?.body)}`);
      const reread = h.calls.filter(c => c.url === '/api/cheap-model' && c.method === 'GET');
      assert(reread.length === 1,
        'clearing re-reads the row, because only the server knows what it derived');
    } finally {
      h.restore();
    }
  });

  await run('the row shows the pinned model, and "Automatic" when there is none', () => {
    const h = makeTab();
    try {
      h.tab.defaultModel = { provider: 'p', model: 'm', explicit: true };
      h.tab.renderDefaultModelField();
      const label = h.host.querySelector('#default-model-field-container .model-name');
      assert((label?.textContent || '') === 'Model',
        `the chip names the pinned model, got "${label?.textContent}"`);

      h.tab.cheapModel = { explicit: false };
      h.tab.renderCheapModelField();
      const auto = h.host.querySelector('#cheap-model-field-container .model-name');
      assert((auto?.textContent || '') === 'Automatic',
        `no pin reads as Automatic, got "${auto?.textContent}"`);
    } finally {
      h.restore();
    }
  });

  await run('choosing in the picker persists through the row', async () => {
    // A lane runs several tests in one realm; start from a clean <body> so a
    // picker another test left behind can't be mistaken for this one's.
    document.querySelectorAll('.model-picker').forEach(node => node.remove());
    const h = makeTab({ connect: true });
    try {
      h.tab.cheapModel = { explicit: false };
      h.tab.renderCheapModelField();
      const chip = /** @type {any} */ (h.host.querySelector('#cheap-model-field-container model-chip'));
      chip.button.click();

      const picker = /** @type {any} */ (document.querySelector('.model-picker'));
      assert(!!picker, 'pressing the chip opens the shared picker');
      assert(picker.noneLabel === 'Automatic', 'the settings rows label the none row "Automatic"');

      const row = picker.querySelector('.menu-item[data-model="m"]');
      assert(!!row, 'the picker lists the provider\'s models');
      row.click();
      // The save is async; let the recorded PUT land.
      await new Promise(resolve => setTimeout(resolve, 0));

      const call = lastCall(h.calls, '/api/cheap-model');
      assert(!!call && call.method === 'PUT' && call.body.model === 'm',
        `the picker's choice reaches the server, got ${JSON.stringify(call)}`);
      assert(!document.querySelector('.model-picker'), 'choosing dismisses the picker');
    } finally {
      h.restore();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  await run('Off is a third choice, distinct from Automatic, and it persists', async () => {
    const h = makeTab();
    try {
      await h.tab._saveCheapModel(MODEL_PICKER_OFF);
      const call = lastCall(h.calls, '/api/cheap-model');
      assert(!!call && call.method === 'PUT', 'turning it off is persisted immediately');
      assert(call.body.disabled === true,
        `Off has to be recorded as itself — an empty pair would read back as Automatic. Got ${JSON.stringify(call.body)}`);
      assert(h.tab.cheapModel.disabled === true, 'the row holds the off state it just saved');
      const reread = h.calls.filter(c => c.url === '/api/cheap-model' && c.method === 'GET');
      assert(reread.length === 0,
        'there is nothing for the server to derive when the answer is "none", so no re-read');
    } finally {
      h.restore();
    }
  });

  await run('the cheap row says which of its three states it is in', () => {
    const h = makeTab();
    try {
      const off = h.tab._cheapModelStatusText({ explicit: false, disabled: true });
      assert(off === 'Off — background tasks won\'t run.', `off says so, got "${off}"`);
      const derived = h.tab._cheapModelStatusText({
        explicit: false,
        autoResolved: { provider: 'p', model: 'm' },
      });
      assert(derived === 'Auto — currently Model.', `a derived model is named, got "${derived}"`);
      // The one that was wrong: with nothing derivable the row used to claim a
      // model had been derived from the one in use, which is how a provider with
      // no cheap tier stayed invisible.
      const none = h.tab._cheapModelStatusText({ explicit: false });
      assert(none === 'Auto — nothing available for this provider.',
        `with nothing resolved the row must say so, got "${none}"`);
    } finally {
      h.restore();
    }
  });

  await run('the default row offers no Off — a conversation must run on something', async () => {
    document.querySelectorAll('.model-picker').forEach(node => node.remove());
    const h = makeTab({ connect: true });
    try {
      h.tab.defaultModel = { provider: 'p', model: 'm', explicit: true };
      h.tab.renderDefaultModelField();
      const chip = /** @type {any} */ (h.host.querySelector('#default-model-field-container model-chip'));
      chip.button.click();

      const picker = /** @type {any} */ (document.querySelector('.model-picker'));
      assert(!!picker, 'pressing the chip opens the shared picker');
      assert(!picker.querySelector('[data-off]'),
        'the Off row is opt-in, and the default row must not opt in — there is no "no default model"');
      // Close through the picker rather than by removing the node, so the popup
      // manager forgets it; a lingering registration makes the NEXT open a
      // dismiss, and the test after this one gets no picker at all.
      picker.querySelector('[data-none]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      h.restore();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  await run('picking Off on the cheap row reaches the server as Off', async () => {
    document.querySelectorAll('.model-picker').forEach(node => node.remove());
    const h = makeTab({ connect: true });
    try {
      h.tab.cheapModel = { explicit: false };
      h.tab.renderCheapModelField();
      const chip = /** @type {any} */ (h.host.querySelector('#cheap-model-field-container model-chip'));
      chip.button.click();

      const picker = /** @type {any} */ (document.querySelector('.model-picker'));
      assert(!!picker, 'pressing the chip opens the shared picker');
      const off = picker.querySelector('[data-off]');
      assert(!!off, 'the cheap row offers Off');
      assert(off.textContent.includes('Off'), `the row is labelled, got "${off.textContent.trim()}"`);
      assert(!!picker.querySelector('[data-none]'),
        'Off is an ADDITION — Automatic must still be reachable, or the choice is one-way');

      off.click();
      await new Promise(resolve => setTimeout(resolve, 0));

      const call = lastCall(h.calls, '/api/cheap-model');
      assert(!!call && call.body.disabled === true,
        `the Off row must not collapse into Automatic on the way out, got ${JSON.stringify(call?.body)}`);
      assert(!document.querySelector('.model-picker'), 'choosing dismisses the picker');
    } finally {
      h.restore();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  await run('the chip reads Off, so the state is visible without opening anything', () => {
    const h = makeTab();
    try {
      h.tab.cheapModel = { explicit: false, disabled: true };
      h.tab.renderCheapModelField();
      const label = h.host.querySelector('#cheap-model-field-container .model-name');
      assert((label?.textContent || '') === 'Off',
        `an off row must not look identical to an automatic one, got "${label?.textContent}"`);
    } finally {
      h.restore();
    }
  });

  await run('the chip\'s thinking popover opens over the settings panel, not under it', () => {
    document.querySelectorAll('.thinking-mini, .model-picker').forEach(node => node.remove());
    const h = makeTab({ connect: true });
    /** @type {any} */
    let chip = null;
    try {
      h.tab.cheapModel = { provider: 'p', model: 'm', explicit: true };
      h.tab.renderCheapModelField();
      chip = /** @type {any} */ (h.host.querySelector('#cheap-model-field-container model-chip'));
      const pill = /** @type {HTMLElement|null} */ (chip.querySelector('.thinking-chip'));
      assert(!!pill, 'a thinking-capable model wears the pill that opens the popover');

      pill.click();
      const mini = document.querySelector('.thinking-mini');
      assert(!!mini, 'pressing the pill opens the thinking popover');
      // Settings is a modal: a popover on the ordinary dropdown layer is behind
      // the panel that opened it, which reads as "the pill does nothing".
      const layer = Number(getComputedStyle(/** @type {Element} */ (mini)).zIndex);
      const modal = Number(getComputedStyle(document.documentElement).getPropertyValue('--z-modal'));
      assert(layer >= modal,
        `the settings panel sits at ${modal}, so the popover must not be below it — got ${layer}`);
    } finally {
      chip?.closeMini();
      h.restore();
      document.querySelectorAll('.thinking-mini').forEach(node => node.remove());
    }
  });

  return { passed, failed, errors };
}
