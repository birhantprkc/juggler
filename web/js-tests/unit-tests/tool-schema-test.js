//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Schema conformance for every tool the registry advertises.
 *
 * A tool schema is only read by machines, and every one of them is lenient
 * until the last: a malformed schema is still valid JSON, so it crosses the
 * registry, the worker and the provider without complaint and is refused only
 * where the model is finally offered its tools. Some providers refuse the whole
 * payload rather than the one entry, which turns a single mistyped definition
 * into an agent with no tools at all — and the resulting behaviour (a model
 * narrating tool calls in prose) names neither the tool nor the keyword.
 *
 * So this suite asserts the whole catalogue at once rather than any one tool:
 *   1. every schema is an object schema, with `type: 'object'` present;
 *   2. `properties` is declared and is an object;
 *   3. every name in `required` actually appears in `properties`;
 *   4. every parameter declares its own `type`.
 *
 * New tools are covered the moment they are registered — there is no list here
 * to keep in step with the registry.
 * @module unit-tests/tool-schema
 */

import { assert } from '../utilities/test-helpers.js';
import { generateToolDefinitions } from '../../js/services/tool-generator.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Collect every way a single tool definition departs from the schema contract.
 * Returns one message per fault, prefixed with the tool name so a failure says
 * which definition to open.
 * @param {{name?: string, input_schema?: unknown}} tool - One generated tool definition
 * @returns {string[]} Faults found; empty when the definition conforms
 */
function schemaFaults(tool) {
  const name = tool?.name || '<unnamed>';
  /** @type {string[]} */
  const faults = [];
  const schema = /** @type {Record<string, any>} */ (tool?.input_schema);

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${name}: input_schema is missing or not an object`];
  }
  if (schema.type !== 'object') {
    faults.push(`${name}: input_schema.type is ${JSON.stringify(schema.type)}, want "object"`);
  }

  const props = schema.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    faults.push(`${name}: input_schema.properties is missing or not an object`);
    return faults;
  }

  for (const [param, spec] of Object.entries(props)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      faults.push(`${name}.${param}: parameter schema is not an object`);
      continue;
    }
    if (typeof (/** @type {Record<string, any>} */ (spec).type) !== 'string') {
      faults.push(`${name}.${param}: parameter declares no "type"`);
    }
  }

  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      faults.push(`${name}: input_schema.required is not an array`);
    } else {
      for (const req of required) {
        if (!Object.prototype.hasOwnProperty.call(props, req)) {
          faults.push(`${name}: required lists "${req}", which is absent from properties`);
        }
      }
    }
  }

  return faults;
}

/**
 * Run tool-schema tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // =========================================================================
  // Test 1: the registry advertises tools at all.
  //
  // Asserted separately because an empty catalogue would vacuously satisfy
  // every per-tool check below — the exact failure this suite exists to catch.
  // =========================================================================
  /** @type {Array<{name?: string, input_schema?: unknown}>} */
  let tools = [];
  try {
    tools = /** @type {Array<{name?: string, input_schema?: unknown}>} */ (
      await generateToolDefinitions()
    );
    assert(tools.length > 0, 'registry should advertise at least one tool');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`tool generation: ${e instanceof Error ? e.message : String(e)}`);
    return { passed, failed, errors };
  }

  // =========================================================================
  // Test 2: every advertised schema conforms.
  //
  // Reported as one assertion listing every offender, so a sweep that breaks
  // several tools shows them all in a single run rather than one per re-run.
  // =========================================================================
  try {
    const faults = tools.flatMap(schemaFaults);
    assert(faults.length === 0,
      `malformed tool schemas:\n  ${faults.join('\n  ')}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // =========================================================================
  // Test 3: tool names are unique.
  //
  // Duplicates resolve by whichever definition the provider happens to keep,
  // so the loser's item is unreachable while still appearing registered.
  // =========================================================================
  try {
    const seen = new Set();
    const dupes = new Set();
    for (const t of tools) {
      const n = t?.name || '<unnamed>';
      if (seen.has(n)) dupes.add(n);
      seen.add(n);
    }
    assert(dupes.size === 0, `duplicate tool names: ${[...dupes].join(', ')}`);
    passed++;
  } catch (e) {
    failed++;
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return { passed, failed, errors };
}
