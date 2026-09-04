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

  // The tool reads the installed pin types before every tool list is built, and
  // its whole job is to name them, so nothing below means anything until it has.
  await PinToPinboardContextItem.prepareToolDefinitions();

  await test('the schema stays open to any installed pinboard item type', () => {
    const [definition] = PinToPinboardContextItem.getToolDefinitions();
    assert(definition.name === 'pin_to_pinboard', 'the tool should have its stable public name');
    assert(!definition.input_schema.properties.type.enum,
      'type must not be a closed enum — an extension-installed type has no entry to add itself to');
    assert(definition.input_schema.properties.parameters.type === 'object',
      'parameters should accept whatever shape the requested type expects');
    assert(!definition.input_schema.properties.parameters.properties,
      'parameters must not be pinned to one type\'s shape (file\'s, or any other\'s)');
    assert(!definition.input_schema.properties.config, 'persisted pin config must not be public input');
  });

  await test('the description names every installed type, with file last', () => {
    const [definition] = PinToPinboardContextItem.getToolDefinitions();
    const bullets = definition.description.split('\n').filter((line) => line.startsWith('- `'));
    const ids = bullets.map((line) => line.slice(3, line.indexOf('`', 3)));

    // A model can only pick a type it has been told about. When `file` was the
    // only one named, every request became a file pin — a `.cmajorpatch` included.
    assert(ids.includes('file'), 'the description should name the file type');
    assert(ids.includes('plan') && ids.includes('git'),
      'the description should name the types that are not file, or the model cannot choose them');
    assert(ids[ids.length - 1] === 'file',
      'file is the fallback and must be listed last, so a narrower type is read first');

    assert(/`path`\s*\(string, required\)/.test(definition.description),
      'each type should carry its own parameters, not a shared prose paragraph');
    assert(definition.description.includes('No parameters.'),
      'a type that takes nothing should say so, rather than leaving the model to guess');
  });

  await test('validation dispatches to the selected type', async () => {
    assert(!(await item.validate({ type: '', parameters: { url: 'http://localhost:3000' } })).valid,
      'a missing type should be rejected');
    assert(!(await item.validate({ type: 'not-installed-here', parameters: 'not-an-object' })).valid,
      'a type\'s parameters must still be an object');
    const generic = await item.validate({ type: 'not-installed-here', parameters: { url: 'http://localhost:3000' } });
    assert(generic.valid, 'a type installed after the catalog was read should still be accepted');
    assert(generic.params?.parameters?.url === 'http://localhost:3000',
      'a type with no descriptor should have its parameters forwarded unchanged');
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

  // A type with no descriptor: the id is deliberately one no extension can install,
  // so this stays the "unknown type" path on a machine with extra extensions.
  await test('execute forwards an undescribed type\'s own parameters as its config', async () => {
    const originalFetch = globalThis.fetch;
    /** @type {any} */
    let requestBody = null;
    globalThis.fetch = /** @type {any} */ (async (_url, options) => {
      requestBody = JSON.parse(options.body);
      const op = requestBody.operations[0];
      return { ok: true, json: async () => ({ pins: [{ id: op.id, type: op.type, config: op.config }] }) };
    });
    try {
      const result = await item.execute({ type: 'not-installed-here', parameters: { thing: 'synths/pluck' } });
      assert(requestBody.operations[0].type === 'not-installed-here', 'a type with no descriptor should still be selected');
      assert(requestBody.operations[0].config.thing === 'synths/pluck',
        'that type\'s own parameters should reach it unexamined — its normalizeConfig validates them, not this tool');
      assert(requestBody.operations[0].config.agentRequested === true,
        'an undescribed type\'s pin should still be marked as agent-requested');
      assert(result.type === 'not-installed-here', 'execute should report back the requested type');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  return { passed, failed, errors };
}
