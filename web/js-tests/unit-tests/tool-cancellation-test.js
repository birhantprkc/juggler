//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for cancelling in-flight tool executions (built-in read
 * tools and the streaming shell).
 *
 * Regression target: a long-running grep (or any built-in read tool) used to
 * be uncancellable — pressing Escape did nothing because the engine never
 * aborted the in-flight op fetch, so the fetch ran to completion and the
 * strategy loop continued as if no cancel happened. The fix threads an
 * AbortSignal from each read tool's execute() down to the op fetch, and adds
 * ActionExecutor.cancelByToolUseId so the engine can abort the matching action
 * when the worker writes state='cancelled'.
 *
 * This test exercises the REAL path — ActionExecutor.execute → grep plugin
 * execute() → ops-api callOp → fetch({signal}) — and stubs only the network
 * boundary (window.fetch) with an op that stays in flight until its signal is
 * aborted, exactly how a big grep behaves when Escape fires.
 * @module unit-tests/tool-cancellation
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import actionExecutor from '../../js/services/action-executor.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all tool-cancellation tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: cancelByToolUseId aborts an in-flight read tool's op fetch and
  // produces a cancelled result; the loop-driving result is success:false.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      let resolveFetchStarted;
      const fetchStarted = new Promise((r) => { resolveFetchStarted = r; });

      // Stub the op boundary: a request that never resolves on its own but
      // rejects with an AbortError the instant its signal aborts. If the
      // caller failed to thread a signal (the bug), the request hangs
      // forever — the abort below would do nothing and the test would time
      // out, which is the failure we want to catch.
      window.fetch = (/** @type {any} */ _url, /** @type {any} */ opts = {}) =>
        new Promise((_resolve, reject) => {
          const signal = opts.signal;
          resolveFetchStarted();
          if (!signal) return; // no signal threaded → hang (regression)
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort);
        });

      // ActionExecutor keys on the plugin's MANIFEST id ('search'), not the
      // LLM-facing tool name ('grep'). Resolve it the same way the framework
      // does so the test stays correct if the mapping changes.
      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, "grep tool should resolve to a registered action id");

      const toolUseId = 'tc-cancel-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      // Wait until the op fetch is actually in flight before cancelling.
      await Promise.race([
        fetchStarted,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('op fetch never started')), 4000))
      ]);

      assert(actionExecutor.hasRunningActions(), 'grep action should be running while the op is in flight');

      // Wrong-conversation cancel must NOT abort the action: tool-use ids
      // recur across conversations (every mock test uses call_1; OpenAI
      // reuses call_N), so the match is scoped by conversation.
      const foundElsewhere = actionExecutor.cancelByToolUseId(toolUseId, 'some-other-conversation');
      assert(foundElsewhere === false, 'cancelByToolUseId must not match the same toolUseId in a different conversation');
      assert(actionExecutor.hasRunningActions(), 'action must still be running after a wrong-conversation cancel');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === true, 'cancelByToolUseId should find and abort the running action');

      const result = await execPromise;
      assert(result.cancelled === true, `expected cancelled result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled action must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared after cancellation');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel in-flight grep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
    }
  }

  // Test 2: cancelByToolUseId is a no-op (returns false) when no running
  // action matches the id — idempotent and safe to call on any cancel.
  {
    try {
      const found = actionExecutor.cancelByToolUseId('no-such-tool-use-id', 'no-such-conversation');
      assert(found === false, 'cancelByToolUseId should return false when no action matches');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel unknown id: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 3: a batch_grep (which fans out N inner ops) must be cancellable the
  // same way a single grep is — its inner ops must receive the action's
  // signal so an abort unwinds the in-flight fetch. Regression target: batch
  // called grep()/readFile() WITHOUT this.signal, so abort couldn't reach the
  // fetch; the op ran on, the action never settled, its _runningActions entry
  // never cleared, and the turn's read-tool Promise.all hung forever — every
  // later tool in the conversation wedged behind it.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      let resolveFetchStarted;
      const fetchStarted = new Promise((r) => { resolveFetchStarted = r; });

      // Honour the signal if threaded; hang forever otherwise (the bug).
      window.fetch = (/** @type {any} */ _url, /** @type {any} */ opts = {}) =>
        new Promise((_resolve, reject) => {
          const signal = opts.signal;
          resolveFetchStarted();
          if (!signal) return; // no signal threaded → hang (regression)
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort);
        });

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('batch_grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'batch_grep tool should resolve to a registered action id');

      const toolUseId = 'tc-batch-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { searches: [{ pattern: 'anything' }, { pattern: 'another' }] },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      await Promise.race([
        fetchStarted,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('batch op fetch never started')), 4000))
      ]);
      assert(actionExecutor.hasRunningActions(), 'batch_grep action should be running while its ops are in flight');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === true, 'cancelByToolUseId should find and abort the running batch action');

      const result = await Promise.race([
        execPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('cancelled batch never settled — abort did not unwind the inner ops')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled batch result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled batch must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared after batch cancellation');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel in-flight batch_grep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
    }
  }

  // Test 4: robustness backstop — a tool whose op IGNORES the abort signal
  // (a non-cooperative tool, or a backend that genuinely can't be interrupted)
  // must STILL settle as cancelled the moment the controller aborts. The
  // executor races execute() against the signal and detaches the orphaned op,
  // so no tool — however badly behaved — can leave the turn wedged.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      let resolveFetchStarted;
      const fetchStarted = new Promise((r) => { resolveFetchStarted = r; });

      // Deliberately ignore opts.signal entirely: hang forever no matter what.
      window.fetch = (/** @type {any} */ _url, /** @type {any} */ _opts = {}) =>
        new Promise(() => { resolveFetchStarted(); });

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'grep tool should resolve to a registered action id');

      const toolUseId = 'tc-backstop-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      await Promise.race([
        fetchStarted,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('op fetch never started')), 4000))
      ]);
      assert(actionExecutor.hasRunningActions(), 'action should be running while the un-cancellable op is in flight');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === true, 'cancelByToolUseId should find and abort the running action');

      const result = await Promise.race([
        execPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('executor did not settle a non-cooperative tool on abort — wedge persists')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled result from backstop, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled action must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared even when the op ignores the signal');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`backstop cancel of non-cooperative tool: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
    }
  }

  // Test 5: aborting an in-flight streaming shell must SEND shell-cancel to
  // the server, not just settle locally. Regression target: shellCancelStreaming
  // read the never-assigned `window.wsService` and silently no-opped, so an
  // interrupted bash resolved cancelled:true in the engine while the server-side
  // process ran on until its timeout reaped it (up to 20 minutes). This drives
  // the REAL shellExecuteStreaming and stubs only the WS boundary on the same
  // websocket.js singleton it uses.
  {
    const wsService = (await import('../../js/services/websocket.js')).default;
    const originalSendStart = wsService.sendShellStart;
    const originalSendCancel = wsService.sendShellCancel;
    try {
      const { shellExecuteStreaming } = await import('../../js/services/ops-api.js');

      /** @type {string|null} */
      let startedShellId = null;
      /** @type {string|null} */
      let cancelledShellId = null;

      // Swallow the outbound frames: the "server" never replies, exactly like a
      // long-running command that has produced no done chunk when Escape fires.
      wsService.sendShellStart = (/** @type {string} */ shellId) => {
        startedShellId = shellId;
        return true;
      };
      wsService.sendShellCancel = (/** @type {string} */ shellId) => {
        cancelledShellId = shellId;
        return true;
      };

      const controller = new AbortController();
      const resultPromise = shellExecuteStreaming(
        { command: 'sleep 999' },
        () => {},
        controller.signal
      );

      // shell-start is sent synchronously inside the promise executor after the
      // (already-cached) dynamic import resolves; give it a microtask-safe beat.
      await Promise.race([
        (async () => { while (startedShellId === null) await new Promise((r) => setTimeout(r, 10)); })(),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('shell-start was never sent')), 4000))
      ]);

      controller.abort();

      const result = await Promise.race([
        resultPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('aborted shell stream never settled')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled shell result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(cancelledShellId !== null, 'abort must send shell-cancel to the server — a local-only cancel orphans the server-side process');
      assert(cancelledShellId === startedShellId, `shell-cancel must target the started shell (started ${startedShellId}, cancelled ${cancelledShellId})`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`abort sends shell-cancel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      wsService.sendShellStart = originalSendStart;
      wsService.sendShellCancel = originalSendCancel;
    }
  }

  // Test 6: isExecutingToolUse is the liveness oracle for the worker's stuck-tool
  // backstop. It must report true for an in-flight action (matched by toolUseId +
  // conversationId), false for the same id in a different conversation, and false
  // once the action settles — so the backstop only finalizes tools no engine is
  // actually running. Mirrors cancelByToolUseId's conversation scoping.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      let resolveFetchStarted;
      const fetchStarted = new Promise((r) => { resolveFetchStarted = r; });
      window.fetch = (/** @type {any} */ _url, /** @type {any} */ opts = {}) =>
        new Promise((_resolve, reject) => {
          const signal = opts.signal;
          resolveFetchStarted();
          if (!signal) return;
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort);
        });

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'grep tool should resolve to a registered action id');

      const toolUseId = 'tc-liveness-1';
      // Before execution: nothing is running for this id.
      assert(actionExecutor.isExecutingToolUse(toolUseId, conversation.id) === false,
        'isExecutingToolUse must be false before the action starts');

      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      await Promise.race([
        fetchStarted,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('op fetch never started')), 4000))
      ]);

      // While in flight: live for the right conversation, dead for another.
      assert(actionExecutor.isExecutingToolUse(toolUseId, conversation.id) === true,
        'isExecutingToolUse must be true while the action is in flight');
      assert(actionExecutor.isExecutingToolUse(toolUseId, 'some-other-conversation') === false,
        'isExecutingToolUse must be conversation-scoped (a matching id in another conversation is not live)');
      assert(actionExecutor.isExecutingToolUse('no-such-id', conversation.id) === false,
        'isExecutingToolUse must be false for an unknown tool-use id');

      // Settle via cancel, then it must report dead.
      actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      await execPromise;
      assert(actionExecutor.isExecutingToolUse(toolUseId, conversation.id) === false,
        'isExecutingToolUse must be false once the action settles');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`isExecutingToolUse liveness oracle: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
    }
  }

  return { passed, failed, errors };
}
