//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the cache-bust baseline is a claim ABOUT, and when it is allowed to move.
 *
 * The composer's caution diffs the outgoing prefix against a baseline standing
 * for "what the provider has cached". Two things decide whether that baseline
 * tells the truth, and a sub-thread breaks both if they are got wrong:
 *
 *   • Its model is the model that SENT the transcript — read from the anchored
 *     turn's transaction blob. A sub-thread with no override inherits its model,
 *     so a switch made anywhere else moves the live selection under it; heading
 *     the baseline with that selection let an unrelated switch rewrite what the
 *     thread believed it had cached, and returning to the model that genuinely
 *     ran then read as a bust.
 *   • It must still be able to move after a turn. Sub-thread columns are rebuilt
 *     from a fresh MessageThread wrapper on every doc update, so the wrapper the
 *     refresh started with is routinely replaced mid-await by one describing the
 *     same thread. Treating that as "the thread swapped under us" dropped every
 *     rebaseline, freezing the baseline and pinning the caution on for good.
 * @module unit-tests/cache-baseline-anchor-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import workerManager from '../../js/services/worker-manager.js';
import '../../js/components/strategy-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * A history item stub with a given content length, so the classifier's magnitude
 * gate has something to weigh.
 * @param {string} id - Item id
 * @param {number} len - Content length in chars
 * @returns {{get: (k: string) => any}} A Y.Map-like item stub
 */
function sized(id, len) {
  /** @type {Record<string, any>} */
  const fields = { itemId: id, type: 'user', content: 'x'.repeat(len) };
  return { get: (/** @type {string} */ k) => fields[k] };
}

/**
 * The transcript the selector diffs: a long one, anchored at a large token
 * count, so any divergence at the head clears the 25k warning floor. The final
 * assistant item carries the transactionId the anchor is read from.
 * @returns {Array<{get: (k: string) => any}>} History items
 */
function longTranscript() {
  const items = Array.from({ length: 10 }, (_, i) => sized(`m${i}`, 400));
  /** @type {Record<string, any>} */
  const assistantFields = {
    itemId: 'a1', type: 'assistant', content: 'x'.repeat(400), transactionId: 'txn_1'
  };
  items.push({ get: (/** @type {string} */ k) => assistantFields[k] });
  return items;
}

/**
 * A stand-in for the world a sub-thread column's selector binds to: one shared
 * conversation and one shared items Y.Array (both stable across wrapper
 * rebuilds, as in production), plus a factory for the per-doc-update wrapper.
 * @param {{model: string}} live - The effective model config, mutable by the test
 * @returns {{conversation: any, notifyMetadata: (key: string) => void, newWrapper: () => any}} The harness
 */
function threadWorld(live) {
  /** @type {Array<(event: {keysChanged: Set<string>}) => void>} */
  const metadataObservers = [];
  const items = longTranscript();
  // Shared identities: conversation-tab mints a new MessageThread per doc update
  // over the SAME container and array, which is exactly why the selector must
  // not key "did the thread swap" on the wrapper object.
  const yarray = { observeDeep() {}, unobserveDeep() {} };
  const container = { observe() {}, unobserve() {} };
  const conversation = {
    id: 'conv_cache_baseline',
    processingState: { status: 'idle' },
    observeMetadata: (/** @type {any} */ fn) => metadataObservers.push(fn),
    unobserveMetadata: (/** @type {any} */ fn) => {
      const i = metadataObservers.indexOf(fn);
      if (i >= 0) metadataObservers.splice(i, 1);
    }
  };
  return {
    conversation,
    notifyMetadata: (/** @type {string} */ key) => {
      for (const fn of [...metadataObservers]) fn({ keysChanged: new Set([key]) });
    },
    newWrapper: () => ({
      threadItemId: 'thread_plan',
      conversation,
      container,
      yarray,
      items,
      contextItems: [],
      currentStrategyId: 'default',
      isDelegated: false,
      getEffectiveModelConfig: () => ({ provider: 'anthropic', model: live.model })
    })
  };
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
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

  if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

  // The selector reaches the blob through a dynamic import of this same module
  // singleton, so stubbing the method here is what it will call. Restored to the
  // exact shape it had (own property or inherited) once both cases have run.
  const hadOwnGetTransaction = Object.prototype.hasOwnProperty.call(workerManager, 'getTransaction');
  const realGetTransaction = workerManager.getTransaction;

  await run('the baseline is headed by the model that ran, not the model now selected', async () => {
    // The reported workflow: the planning model ran this sub-thread, the user
    // switched the CONVERSATION back to the implementation model for the work
    // that followed, and the sub-thread — which holds no override — inherited
    // that switch without ever sending under it.
    const live = { model: 'implementation' };
    const world = threadWorld(live);
    /** @type {any} */ (workerManager).getTransaction = async () => ({
      inputTokens: 100000,
      modelConfig: { provider: 'anthropic', model: 'planning' }
    });

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);
    try {
      selector.setMessageThread(world.newWrapper());
      await waitFor(() => selector._baseline !== null,
        { intervalMs: 0, description: 'the first idle baseline' });

      // Cached under planning, about to send under implementation: a real bust,
      // and the caution must say so even though this column never saw the switch.
      assert(selector._pendingImpact === 'busts-large',
        `sending under an inherited switch busts the prefix the anchored turn cached, got ${selector._pendingImpact}`);

      // Back to the model that actually built the cached prefix. Nothing is lost
      // by sending now — this is the case that used to warn, because the baseline
      // had silently absorbed a model that never ran here.
      live.model = 'planning';
      selector._recomputeImpact();
      assert(selector._pendingImpact === 'none',
        `returning to the model the anchored turn ran under must clear the caution, got ${selector._pendingImpact}`);
    } finally {
      selector.remove();
    }
  });

  await run('a sub-thread rebaselines after its turn even though its wrapper was replaced mid-refresh', async () => {
    const live = { model: 'planning' };
    const world = threadWorld(live);
    let blobModel = 'planning';
    let swapDuringRefresh = false;
    /** @type {any} */ (workerManager).getTransaction = async () => {
      // The completedTurns bump arrives inside a doc update, and that same update
      // rebuilds the column with a fresh wrapper — so the swap lands while this
      // round-trip is in flight. Reproduce that ordering exactly.
      if (swapDuringRefresh) selector.setMessageThread(world.newWrapper());
      return { inputTokens: 100000, modelConfig: { provider: 'anthropic', model: blobModel } };
    };

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);
    try {
      selector.setMessageThread(world.newWrapper());
      await waitFor(() => selector._baseline !== null,
        { intervalMs: 0, description: 'the first idle baseline' });
      assert(selector._pendingImpact === 'none',
        `an untouched thread on its own model must start silent, got ${selector._pendingImpact}`);

      // The user switches this column to another model and sends. The turn runs
      // and completes under it, so the anchored blob now records it.
      live.model = 'review';
      world.notifyMetadata('defaultModelConfig');
      assert(selector._pendingImpact === 'busts-large',
        `a staged model switch must caution before the send, got ${selector._pendingImpact}`);

      blobModel = 'review';
      swapDuringRefresh = true;
      const staleBaseline = selector._baseline;
      world.notifyMetadata('completedTurns');
      await waitFor(() => selector._baseline !== staleBaseline,
        { intervalMs: 0, description: 'the post-turn rebaseline' });

      assert(selector._pendingImpact === 'none',
        `the settled transcript is what is cached now — the caution must clear, got ${selector._pendingImpact}`);
      assert(selector._anchorModelSig === 'anthropic/review#',
        `the anchor must follow the model that ran the turn, got "${selector._anchorModelSig}"`);
    } finally {
      selector.remove();
    }
  });

  if (hadOwnGetTransaction) {
    /** @type {any} */ (workerManager).getTransaction = realGetTransaction;
  } else {
    delete (/** @type {any} */ (workerManager).getTransaction);
  }

  return { passed, failed, errors };
}
