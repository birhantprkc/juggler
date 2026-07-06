//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * engineApi semver parity test.
 *
 * `satisfiesEngineApi` (JS, web/sdk/version.js) and `SatisfiesEngineAPI` (Go,
 * cmd/juggler/extmanifest) are parallel implementations of the same range check.
 * Both consume this ONE fixture (web/js-tests/fixtures/engineapi-vectors.json);
 * if either implementation drifts, its test fails. This is the JS half.
 * @module unit-tests/engineapi-vectors-test
 */

import { satisfiesEngineApi } from '../../sdk/version.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  try {
    // Resolve the fixture relative to this module's served URL so the test is
    // agnostic to the version-prefixed static path.
    const url = new URL('../fixtures/engineapi-vectors.json', import.meta.url);
    const res = await fetch(url);
    assert(res.ok, `failed to fetch shared vector fixture: HTTP ${res.status}`);
    /** @type {Array<{range: string, version: string, want: boolean}>} */
    const vectors = await res.json();
    assert(Array.isArray(vectors) && vectors.length > 0, 'shared vector fixture is empty');

    for (const v of vectors) {
      const got = satisfiesEngineApi(v.range, v.version);
      if (got === v.want) {
        passed++;
      } else {
        failed++;
        errors.push(`satisfiesEngineApi(${JSON.stringify(v.range)}, ${JSON.stringify(v.version)}) = ${got}, want ${v.want}`);
      }
    }
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`engineapi-vectors: ${e?.message ?? e}`);
  }

  return { passed, failed, errors };
}
