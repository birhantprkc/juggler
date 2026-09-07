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
 *
 * The invariant holds in both directions: a symbol only the *worker* twin
 * exports fails the other way round — it works in the engine and throws in
 * every viewer — which no viewer-path test would catch either.
 *
 * Export names are not the whole contract. Where both sides implement the same
 * pure helper independently, they must also agree on its *output*: an escaper
 * that strips one character set in a viewer and another in the engine is a
 * security-relevant split behind a single specifier.
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

// Pure helpers a plugin may call through `juggler/ui` in either realm. Each
// must return the same string whichever façade resolved it.
const SHARED_STRING_HELPERS = ['escapeHtml', 'escapeAttr', 'escapeJsonContent'];

// Inputs chosen to expose the ways two escapers can disagree: the quote
// characters that make an attribute injectable, a bare ampersand, and the
// nullish cases each implementation guards separately.
const ESCAPER_INPUTS = [
  '<script>alert("x")</script>',
  `it's a "quoted" & <tagged> value`,
  'plain text',
  '',
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
    const facade = specifier.replace('juggler/', 'sdk/') + '.js';
    const twin = specifier.replace('juggler/', 'sdk/') + '-worker.js';

    run(`${specifier}: worker twin mirrors every browser-façade export`, () => {
      const workerExports = new Set(exportNames(worker));
      const missing = exportNames(browser).filter((name) => !workerExports.has(name));
      assert(
        missing.length === 0,
        `${twin} is missing exports present in its browser façade: ${missing.join(', ')}. `
        + `Add each to ${twin} (real re-export if worker-safe, else a throwing domUnavailable stub) `
        + `or plugins importing it fail to load in the engine worker.`,
      );
    });

    run(`${specifier}: browser façade mirrors every worker-twin export`, () => {
      const browserExports = new Set(exportNames(browser));
      const missing = exportNames(worker).filter((name) => !browserExports.has(name));
      assert(
        missing.length === 0,
        `${facade} is missing exports present in its worker twin: ${missing.join(', ')}. `
        + `Add each to ${facade} or plugins importing it load in the engine worker and `
        + `fail in every viewer.`,
      );
    });

    for (const name of SHARED_STRING_HELPERS) {
      const browserFn = /** @type {any} */ (browser)[name];
      const workerFn = /** @type {any} */ (worker)[name];
      if (typeof browserFn !== 'function' || typeof workerFn !== 'function') continue;

      run(`${specifier}: ${name} agrees across realms`, () => {
        for (const input of ESCAPER_INPUTS) {
          const fromBrowser = browserFn(input);
          const fromWorker = workerFn(input);
          assert(
            fromBrowser === fromWorker,
            `${name}(${JSON.stringify(input)}) is ${JSON.stringify(fromBrowser)} via ${facade} `
            + `but ${JSON.stringify(fromWorker)} via ${twin}. One specifier, one output — `
            + `both sides must resolve to the same implementation.`,
          );
        }
      });
    }
  }

  return { passed, failed, errors };
}
