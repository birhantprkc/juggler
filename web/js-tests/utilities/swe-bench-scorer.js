//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import logger from './test-logger.js';

/**
 * SWE-bench Scorer - Implements scoring logic for SWE-bench tasks
 *
 * Validates that:
 * 1. All fail-to-pass tests now pass (were failing before, passing after fix)
 * 2. All pass-to-pass tests still pass (no regressions)
 * @typedef {object} SWEBenchScoring
 * @property {string} type - Must be "swe_bench_validation"
 * @property {string[]} fail_to_pass - Tests that should fail initially, pass after fix
 * @property {string[]} pass_to_pass - Tests that must remain passing (no regressions)
 * @property {string} test_command - Command template to run tests (e.g., "python -m pytest {test_path} -xvs")
 * @property {number} [timeout] - Timeout in seconds (default: 300)
 */

/**
 * @typedef {object} SWEBenchTaskDef
 * @property {string} id - Task ID
 * @property {SWEBenchScoring} scoring - Scoring configuration
 */

/**
 * @typedef {object} TestResult
 * @property {boolean} passed - Whether all tests passed
 * @property {number} passed_count - Number of tests that passed
 * @property {number} failed_count - Number of tests that failed
 * @property {string} output - Test execution output
 * @property {string[]} failed_tests - List of failed test names
 */

/**
 * SWE-bench Scorer
 * @class
 */
class SWEBenchScorer {
  /**
   * @param {SWEBenchTaskDef} taskDef - Task definition with SWE-bench scoring config
   * @param {string} fixtureDir - Path to git fixture directory
   */
  constructor(taskDef, fixtureDir) {
    /** @type {SWEBenchTaskDef} @private */
    this.task = taskDef;

    /** @type {string} @private */
    this.fixtureDir = fixtureDir;

    /** @type {SWEBenchScoring} @private */
    this.scoring = taskDef.scoring;
  }

  /**
   * Score the SWE-bench task
   * @returns {Promise<{score: number, details: string}>} The score result with score (0.0-1.0) and details
   */
  async score() {
    logger.info(`[SWEBenchScorer] Scoring task: ${this.task.id}`);
    logger.debug(`[SWEBenchScorer] Fail-to-pass tests: ${this.scoring.fail_to_pass?.length || 0}`);
    logger.debug(`[SWEBenchScorer] Pass-to-pass tests: ${this.scoring.pass_to_pass?.length || 0}`);

    try {
      // Run fail-to-pass tests
      const failToPassResult = await this.runTests(this.scoring.fail_to_pass || []);
      logger.info(`[SWEBenchScorer] Fail-to-pass result: ${failToPassResult.passed_count}/${this.scoring.fail_to_pass?.length || 0}`);

      // Run pass-to-pass tests
      const passToPassResult = await this.runTests(this.scoring.pass_to_pass || []);
      logger.info(`[SWEBenchScorer] Pass-to-pass result: ${passToPassResult.passed_count}/${this.scoring.pass_to_pass?.length || 0}`);

      // Calculate score
      const failToPassPassed = failToPassResult.passed;
      const passToPassPassed = passToPassResult.passed;

      if (failToPassPassed && passToPassPassed) {
        return {
          score: 1.0,
          details: `✅ All tests passed!\n` +
                            `- Fail-to-pass: ${failToPassResult.passed_count}/${this.scoring.fail_to_pass?.length || 0} passed\n` +
                            `- Pass-to-pass: ${passToPassResult.passed_count}/${this.scoring.pass_to_pass?.length || 0} passed\n` +
                            `\nTask resolved successfully!`
        };
      } else {
        const details = [];

        if (!failToPassPassed) {
          details.push(`❌ Fail-to-pass: ${failToPassResult.passed_count}/${this.scoring.fail_to_pass?.length || 0} passed`);
          if (failToPassResult.failed_tests.length > 0) {
            details.push(`   Failed: ${failToPassResult.failed_tests.slice(0, 5).join(', ')}`);
          }
        }

        if (!passToPassPassed) {
          details.push(`❌ Pass-to-pass: ${passToPassResult.passed_count}/${this.scoring.pass_to_pass?.length || 0} passed (REGRESSIONS!)`);
          if (passToPassResult.failed_tests.length > 0) {
            details.push(`   Regressions: ${passToPassResult.failed_tests.slice(0, 5).join(', ')}`);
          }
        }

        return {
          score: 0.0,
          details: details.join('\n')
        };
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[SWEBenchScorer] Error during scoring: ${errorMsg}`);
      return {
        score: 0.0,
        details: `Error during scoring: ${errorMsg}`
      };
    }
  }

  /**
   * Run a list of tests
   * @param {string[]} tests - List of test paths (e.g., ["tests/test_foo.py::test_bar"])
   * @returns {Promise<TestResult>} The test result with pass/fail counts and output
   * @private
   */
  async runTests(tests) {
    if (!tests || tests.length === 0) {
      return {
        passed: true,
        passed_count: 0,
        failed_count: 0,
        output: '',
        failed_tests: []
      };
    }

    // Split large test lists into batches to avoid command length limits
    // Max command length is 10000 chars, estimate ~100 chars per test path
    const maxTestsPerBatch = 50;

    if (tests.length > maxTestsPerBatch) {
      logger.info(`[SWEBenchScorer] Splitting ${tests.length} tests into batches of ${maxTestsPerBatch}`);
      return await this.runTestsInBatches(tests, maxTestsPerBatch);
    }

    // Run tests via shell context item
    const testCommand = this.buildTestCommand(tests);
    const timeout = this.scoring.timeout || 300;

    logger.debug(`[SWEBenchScorer] Running command: ${testCommand}`);

    try {
      const result = await this.executeCommand(testCommand, timeout);
      return this.parseTestOutput(result.output, tests);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[SWEBenchScorer] Test execution error: ${errorMsg}`);
      return {
        passed: false,
        passed_count: 0,
        failed_count: tests.length,
        output: errorMsg,
        failed_tests: tests
      };
    }
  }

  /**
   * Run tests in batches to avoid command length limits
   * @param {string[]} tests - List of test paths
   * @param {number} batchSize - Number of tests per batch
   * @returns {Promise<TestResult>} The combined test result across all batches
   * @private
   */
  async runTestsInBatches(tests, batchSize) {
    const batches = [];
    for (let i = 0; i < tests.length; i += batchSize) {
      batches.push(tests.slice(i, i + batchSize));
    }

    logger.info(`[SWEBenchScorer] Running ${batches.length} batches of tests`);

    let totalPassedCount = 0;
    let totalFailedCount = 0;
    const allFailedTests = [];
    let combinedOutput = '';

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.debug(`[SWEBenchScorer] Running batch ${i + 1}/${batches.length} (${batch.length} tests)`);

      const testCommand = this.buildTestCommand(batch);
      const timeout = this.scoring.timeout || 300;

      try {
        const result = await this.executeCommand(testCommand, timeout);
        const batchResult = this.parseTestOutput(result.output, batch);

        totalPassedCount += batchResult.passed_count;
        totalFailedCount += batchResult.failed_count;
        allFailedTests.push(...batchResult.failed_tests);
        combinedOutput += `\n=== Batch ${i + 1}/${batches.length} ===\n${result.output}\n`;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[SWEBenchScorer] Batch ${i + 1} execution error: ${errorMsg}`);

        // Mark all tests in this batch as failed
        totalFailedCount += batch.length;
        allFailedTests.push(...batch);
        combinedOutput += `\n=== Batch ${i + 1}/${batches.length} FAILED ===\n${errorMsg}\n`;
      }
    }

    return {
      passed: totalFailedCount === 0,
      passed_count: totalPassedCount,
      failed_count: totalFailedCount,
      output: combinedOutput,
      failed_tests: allFailedTests
    };
  }

  /**
   * Build test command from test list
   * @param {string[]} tests - List of test paths
   * @returns {string} The complete test command with test paths substituted
   * @private
   */
  buildTestCommand(tests) {
    // Use the test_command template from scoring config
    let cmd = this.scoring.test_command || 'python -m pytest {test_path} -xvs';

    // Join all test paths
    const testPaths = tests.join(' ');

    // Replace {test_path} placeholder
    cmd = cmd.replace('{test_path}', testPaths);

    return cmd;
  }

  /**
   * Execute a command in the fixture directory
   * @param {string} command - Command to execute
   * @param {number} timeout - Timeout in seconds
   * @returns {Promise<{output: string, exitCode: number}>} The command output and exit code
   * @private
   */
  async executeCommand(command, timeout) {
    // Use shell context item API to execute command
    const response = await fetch('/api/ops/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolId: 'python',
        operation: 'execute',
        params: {
          command: command,
          cwd: this.fixtureDir,
          timeout: timeout * 1000 // Convert to milliseconds
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to execute command: ${response.statusText}`);
    }

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'Command execution failed');
    }

    // Combine stdout and stderr for complete output
    const stdout = result.data.stdout || '';
    const stderr = result.data.stderr || '';
    const combinedOutput = stdout + (stderr ? '\n' + stderr : '');

    return {
      output: combinedOutput,
      exitCode: result.data.exitCode || 0
    };
  }

  /**
   * Parse pytest output to determine which tests passed/failed
   * @param {string} output - Test execution output
   * @param {string[]} expectedTests - List of tests that were run
   * @returns {TestResult} The parsed test results with pass/fail counts
   * @private
   */
  parseTestOutput(output, expectedTests) {
    // Parse pytest output
    // Look for patterns like:
    // - "PASSED" for passing tests
    // - "FAILED" for failing tests
    // - "1 passed" or "5 passed, 2 failed" in summary

    const lines = output.split('\n');
    const failedTests = [];
    let passedCount = 0;
    let failedCount = 0;

    // Try to parse summary line (e.g., "5 passed, 2 failed in 1.23s")
    const summaryMatch = output.match(/(\d+)\s+passed/);
    if (summaryMatch) {
      passedCount = parseInt(summaryMatch[1], 10);
    }

    const failedMatch = output.match(/(\d+)\s+failed/);
    if (failedMatch) {
      failedCount = parseInt(failedMatch[1], 10);
    }

    // Parse individual test results
    for (const line of lines) {
      if (line.includes('FAILED')) {
        // Extract test name from line like "tests/test_foo.py::test_bar FAILED"
        const testMatch = line.match(/([^\s]+)\s+FAILED/);
        if (testMatch) {
          failedTests.push(testMatch[1]);
        }
      }
    }

    // If we couldn't parse summary, count from expected tests
    if (passedCount === 0 && failedCount === 0) {
      passedCount = expectedTests.length - failedTests.length;
      failedCount = failedTests.length;
    }

    return {
      passed: failedCount === 0,
      passed_count: passedCount,
      failed_count: failedCount,
      output: output,
      failed_tests: failedTests
    };
  }
}

export default SWEBenchScorer;
