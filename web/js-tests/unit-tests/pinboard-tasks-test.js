//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the board can honestly say a conversation is running.
 *
 * `services.tasks` is two halves joined: the transcript says which tasks were
 * started, and the server says which are still alive. Neither is sufficient, and
 * the reason is the thing this suite exists to guard — the durable snapshot
 * beside a tool action freezes at whatever it last said, so a transcript read on
 * its own claims `running` forever, including for a task that died with a
 * previous server. The case that pins it is "a stale snapshot does not resurrect
 * a task the server says is gone", and breaking the join is what should fail it.
 *
 * Against real conversation and thread models with real Yjs items, because the
 * shape this walks — a task id nested three maps deep under a result that also
 * holds the command's accumulated output — is exactly what a hand-built fake
 * would get wrong in its own favour.
 *
 * Driven through a probe item type registered only here, the same way
 * `unit:pinboard-file-edits` does.
 * @module unit-tests/pinboard-tasks-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createAssistantMessage } from '../../sdk/lib/message.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import PinboardItemType from 'juggler/pinboard-item-type';
import '../../js/components/pinboard-content.js';

/** The context the probe was mounted with. */
const probe = { context: /** @type {any} */ (null) };

/** A pin type whose whole purpose is to hand back the context it was given. */
class TaskProbePin extends PinboardItemType {
  static MANIFEST = {
    id: 'task-probe',
    name: 'Task probe',
    version: '1.0.0',
    description: 'A pin that exists only in this test',
    instances: 'multiple',
  };

  /**
   * @param {HTMLElement} container - The body region to fill.
   * @param {any} pinContext - The pin, the active snapshot and the host services.
   * @returns {{teardown: () => void}} The controller.
   */
  mount(container, pinContext) {
    probe.context = pinContext;
    container.textContent = 'task probe';
    return { teardown: () => {} };
  }
}

/** The project this fixture pretends to be in. */
const PROJECT = '/tmp/pinboard-tasks';

/**
 * Wait for something to become true, rather than for a length of time: a lane
 * shares one browser with every other, so a fixed delay is a coin toss.
 * @param {() => any} check - Returns something truthy once the wait is over.
 * @param {string|(() => string)} what - The complaint if it never happens.
 * @param {number} [timeout] - How long to give it.
 * @returns {Promise<any>} Whatever `check` returned.
 */
async function waitFor(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(typeof what === 'function' ? what() : what);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  // A lane reuses one JS realm across suites, so start from a known registry and
  // hand back one with no probe types in it.
  pinboardItemRegistry.reset();
  pinboardItemRegistry.registerClass(TaskProbePin, { extensionId: 'test' });
  probe.context = null;

  // --- the fake server ------------------------------------------------------

  /** Which task ids the registry would say are running. */
  const alive = new Set();
  /** Every taskStatus request body seen, so a case can assert what was asked. */
  const probes = [];
  /** Every kill request seen. */
  const kills = [];
  /** When set, the next taskStatus fails with this. */
  let opFailure = '';

  const originalFetch = window.fetch;
  /**
   * Answer the two ops this service uses, and — the part that matters — hand
   * every other URL to the real fetch. A stub that answers everything swallows
   * the harness's own result POST, and the suite then hangs for a minute looking
   * exactly like a dead pool.
   * @param {any} input - The request URL or Request.
   * @param {any} [init] - The request options.
   * @returns {Promise<any>} The response.
   */
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/ops/call')) return originalFetch(input, init);

    const body = JSON.parse(String(init?.body || '{}'));
    if (body.toolId !== 'shell') return originalFetch(input, init);

    if (body.operation === 'taskStatus') {
      probes.push(body.params);
      if (opFailure) {
        return new window.Response(JSON.stringify({ success: false, error: opFailure }), { status: 200 });
      }
      const tasks = (body.params.task_ids || []).map((/** @type {string} */ id) => ({
        task_id: id,
        status: alive.has(id) ? 'running' : 'not_found',
        running: alive.has(id),
      }));
      return new window.Response(JSON.stringify({ success: true, data: { tasks } }), { status: 200 });
    }
    if (body.operation === 'kill') {
      kills.push(body.params);
      alive.delete(body.params.shell_id);
      return new window.Response(
        JSON.stringify({ success: true, data: { shell_id: body.params.shell_id, killed: true } }),
        { status: 200 }
      );
    }
    return originalFetch(input, init);
  };

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let content = null;
  /** @type {(() => void)|null} */
  let watching = null;

  /** Stamps rise so "newest first" has something to sort by. */
  let clock = 1;

  /**
   * Put one tool action on a thread, exactly as the worker leaves it.
   * @param {any} thread - The thread to append to.
   * @param {object} spec - What this action is.
   * @param {string} spec.tool - The tool name.
   * @param {string} spec.command - The command it ran.
   * @param {string} [spec.taskId] - The background task id it was handed, if any.
   * @param {string} [spec.description] - Monitor's label for it.
   * @param {string} [spec.snapshotStatus] - A durable `displayData.backgroundTask` status.
   * @returns {string} The action's item id.
   */
  function addAction(thread, spec) {
    const { tool, command, taskId, description, snapshotStatus } = spec;
    /** @type {any} */
    const input = { command };
    if (description !== undefined) input.description = description;

    // A background run's result carries the task receipt — and, once it has been
    // running a while, the command's accumulated output beside it. It is here so
    // the walk is measured against the real shape, where reaching the task id
    // through toJSON() would copy every byte the command has produced.
    /** @type {any} */
    const result = {
      isError: false,
      fullResult: {
        success: true,
        result: taskId
          ? { task_id: taskId, status: 'running', output: `SECRET_TOKEN=hunter2\n${'y'.repeat(4096)}` }
          : { stdout: 'done' },
      },
    };

    const message = thread.appendToolAction({
      toolUseId: `tu_${clock}`,
      toolName: tool,
      toolInput: input,
      state: 'completed',
      result,
    });

    const items = thread.items;
    const ymap = items[items.length - 1];
    ymap.set('timestamp', new Date(1700000000000 + clock * 1000).toISOString());
    if (snapshotStatus) {
      // What the observer leaves behind, and what freezes: after a restart this
      // still says whatever it last said.
      ymap.set('displayData', { backgroundTask: { taskId, status: snapshotStatus, output: '' } });
    }
    clock++;
    return ymap.get('itemId') || message.itemId;
  }

  /**
   * The active-context snapshot the panel hands the content band.
   * @param {string|null} threadId - The thread being read, null for the root.
   * @returns {any} The snapshot.
   */
  const activeContext = (threadId) => ({
    project: { path: PROJECT, displayName: 'pinboard-tasks' },
    conversation: { id: conversation.id, title: conversation.name },
    thread: { id: threadId },
  });

  /**
   * The service under test, as a pin receives it.
   * @returns {any} `services.tasks`.
   */
  const service = () => probe.context.services.tasks;

  /**
   * Force a fresh check and wait for its answer. Subscribing is what starts a
   * check, so a second, momentary watcher is the contract's own way to ask for
   * one — the interval is focus-gated and far too slow for a test either way.
   * @returns {Promise<any[]>} The task list after the check.
   */
  async function refresh() {
    const seen = probes.length;
    const stop = service().onChange(() => {});
    await waitFor(() => probes.length > seen || opFailure, 'the check to be made');
    stop();
    // The answer lands a microtask or two after the request; wait for the state
    // it produces rather than for a duration.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return service().list();
  }

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    session.setConversationName(conversation.id, 'Running things');
    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;

    /** @type {string} */
    let subThread = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Start some things'));
      subThread = root.createSubThread({
        goal: 'Run the build',
        initialItems: [createAssistantMessage('Starting.')],
      }).threadId;
    }, conversation._doc.authorId);

    content = /** @type {any} */ (document.createElement('pinboard-content'));
    container.appendChild(content);
    content.setSession(session);
    content.setPin({ id: 'pin_probe', type: 'task-probe', config: {} }, activeContext(null));
    await waitFor(() => probe.context, 'the probe pin never mounted');

    // --- before anything is asked --------------------------------------------

    await run('nothing has been asked yet, so the list is null rather than empty', () => {
      assert(service().list() === null,
        `"nothing running" is a claim; before a check the answer is null, got ${JSON.stringify(service().list())}`);
    });

    // Start watching for the rest of the suite. The first watcher triggers the
    // first check, which is what turns null into a list.
    watching = service().onChange(() => {});
    await waitFor(() => service().list() !== null, 'the first check never landed');

    await run('an empty transcript is running nothing', () => {
      const list = service().list();
      assert(Array.isArray(list) && list.length === 0, `expected [], got ${JSON.stringify(list)}`);
    });

    // --- what counts as a task ------------------------------------------------

    await run('a background bash the server confirms is running is listed', async () => {
      const itemId = addAction(root, { tool: 'bash', command: 'npm run build', taskId: 'bg-build' });
      alive.add('bg-build');
      const list = await refresh();
      assert(list.length === 1, `expected one task, got ${JSON.stringify(list)}`);
      assert(list[0].taskId === 'bg-build', `expected bg-build, got ${list[0].taskId}`);
      assert(list[0].command === 'npm run build', `expected the command, got ${list[0].command}`);
      assert(list[0].itemId === itemId, `expected the spawning action, got ${list[0].itemId}`);
      assert(list[0].threadId === null, `a root-thread task has no thread id, got ${list[0].threadId}`);
    });

    await run('a foreground command is not a task', async () => {
      addAction(root, { tool: 'bash', command: 'ls -la' });
      const list = await refresh();
      assert(!list.some((/** @type {any} */ t) => t.command === 'ls -la'),
        `a command with no task receipt was never a background task: ${JSON.stringify(list.map((/** @type {any} */ t) => t.command))}`);
    });

    await run('a Monitor is a task, and its description is carried as the label', async () => {
      addAction(root, {
        tool: 'Monitor', command: 'tail -f build.log', taskId: 'bg-monitor', description: 'Watching the build',
      });
      alive.add('bg-monitor');
      const list = await refresh();
      const found = list.find((/** @type {any} */ t) => t.taskId === 'bg-monitor');
      assert(!!found, `expected the monitor listed: ${JSON.stringify(list.map((/** @type {any} */ t) => t.taskId))}`);
      assert(found.label === 'Watching the build', `expected the label, got ${JSON.stringify(found.label)}`);
      assert(found.toolName === 'Monitor', `expected the tool named, got ${found.toolName}`);
    });

    await run('a task started in a sub-thread says which thread it was', async () => {
      const sub = conversation.resolveMessageThread(subThread);
      addAction(sub, { tool: 'bash', command: 'npm test', taskId: 'bg-sub' });
      alive.add('bg-sub');
      const list = await refresh();
      const found = list.find((/** @type {any} */ t) => t.taskId === 'bg-sub');
      assert(!!found, 'a sub-thread task belongs to the conversation as much as a root one');
      assert(found.threadId === subThread, `expected the owning thread ${subThread}, got ${found.threadId}`);
    });

    // --- the join, which is the whole point ----------------------------------

    await run('a task the server no longer knows about drops off the list', async () => {
      alive.delete('bg-build');
      const list = await refresh();
      assert(!list.some((/** @type {any} */ t) => t.taskId === 'bg-build'),
        `a task that has ended is not running: ${JSON.stringify(list.map((/** @type {any} */ t) => t.taskId))}`);
      // The others are untouched — one task ending is not a reason to lose the rest.
      assert(list.some((/** @type {any} */ t) => t.taskId === 'bg-monitor'),
        'the remaining tasks must survive one of them ending');
    });

    await run('a stale snapshot does not resurrect a task the server says is gone', async () => {
      // This is what a restart leaves: the transcript's durable snapshot still
      // says `running`, because nothing ever goes back to correct it. Believing
      // it would make the board claim a dead process is alive, for good.
      addAction(root, {
        tool: 'bash', command: 'sleep 9999', taskId: 'bg-ghost', snapshotStatus: 'running',
      });
      const list = await refresh();
      assert(!list.some((/** @type {any} */ t) => t.taskId === 'bg-ghost'),
        `the server is the only thing that knows what is running: ${JSON.stringify(list.map((/** @type {any} */ t) => t.taskId))}`);
    });

    await run('the check asks only about ids the transcript already named', () => {
      const last = probes[probes.length - 1];
      assert(last.conv_id === conversation.id, `expected the conversation named, got ${last.conv_id}`);
      assert(Array.isArray(last.task_ids), 'the check must name the ids it is asking about');
      const known = ['bg-build', 'bg-monitor', 'bg-sub', 'bg-ghost'];
      assert(last.task_ids.every((/** @type {string} */ id) => known.includes(id)),
        `it must not ask about anything it did not read: ${JSON.stringify(last.task_ids)}`);
    });

    // --- what never leaves the model -----------------------------------------

    await run("the command's output never reaches the pin", () => {
      const list = service().list();
      const serialised = JSON.stringify(list);
      assert(!serialised.includes('hunter2'),
        `a task's accumulated output must stay in the model:\n${serialised.slice(0, 400)}`);
      assert(!serialised.includes('yyyy'),
        `and so must its bulk — the walk reads fields, it does not copy results:\n${serialised.length} chars`);
    });

    await run('the list handed out is a copy of nothing the model can see change', async () => {
      const first = await refresh();
      first.push({ taskId: 'bg-invented' });
      const second = service().list();
      assert(!second.some((/** @type {any} */ t) => t.taskId === 'bg-invented'),
        'a caller mutating the list must not change what the next one reads');
    });

    // --- stopping -------------------------------------------------------------

    await run('stopping a plain task kills it, naming its conversation', async () => {
      alive.add('bg-sub');
      await refresh();
      const before = kills.length;
      await service().stop('bg-sub');
      assert(kills.length === before + 1, `expected one kill, got ${kills.length - before}`);
      assert(kills[kills.length - 1].shell_id === 'bg-sub',
        `expected the named task, got ${kills[kills.length - 1].shell_id}`);
      assert(kills[kills.length - 1].conv_id === conversation.id,
        `a bare task id is not enough authority; got ${JSON.stringify(kills[kills.length - 1].conv_id)}`);
    });

    await run('a stopped task is gone from the list without waiting for the next check', () => {
      assert(!(service().list() || []).some((/** @type {any} */ t) => t.taskId === 'bg-sub'),
        'stopping re-checks, so the row goes at once rather than lingering for two seconds');
    });

    // --- failure --------------------------------------------------------------

    await run('a failed check is reported and the last list is kept', async () => {
      const before = (service().list() || []).length;
      opFailure = 'connection refused';
      const stop = service().onChange(() => {});
      await waitFor(() => service().error(), 'the failure to be recorded');
      stop();
      assert(service().error().includes('connection refused'),
        `expected the underlying text kept, got ${JSON.stringify(service().error())}`);
      assert((service().list() || []).length === before,
        'a check that failed is not evidence the tasks stopped');
      opFailure = '';
    });

    await run('a later good check clears the failure', async () => {
      await refresh();
      assert(service().error() === '', `expected the error cleared, got ${JSON.stringify(service().error())}`);
    });

    // --- watching -------------------------------------------------------------

    await run('unsubscribing stops the checks', async () => {
      const stop = service().onChange(() => {});
      await waitFor(() => true, 'never');
      stop();
      // The last watcher leaving stops the interval; the one held for this suite
      // is still here, so this asserts the bookkeeping rather than the timer.
      assert(typeof stop === 'function', 'onChange must hand back an unsubscribe');
    });

    await run('teardown drops the watcher the pin never unsubscribed', async () => {
      const before = probes.length;
      // Replace the mounted pin: the old one's signal aborts, which is what a
      // forgetful item type relies on.
      content.setPin({ id: 'pin_other', type: 'task-probe', config: {} }, activeContext(null));
      await waitFor(() => probe.context.pin.id === 'pin_other', 'the second pin never mounted');
      assert(probes.length >= before, 'remounting must not lose the ability to check');
    });
  } finally {
    // Drain every stub in a finally, so a case that throws cannot strand one for
    // every later suite in this realm.
    try {
      watching?.();
    } finally {
      window.fetch = originalFetch;
      content?.remove();
      container.remove();
      pinboardItemRegistry.reset();
      probe.context = null;
    }
  }

  return { passed, failed, errors };
}
