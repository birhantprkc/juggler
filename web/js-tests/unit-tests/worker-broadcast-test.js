//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a client does with the messages the worker sends to all of them.
 *
 * `render-context-items-request` and `request-tools` are BROADCAST: they reach
 * every client registered on the conversation, viewers included, and only the
 * engine may answer. A viewer that answers too turns the turn's system prompt
 * into a race between two realms — and the viewer renders from its own replica,
 * which can be behind — while the losing reply reaches a worker that has already
 * taken the other one and is logged as "[roundtrip] … answered a request nothing
 * was waiting for", the line that otherwise means a 30s ContextTimeout was
 * missed.
 *
 * `status` is the other half of the same story: it carries nothing itself, and
 * every client's answer to "is this conversation busy" is read from the doc
 * metadata that the transition it announces has just written — so the inbound
 * batch has to be applied as it lands, or the bin guard, the attention edges and
 * the spinner all answer from one sync window ago.
 * @module unit-tests/worker-broadcast-test
 */

import {
  handleRenderContextItemsRequest,
  handleRequestTools,
  sendRenderContextItemsResponse,
  sendToolsResult,
} from '../../js/services/worker-manager-protocols.js';
import { WorkerManager } from '../../js/services/worker-manager.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a stand-in WorkerManager that answers both requests and records what it
 * would send to the worker. No `_session`, so the handlers' load preamble
 * resolves to nothing and the callback runs directly.
 * @returns {any} Fake manager
 */
function fakeWorkerManager() {
  /** @type {any[]} */
  const sent = [];
  /** @type {string[]} */
  const asked = [];
  const wm = /** @type {any} */ ({
    sent,
    asked,
    _roundTripStamps: new Map(),
    sendToWorker(/** @type {string} */ _conversationId, /** @type {any} */ message) {
      sent.push(message);
    },
  });
  wm._onContextRequest = (/** @type {any} */ req) => {
    asked.push('context');
    sendRenderContextItemsResponse(wm, 'conv-1', req.requestId, [], 'prompt');
  };
  wm._onToolsRequest = (/** @type {any} */ req) => {
    asked.push('tools');
    sendToolsResult(wm, 'conv-1', req.requestId, []);
  };
  return wm;
}

/**
 * Run fn with the realm set to engine or viewer, restoring the flag after.
 * @param {boolean} engine - True to run as the engine
 * @param {() => Promise<void>|void} fn - Body to run
 * @returns {Promise<void>} Resolves once fn has run and the flag is restored
 */
async function asRealm(engine, fn) {
  const g = /** @type {any} */ (globalThis);
  const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
  const previous = g.JUGGLER_ENGINE;
  if (engine) g.JUGGLER_ENGINE = true;
  else delete g.JUGGLER_ENGINE;
  try {
    await fn();
  } finally {
    if (had) g.JUGGLER_ENGINE = previous;
    else delete g.JUGGLER_ENGINE;
  }
}

/**
 * Run viewer request-guard tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => Promise<void>|void} fn - Case body
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await test('a viewer ignores a broadcast render-context-items-request', async () => {
    const wm = fakeWorkerManager();
    await asRealm(false, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-1', sentAt: Date.now() });
    });
    assert(wm.asked.length === 0, `a viewer must not render context, ran: ${wm.asked.join(',')}`);
    assert(wm.sent.length === 0, `a viewer must not answer, sent: ${JSON.stringify(wm.sent)}`);
  });

  await test('the engine answers a render-context-items-request', async () => {
    const wm = fakeWorkerManager();
    await asRealm(true, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-2', sentAt: Date.now() });
    });
    assert(wm.sent.length === 1, `expected one reply, got ${wm.sent.length}`);
    assert(
      wm.sent[0].type === 'render-context-items-response' && wm.sent[0].requestId === 'req-2',
      `expected the engine's answer to req-2, got ${JSON.stringify(wm.sent[0])}`
    );
  });

  await test('a viewer ignores a broadcast request-tools', async () => {
    const wm = fakeWorkerManager();
    await asRealm(false, () => {
      handleRequestTools(wm, 'conv-1', { requestId: 'req-3', sentAt: Date.now() });
    });
    assert(wm.asked.length === 0, `a viewer must not build a tool list, ran: ${wm.asked.join(',')}`);
    assert(wm.sent.length === 0, `a viewer must not answer, sent: ${JSON.stringify(wm.sent)}`);
  });

  await test('the engine answers a request-tools', async () => {
    const wm = fakeWorkerManager();
    await asRealm(true, () => {
      handleRequestTools(wm, 'conv-1', { requestId: 'req-4', sentAt: Date.now() });
    });
    assert(wm.sent.length === 1, `expected one reply, got ${wm.sent.length}`);
    assert(
      wm.sent[0].type === 'tools-result' && wm.sent[0].requestId === 'req-4',
      `expected the engine's answer to req-4, got ${JSON.stringify(wm.sent[0])}`
    );
  });

  await test('a viewer leaves no round-trip stamp behind for a request it ignored', async () => {
    const wm = fakeWorkerManager();
    // Callbacks that record but never reply: a stamp taken before the role is
    // checked has nothing to release it, so it would still be held here.
    wm._onContextRequest = () => wm.asked.push('context');
    wm._onToolsRequest = () => wm.asked.push('tools');
    await asRealm(false, async () => {
      await handleRenderContextItemsRequest(wm, 'conv-1', { requestId: 'req-5', sentAt: Date.now() });
      handleRequestTools(wm, 'conv-1', { requestId: 'req-6', sentAt: Date.now() });
    });
    assert(
      wm._roundTripStamps.size === 0,
      `an ignored request must not be stamped, held: ${[...wm._roundTripStamps.keys()].join(',')}`
    );
  });

  await test('a status message applies the sync batch it was announced with', async () => {
    let flushes = 0;
    const manager = new WorkerManager();
    /** @type {any} */ (manager)._session = {
      conversations: new Map([['conv-1', { flushPendingSyncs: () => { flushes++; } }]])
    };

    /** @type {any} */ (manager)._handleWorkerMessage('conv-1', { type: 'status', status: 'streaming' });

    assert(flushes === 1, `a status transition must apply what has arrived, flushed ${flushes} times`);
  });

  return { passed, failed, errors };
}
