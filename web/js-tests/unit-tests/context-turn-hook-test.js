//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the engine handler behind the context-item `onTurnEnd` hook
 * (`handleRunContextHook`) — the context-item counterpart to the strategy
 * `onWorkerIdle` hook, dispatched once per completed turn from the worker's
 * root-idle chokepoint. Drives the handler directly with a stubbed registry and
 * a minimal loaded conversation, so the hook contract is exercised in isolation
 * from the worker and the real registry.
 *
 * Contract under test:
 *   1. It fans out over the registry and calls each TYPE's static onTurnEnd,
 *      passing a context with {conversation, messageThread, session, turnIndex,
 *      signal}.
 *   2. A type that does NOT define onTurnEnd is skipped (no throw, not called).
 *   3. A throwing/rejecting onTurnEnd is isolated — it neither propagates out of
 *      the handler nor stops the other types' hooks from running.
 *   4. It is engine-only: a viewer-role call rejects with the role assertion
 *      rather than silently running session-wide flow in a viewer.
 *   5. A later turn's run supersedes a still-running earlier one for the same
 *      conversation: the earlier run's ctx.signal is aborted.
 * @module unit-tests/context-turn-hook-test
 */

import contextItemRegistry from '../../js/registries/context-item-registry.js';
import { handleRunContextHook } from '../../js/services/worker-manager-protocols.js';

/**
 * Build a minimal `wm` whose engine copy of the conversation is already loaded,
 * so `handleRunContextHook` resolves it without a real load.
 * @param {string} convId - Conversation id
 * @returns {{wm: any, conv: any}} The fake worker-manager and its conversation
 */
function makeEngineWm(convId) {
  const conv = {
    id: convId,
    loadState: 'loaded',
    rootMessageThread: { id: 'root-thread' },
    session: { getMetadata() { return null; }, patchMetadata() {} },
    _doc: { flushPendingUpdates() {} }
  };
  const wm = { _session: { conversations: new Map([[convId, conv]]) } };
  return { wm, conv };
}

/**
 * Run the context-turn-hook unit tests.
 * @param {any} _ctx - Unused test context
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results
 */
export async function runTests(_ctx) {
  void _ctx;
  let passed = 0, failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {boolean} cond - Assertion condition
   * @param {string} msg - Failure message
   */
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  /**
   * @param {string} name - Sub-test name
   * @param {() => Promise<void>} fn - Sub-test body
   */
  async function test(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const g = /** @type {any} */ (globalThis);
  const prevEngine = g.JUGGLER_ENGINE;
  const originalGetAll = contextItemRegistry.getAll.bind(contextItemRegistry);

  try {
    await test('fans out over the registry, calling each type\'s static onTurnEnd with a full context', async () => {
      g.JUGGLER_ENGINE = true;
      /** @type {any[]} */
      const seen = [];
      class OptedIn {
        static MANIFEST = { id: 'opted-in' };
        static async onTurnEnd(ctx) { seen.push(ctx); }
      }
      class NoHook { static MANIFEST = { id: 'no-hook' }; }
      contextItemRegistry.getAll = () => /** @type {any} */ ([{ class: OptedIn }, { class: NoHook }]);

      const { wm, conv } = makeEngineWm('conv-fanout');
      await handleRunContextHook(wm, 'conv-fanout', { hook: 'onTurnEnd', turnIndex: 3 });

      assert(seen.length === 1, `onTurnEnd should be called once (only the opted-in type), got ${seen.length}`);
      const ctx = seen[0];
      assert(ctx.conversation === conv, 'ctx.conversation is the loaded conversation');
      assert(ctx.messageThread === conv.rootMessageThread, 'ctx.messageThread is the root thread');
      assert(ctx.session === conv.session, 'ctx.session is the conversation session');
      assert(ctx.turnIndex === 3, `ctx.turnIndex should be the dispatched turn (3), got ${ctx.turnIndex}`);
      assert(ctx.signal && typeof ctx.signal.aborted === 'boolean' && typeof ctx.signal.addEventListener === 'function',
        'ctx.signal is an AbortSignal');
      assert(ctx.signal.aborted === false, 'ctx.signal is not aborted while the run is current');
    });

    await test('a throwing onTurnEnd is isolated — others still run, handler does not reject', async () => {
      g.JUGGLER_ENGINE = true;
      let goodRan = false;
      class Thrower {
        static MANIFEST = { id: 'thrower' };
        static onTurnEnd() { throw new Error('boom'); }
      }
      class Good {
        static MANIFEST = { id: 'good' };
        static async onTurnEnd() { goodRan = true; }
      }
      // Thrower first, so its failure would precede Good if isolation were broken.
      contextItemRegistry.getAll = () => /** @type {any} */ ([{ class: Thrower }, { class: Good }]);

      const { wm } = makeEngineWm('conv-throw');
      // Must resolve (not reject) despite the throwing hook.
      await handleRunContextHook(wm, 'conv-throw', { hook: 'onTurnEnd', turnIndex: 1 });
      assert(goodRan, 'a sibling hook must still run after another type\'s onTurnEnd throws');
    });

    await test('engine-only: a viewer-role call rejects with the role assertion', async () => {
      delete g.JUGGLER_ENGINE; // present as a viewer
      contextItemRegistry.getAll = () => /** @type {any} */ ([]);
      const { wm } = makeEngineWm('conv-viewer');
      let threw = false;
      try {
        await handleRunContextHook(wm, 'conv-viewer', { hook: 'onTurnEnd', turnIndex: 1 });
      } catch (e) {
        threw = true;
        assert(/viewer/i.test(e instanceof Error ? e.message : String(e)),
          'the rejection should name the viewer-role violation');
      }
      assert(threw, 'a viewer-role call must reject, not run session-wide flow in a viewer');
    });

    await test('a later turn supersedes a still-running earlier run: the earlier ctx.signal aborts', async () => {
      g.JUGGLER_ENGINE = true;
      /** @type {() => void} */
      let release = () => {};
      const gate = new Promise((res) => { release = res; });
      /** @type {any[]} */
      const seen = [];
      class Slow {
        static MANIFEST = { id: 'slow' };
        static onTurnEnd(ctx) { seen.push(ctx); return gate; }
      }
      contextItemRegistry.getAll = () => /** @type {any} */ ([{ class: Slow }]);

      const { wm } = makeEngineWm('conv-supersede');
      const p1 = handleRunContextHook(wm, 'conv-supersede', { hook: 'onTurnEnd', turnIndex: 1 });
      // Let run 1 reach the (pending) hook call and register its abort scope.
      await new Promise((r) => setTimeout(r, 0));
      assert(seen.length === 1, 'run 1 should have started its (pending) onTurnEnd');
      assert(seen[0].signal.aborted === false, 'run 1 signal not aborted while it is the current run');

      const p2 = handleRunContextHook(wm, 'conv-supersede', { hook: 'onTurnEnd', turnIndex: 2 });
      // Let run 2 reach its top-of-run supersede (it aborts run 1's scope).
      await new Promise((r) => setTimeout(r, 0));
      assert(seen[0].signal.aborted === true, 'the superseded earlier run\'s signal must be aborted');

      release(); // let both pending runs settle
      await Promise.all([p1, p2]);
    });
  } finally {
    contextItemRegistry.getAll = originalGetAll;
    if (prevEngine === undefined) delete g.JUGGLER_ENGINE; else g.JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
