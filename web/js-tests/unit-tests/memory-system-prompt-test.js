//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Memory ↔ system-prompt integration + cache-stability proof.
 *
 * Memory is a `system`-position context item, so it rides the existing
 * cached-prefix assembly (`assembleSystemPrompt`) with NO builder change. This
 * locks in the cache contract:
 *  - memory entries appear in the assembled system prompt, after identity;
 *  - empty/absent memory contributes nothing (no block, no cache churn);
 *  - the assembled prefix is byte-stable across repeated assembly and across a
 *    strategy change (the builder takes no strategy, so strategy cannot affect
 *    it) — it changes ONLY after a remember/forget actually mutates the file.
 * @module unit-tests/memory-system-prompt-test
 */

import { assembleSystemPrompt } from '../../js/services/system-prompt-builder.js';
import MemoryContextItem from '../../extensions/juggler-core/context-items/memory-context-item.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

const CONTEXT_PARAMS = { contextWindowSize: 128000, modelConfig: null, helpers: {} };

/**
 * A minimal fake system-prompt item (identity at the head of the prefix).
 * @returns {any} Fake system-prompt context item
 */
function fakeSystemPrompt() {
  return {
    id: 'SYSTEM_1',
    type: 'system-prompt',
    constructor: { MANIFEST: { contextPosition: 'system' } },
    buildPrompt: () => 'IDENTITY',
    getContextText: async () => ''
  };
}

/**
 * Run memory system-prompt tests.
 * @param {{fixtureDir: string}} ctx - Test context with fixtureDir
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
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

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  let pathCounter = 0;

  /**
   * @returns {MemoryContextItem} A memory item bound to a fresh isolated file
   */
  function makeMemory() {
    const item = new MemoryContextItem({
      id: `MEM_sp_${++pathCounter}`,
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
    // Isolated path so this never touches the project's real memory file —
    // and never the DEFAULT_PATH, so _ensureSeeded stays inert here.
    item.data.path = `${ctx.fixtureDir}/_memory_sp/m${pathCounter}/MEMORY.md`;
    return item;
  }

  await test('empty memory contributes nothing to the assembled prompt', async () => {
    const mem = makeMemory();
    const out = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    assert(out === 'IDENTITY', `empty memory should add nothing; got:\n${out}`);
  });

  await test('memory entries appear after identity at the system position', async () => {
    const mem = makeMemory();
    await mem.execute({ action: 'remember', fact: 'Build is `make build`' });
    const out = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    assert(out.startsWith('IDENTITY'), `identity should lead the prefix; got:\n${out}`);
    assert(out.includes('=== Project Memory ==='), `memory block should be present; got:\n${out}`);
    assert(out.includes('Build is `make build`'), `entry should be present; got:\n${out}`);
    assert(out.indexOf('IDENTITY') < out.indexOf('=== Project Memory ==='), 'memory must follow identity, not precede it');
  });

  await test('assembled prefix is byte-stable across repeated assembly and changes only after a write', async () => {
    const mem = makeMemory();
    await mem.execute({ action: 'remember', fact: 'first fact' });

    const a = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    const b = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    assert(a === b, `unchanged memory must yield a byte-identical prefix (cache-stable):\n--- a ---\n${a}\n--- b ---\n${b}`);

    // A genuine change (remember) is the ONLY thing that moves the prefix.
    await mem.execute({ action: 'remember', fact: 'second fact' });
    const c = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    assert(c !== a, 'a remember must change the prefix');
    assert(c.includes('second fact'), 'the new fact must be in the changed prefix');

    // And forgetting it returns to a stable, smaller prefix.
    await mem.execute({ action: 'forget', match: 'second fact' });
    const d = await assembleSystemPrompt({ contextItems: [fakeSystemPrompt(), mem], contextParams: CONTEXT_PARAMS });
    assert(d === a, `forgetting the added fact should restore the earlier prefix exactly:\n--- d ---\n${d}\n--- a ---\n${a}`);
  });

  return { passed, failed, errors };
}
