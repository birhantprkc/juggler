//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * One-shot run tests.
 *
 * `runOneShot` is the whole of an unattended run: a process is blocked on the
 * single result it sends, and nothing downstream can tell a run that answered
 * badly from one that answered well. So what is guarded here is what that
 * result must be able to distinguish — finished, parked on a tool that wants a
 * human, errored, and never delivered — plus the two silent-wrong failures the
 * run is built to avoid: a conversation left un-configured (which parks on its
 * first tool), and a turn fence that reads the idle from *before* the send and
 * reports an empty run as a success.
 * @module unit-tests/one-shot-run-test
 */

import { runOneShot } from '../../js/engine-one-shot.js';
import wsService from '../../js/services/websocket.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A stand-in for one Yjs item: only `get` is ever used to read one.
 * @param {Record<string, any>} fields - The item's keys
 * @returns {any} An item the turn fence and the result readers can read
 */
function item(fields) {
  return { get: (/** @type {string} */ key) => fields[key] };
}

/**
 * A conversation with just enough of the real one to be driven: an observable
 * document, a root thread, and the two durable signals the turn fence reads.
 * @param {{completedTurns?: number, status?: string}} [start] - Initial worker state
 * @returns {any} The fake conversation, with a `spy` recording how it was configured
 */
function makeConversation({ completedTurns = 0, status = 'idle' } = {}) {
  const observers = new Set();
  const state = { items: /** @type {any[]} */ ([]), completedTurns, status };
  const spy = { strategy: '', rules: /** @type {any[]} */ ([]), autoApprove: false, sinceTurnAtSend: -1 };

  const fire = () => {
    for (const fn of [...observers]) fn();
  };

  const conversation = {
    spy,
    state,
    fire,
    _doc: {
      metadata: {
        observe: (/** @type {any} */ fn) => observers.add(fn),
        unobserve: (/** @type {any} */ fn) => observers.delete(fn),
        get: (/** @type {string} */ key) => (key === 'processingState' ? { status: state.status } : undefined)
      },
      root: {
        observeDeep: (/** @type {any} */ fn) => observers.add(fn),
        unobserveDeep: (/** @type {any} */ fn) => observers.delete(fn)
      }
    },
    rootMessageThread: {
      get items() { return state.items; },
      setStrategy: (/** @type {string} */ id) => { spy.strategy = id; },
      addRule: (/** @type {string} */ type, /** @type {any} */ rule) => { spy.rules.push({ type, rule }); }
    },
    get processingState() { return { status: state.status }; },
    get completedTurns() { return state.completedTurns; },
    setAutoApprove: (/** @type {boolean} */ on) => { spy.autoApprove = on; },
    /** @type {(msg: string) => Promise<string|null>} */
    sendMessage: async () => null
  };
  return conversation;
}

/**
 * A session that hands back one prepared conversation.
 * @param {any} conversation - The conversation `createConversation` produces
 * @returns {any} The fake session
 */
function makeSession(conversation) {
  return {
    createConversation: async () => 'conv_test123',
    getConversation: (/** @type {string} */ id) => (id === 'conv_test123' ? conversation : null)
  };
}

/**
 * Run one prompt and capture the single result it reports.
 * @param {any} session - Session to run in
 * @param {object} [request] - Overrides for the run-one-shot message
 * @returns {Promise<any>} The result that would have gone back to the server
 */
async function capture(session, request = {}) {
  const original = wsService.sendOneShotResult;
  /** @type {any} */
  let sent = null;
  let sends = 0;
  wsService.sendOneShotResult = (/** @type {any} */ result) => {
    sent = result;
    sends++;
    return true;
  };
  try {
    await runOneShot(session, { requestId: 'run_1', prompt: 'do the thing', strategyId: 'yolo', timeoutMs: 2000, ...request });
  } finally {
    wsService.sendOneShotResult = original;
  }
  assert(sends === 1, `expected exactly one result to be sent, got ${sends}`);
  return sent;
}

/**
 * Run one-shot run tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>} fn - Test body
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  };

  await test('a completed turn reports its answer, and the conversation was configured for nobody being there', async () => {
    const conversation = makeConversation({ completedTurns: 3 });
    conversation.sendMessage = async () => {
      conversation.state.items.push(item({ type: 'assistant', content: 'the thing is done' }));
      conversation.state.completedTurns = 4;
      queueMicrotask(conversation.fire);
      return null;
    };

    const result = await capture(makeSession(conversation));

    assert(result.status === 'completed', `status was ${result.status}`);
    assert(result.finalText === 'the thing is done', `finalText was ${JSON.stringify(result.finalText)}`);
    assert(result.turns === 1, `turns was ${result.turns}`);
    assert(result.conversationId === 'conv_test123', `conversationId was ${result.conversationId}`);
    assert(result.requestId === 'run_1', 'the result must answer the request that asked');

    // Every layer that can park a tool, because any one of them left alone is a
    // hang rather than a prompt when there is nobody to ask.
    assert(conversation.spy.strategy === 'yolo', `strategy was ${conversation.spy.strategy}`);
    assert(conversation.spy.autoApprove === true, 'auto-approve was not enabled');
    const execute = conversation.spy.rules.find((/** @type {any} */ r) => r.type === 'execute');
    assert(!!conversation.spy.rules.find((/** @type {any} */ r) => r.type === 'write-file'), 'no write-file rule was added');
    assert(!!execute, 'no execute rule was added');
    assert(execute.rule.scope === 'conversation', `the execute grant was ${execute.rule.scope}-scoped, which outlives this run`);
  });

  await test('the fence is taken before the send, so the idle already there is not read as the turn', async () => {
    const conversation = makeConversation({ completedTurns: 3 });
    // The worker is idle at the moment of the send — as it always is — and the
    // turn only lands a beat later. A wait that settles on any idle answers
    // before the model has said anything at all.
    conversation.sendMessage = async () => {
      setTimeout(() => {
        conversation.state.items.push(item({ type: 'assistant', content: 'answered late' }));
        conversation.state.completedTurns = 4;
        conversation.fire();
      }, 20);
      return null;
    };

    const result = await capture(makeSession(conversation));
    assert(result.status === 'completed', `status was ${result.status}`);
    assert(result.finalText === 'answered late', 'the run reported before the turn had finished');
  });

  await test('a tool waiting for a human is parked, not completed, and is named', async () => {
    const conversation = makeConversation({ completedTurns: 1, status: 'processing_tools' });
    conversation.sendMessage = async () => {
      conversation.state.items.push(item({ type: 'tool-action', state: 'pending', toolName: 'AskUserQuestion' }));
      queueMicrotask(conversation.fire);
      return null;
    };

    const result = await capture(makeSession(conversation));
    assert(result.status === 'parked', `status was ${result.status}`);
    assert(result.parkedTool === 'AskUserQuestion', `parkedTool was ${JSON.stringify(result.parkedTool)}`);
  });

  await test('an errored turn reports the error the worker wrote, not a summary of it', async () => {
    const conversation = makeConversation({ completedTurns: 0 });
    conversation.sendMessage = async () => {
      conversation.state.items.push(item({ type: 'error', message: 'provider returned 401 unauthorized' }));
      conversation.state.completedTurns = 1;
      queueMicrotask(conversation.fire);
      return null;
    };

    const result = await capture(makeSession(conversation));
    assert(result.status === 'failed', `status was ${result.status}`);
    assert(result.errorText === 'provider returned 401 unauthorized', `errorText was ${JSON.stringify(result.errorText)}`);
  });

  await test('a prompt a guard dropped fails immediately, carrying the reason', async () => {
    const conversation = makeConversation();
    conversation.sendMessage = async () => 'already processing';

    const result = await capture(makeSession(conversation));
    assert(result.status === 'failed', `status was ${result.status}`);
    assert(result.errorText.includes('already processing'), `errorText was ${JSON.stringify(result.errorText)}`);
    assert(result.turns === 0, `turns was ${result.turns}`);
  });

  await test('a run with nothing to run fails rather than creating a conversation', async () => {
    let created = 0;
    const session = { createConversation: async () => { created++; return 'conv_test123'; }, getConversation: () => null };
    const result = await capture(session, { prompt: '   ' });
    assert(result.status === 'failed', `status was ${result.status}`);
    assert(created === 0, 'an empty prompt created a conversation anyway');
  });

  return { passed, failed, errors };
}
