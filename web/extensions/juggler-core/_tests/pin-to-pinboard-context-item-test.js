//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import PinToPinboardContextItem from '../context-items/pin-to-pinboard-context-item.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * Test the agent-facing contract and its realm-neutral pinboard request.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name.
   * @param {() => Promise<void>|void} fn - Test body.
   * @returns {Promise<void>} Resolves after the test is recorded.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const item = new PinToPinboardContextItem(/** @type {any} */ ({
    id: 'PIN_test',
    session: {},
    conversation: { id: 'conversation-one' },
    messageThread: {},
  }));

  await test('the schema exposes type-owned parameters rather than raw pin config', () => {
    const [definition] = PinToPinboardContextItem.getToolDefinitions();
    assert(definition.name === 'pin_to_pinboard', 'the tool should have its stable public name');
    assert(definition.input_schema.properties.type.enum.join(',') === 'file', 'file should be the supported first type');
    assert(definition.input_schema.properties.parameters.properties.path,
      'file parameters should declare their path');
    assert(!definition.input_schema.properties.config, 'persisted pin config must not be public input');
  });

  await test('validation dispatches to the selected type', async () => {
    assert(!(await item.validate({ type: 'url', parameters: { url: 'http://localhost:3000' } })).valid,
      'a type without an installed adapter should be rejected');
    assert(!(await item.validate({ type: 'file', parameters: {} })).valid,
      'file parameters need a path');
    const valid = await item.validate({ type: 'file', parameters: { path: ' ./docs//report.html ' } });
    assert(valid.valid, 'a file path should be accepted');
    assert(valid.params?.parameters?.path === 'docs/report.html', 'the file adapter should normalize its path');
  });

  await test('execute adds idempotently and requests an attributed reveal', async () => {
    const originalFetch = globalThis.fetch;
    /** @type {any} */
    let requestBody = null;
    globalThis.fetch = /** @type {any} */ (async (_url, options) => {
      requestBody = JSON.parse(options.body);
      const op = requestBody.operations[0];
      return { ok: true, json: async () => ({ pins: [{ id: op.id, type: op.type, config: op.config }] }) };
    });
    try {
      const params = { type: 'file', parameters: { path: 'docs/report.html' } };
      const first = await item.execute(params);
      const firstID = first.pin;
      await item.execute(params);
      assert(requestBody.operations[0].id === firstID, 'the same request should mint the same pin id');
      assert(requestBody.operations[0].type === 'file', 'the adapter should select the File pin');
      assert(requestBody.operations.length === 2 && requestBody.operations[1].op === 'update',
        'an idempotent retry should restore the expected config');
      assert(requestBody.operations[0].config.path === 'docs/report.html', 'the adapter should produce File config');
      assert(requestBody.operations[0].config.agentRequested === true,
        'the File pin should preserve that its path did not come from a user gesture');
      assert(requestBody.reveal.pin === firstID, 'the added pin should be the one requested for reveal');
      assert(requestBody.reveal.from === 'conversation-one', 'the reveal should be attributed to its conversation');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  return { passed, failed, errors };
}
