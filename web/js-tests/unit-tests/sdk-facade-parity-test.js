//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * SDK worker-façade parity unit test.
 *
 * Several `juggler/*` SDK specifiers resolve to *two* modules: the browser
 * façade used by viewers (via the document import map) and a `*-worker.js` twin
 * used by the engine worker (which can't use the import map, so
 * `serveWorkerModule` rewrites the specifier — see
 * `cmd/juggler/server/worker_module.go`). A plugin importing a symbol from such
 * a specifier resolves against `ui.js` in a viewer but `ui-worker.js` in the
 * engine.
 *
 * The invariant: **the worker twin must export every name its browser façade
 * does.** If a symbol is added to the browser façade but not mirrored into the
 * twin, the module still loads fine in every viewer-path test — but the engine
 * worker throws `does not provide an export named '…'` at import time, the
 * offending context item is silently dropped from the registry, and the LLM's
 * tool call comes back as "Unknown tool: …". (This is exactly how a
 * `createHighlightedCode` export added only to `ui.js` broke `bash`.)
 *
 * Mirror a symbol as a real re-export when it's worker-safe (pure, DOM-free),
 * or as a throwing `domUnavailable` stub when it needs the DOM — either way the
 * export name must exist so the import resolves.
 * @module unit-tests/sdk-facade-parity-test
 */

import { assert } from '../utilities/test-helpers.js';
import * as uiBrowser from '../../sdk/ui.js';
import * as uiWorker from '../../sdk/ui-worker.js';
import * as itemUtilsBrowser from '../../sdk/item-utils.js';
import * as itemUtilsWorker from '../../sdk/item-utils-worker.js';

// Keep in sync with the `*-worker.js` entries of `workerSDKImports` in
// cmd/juggler/server/worker_module.go — those are the specifiers with a twin.
const FACADE_PAIRS = [
  { specifier: 'juggler/ui', browser: uiBrowser, worker: uiWorker },
  { specifier: 'juggler/item-utils', browser: itemUtilsBrowser, worker: itemUtilsWorker },
];

/**
 * Public export names of a module namespace, minus the synthetic `default`.
 * @param {object} mod - A `import * as` namespace object
 * @returns {string[]} Named exports
 */
function exportNames(mod) {
  return Object.keys(mod).filter((k) => k !== 'default');
}

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  for (const { specifier, browser, worker } of FACADE_PAIRS) {
    run(`${specifier}: worker twin mirrors every browser-façade export`, () => {
      const workerExports = new Set(exportNames(worker));
      const missing = exportNames(browser).filter((name) => !workerExports.has(name));
      const twin = specifier.replace('juggler/', 'sdk/') + '-worker.js';
      assert(
        missing.length === 0,
        `${twin} is missing exports present in its browser façade: ${missing.join(', ')}. `
        + `Add each to ${twin} (real re-export if worker-safe, else a throwing domUnavailable stub) `
        + `or plugins importing it fail to load in the engine worker.`,
      );
    });
  }

  return { passed, failed, errors };
}
