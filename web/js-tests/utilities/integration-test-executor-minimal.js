//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Minimal Integration Test Executor - ONLY for duplicate-conversation test
 * Used for isolated testing to avoid browser crashes
 */

import { runIntegrationTests } from './integration-test-runner.js';
import { duplicateConversationTest } from '../integration-tests/multi-conversation-tests.js';
import './golden-comparator.js';
import logger from './test-logger.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory path
 */

/**
 * Run ONLY the duplicate conversation test
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(ctx) {
  logger.essential('Running duplicate-conversation test ONLY...');

  const { passed, failed, results } = await runIntegrationTests([duplicateConversationTest], ctx);

  /** @type {string[]} */
  const errors = [];
  for (const [name, result] of results) {
    if (!result.passed && result.error) {
      errors.push(`${name}: ${result.error}`);
    }
  }

  logger.essential(`\nResults: ${passed} passed, ${failed} failed`);

  return { passed, failed, errors };
}
