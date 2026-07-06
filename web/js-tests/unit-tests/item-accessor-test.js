//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Item Accessor Unit Test
 *
 * Tests plainToYMap and convertToYType functionality.
 * Verifies Y.Map creation, nested CRDT types, and property access via .get().
 * @module unit-tests/item-accessor-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run item accessor tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const Y = await import('../../js/vendor/yjs.mjs');
  const { plainToYMap, convertToYType } = await import('../../js/model/item-accessor.js');

  // Test: plainToYMap creates a Y.Map from a plain object
  try {
    const obj = { type: 'user', content: 'hello', itemId: 'msg_1' };
    const ymap = plainToYMap(obj);
    assert(ymap instanceof Y.Map, 'plainToYMap should return Y.Map');

    // Need to integrate into a doc for .get() to work
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    arr.push([ymap]);

    const retrieved = arr.get(0);
    assert(retrieved instanceof Y.Map, 'Retrieved item should be Y.Map');
    assert(retrieved.get('type') === 'user', `Expected type 'user', got '${retrieved.get('type')}'`);
    assert(retrieved.get('content') === 'hello', `Expected content 'hello'`);
    assert(retrieved.get('itemId') === 'msg_1', `Expected itemId 'msg_1'`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`plainToYMap: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: Y.Map .get()/.set() native API works correctly
  try {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const ymap = new Y.Map();
    arr.push([ymap]);

    const integrated = arr.get(0);
    integrated.set('type', 'assistant');
    integrated.set('content', 'world');
    integrated.set('itemId', 'msg_2');

    assert(integrated.get('type') === 'assistant', `Expected type 'assistant', got '${integrated.get('type')}'`);
    assert(integrated.get('content') === 'world', `Expected content 'world'`);
    assert(integrated.get('itemId') === 'msg_2', `Expected itemId 'msg_2'`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`Y.Map get/set: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: Y.Map .toJSON() produces plain object
  try {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const ymap = new Y.Map();
    arr.push([ymap]);

    const integrated = arr.get(0);
    integrated.set('type', 'user');
    integrated.set('content', 'json test');

    const json = integrated.toJSON();
    assert(json.type === 'user', `JSON type should be 'user'`);
    assert(json.content === 'json test', `JSON content should be 'json test'`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`Y.Map toJSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: plainToYMap with nested objects creates nested Y.Map
  try {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const obj = { type: 'tool-action', result: { content: 'test', isError: false } };
    const ymap = plainToYMap(obj);
    arr.push([ymap]);

    const retrieved = arr.get(0);
    assert(retrieved instanceof Y.Map, 'Retrieved should be Y.Map');
    assert(retrieved.get('type') === 'tool-action', `Expected type 'tool-action'`);
    const result = retrieved.get('result');
    // Nested objects are stored as Y.Map (full CRDT)
    assert(result instanceof Y.Map, 'Nested result should be Y.Map');
    assert(result.get('content') === 'test', `Nested content should be 'test'`);
    assert(result.get('isError') === false, `Nested isError should be false`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`plainToYMap nested: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: convertToYType with arrays creates Y.Array
  try {
    const doc = new Y.Doc();
    const arr = doc.getArray('items');
    const ymap = new Y.Map();
    arr.push([ymap]);

    const integrated = arr.get(0);
    const yarr = convertToYType(['a', 'b', 'c']);
    integrated.set('tags', yarr);

    const tags = integrated.get('tags');
    assert(tags instanceof Y.Array, 'Array should become Y.Array');
    assert(tags.length === 3, `Expected 3 items, got ${tags.length}`);
    assert(tags.get(0) === 'a', `Expected first item 'a'`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(`convertToYType array: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: convertToYType passes through primitives
  try {
    assert(convertToYType('hello') === 'hello', 'String should pass through');
    assert(convertToYType(42) === 42, 'Number should pass through');
    assert(convertToYType(true) === true, 'Boolean should pass through');
    assert(convertToYType(null) === null, 'Null should pass through');
    assert(convertToYType(undefined) === undefined, 'Undefined should pass through');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`convertToYType primitives: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test: convertToYType passes through existing Y.Map/Y.Array
  try {
    const existingMap = new Y.Map();
    const existingArr = new Y.Array();
    assert(convertToYType(existingMap) === existingMap, 'Existing Y.Map should pass through');
    assert(convertToYType(existingArr) === existingArr, 'Existing Y.Array should pass through');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`convertToYType passthrough: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
