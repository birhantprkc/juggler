//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: explore_code Tool
 *
 * Tests explore_code through the full pipeline: sendMessage → worker → mock LLM → tool execution → Yjs sync.
 * Verifies that fs, path, grep, glob all work, and that errors are correctly reported.
 * @module integration-tests/explore-code-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

/**
 * Helper to build a standard explore_code test definition.
 * @param {string} name - Test name
 * @param {string} description - Test description
 * @param {string} code - JavaScript code to execute
 * @param {string} expectedContent - Expected tool result content
 * @param {boolean} isError - Whether the result should be an error
 * @returns {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} Test definition
 */
function exploreTest(name, description, code, expectedContent, isError = false) {
  return {
    name,
    description,
    fixture: 'unit-test-fixture',
    llmResponses: [
      toolUseResponse('call_1', 'explore_code', { code }, 'Running code.'),
      textResponse('Done.')
    ],
    operations: [
      { type: 'send-message', message: description }
    ],
    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: description },
        { type: 'assistant', content: 'Running code.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'explore_code',
          toolInput: { code },
          state: 'completed',
          result: { content: expectedContent, isError }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    }
  };
}

// ============================================================================
// TESTS: Consolidated into 4 representative tests
// ============================================================================

export const tests = [
  // fs.readFile — representative of all fs read helpers
  exploreTest(
    'explore-readFile',
    'explore_code: fs.readFile returns file content',
    'const c = await fs.readFile("src/main.go");\nreturn c.includes("Hello, World!") ? "found" : "not found";',
    'found'
  ),

  // grep + glob — search helpers
  exploreTest(
    'explore-grep',
    'explore_code: grep finds matches',
    'const r = await grep("func main");\nreturn r.length > 0 ? "matches found" : "no matches";',
    'matches found'
  ),

  // glob({ cwd }) should match Node-style fs.glob semantics: returned paths
  // are relative to cwd, so joining them back onto cwd must not duplicate the
  // absolute project root.
  exploreTest(
    'explore-glob-cwd-relative',
    'explore_code: glob with absolute cwd returns relative paths',
    'const files = await glob("src/*.go", { cwd: projectRoot });\nconst f = files.find((x) => x === "src/main.go");\nif (!f) return JSON.stringify(files);\nconst c = await fs.readFile(path.join(projectRoot, f));\nreturn c.includes("Hello, World!") ? "relative" : "bad read";',
    'relative'
  ),

  // Read-only: writeFile blocked
  exploreTest(
    'explore-write-blocked',
    'explore_code: fs.writeFile throws EROFS',
    'await fs.writeFile("hack.txt", "pwned");',
    'EROFS: read-only filesystem',
    true
  ),

  // Runtime error: ENOENT
  exploreTest(
    'explore-runtime-enoent',
    'explore_code: ENOENT error reported',
    'return await fs.readFile("nonexistent-file.txt");',
    'ENOENT: no such file or directory: nonexistent-file.txt',
    true
  ),

  // Parse-time errors in user code should report the real syntax error, not
  // hang until the sandbox timeout fires. This mirrors an LLM mistake where it
  // redeclares an injected binding (`fs`) with `const fs = require(...)`.
  exploreTest(
    'explore-parse-error',
    'explore_code: parse error reported without timeout',
    'const fs = require("fs/promises");\nreturn "unreachable";',
    'Cannot declare a const variable twice: \'fs\'.',
    true
  ),

  // Absolute-path import: an LLM-natural `import('/abs/path/web/...')`
  // must resolve. The sandbox's import map rewrites the project-root
  // prefix to /v<ver>/, served same-origin with ACAO=*. Without the
  // rewrite this throws "Cross-origin script load denied".
  exploreTest(
    'explore-absolute-path-import',
    'explore_code: can import() absolute project paths',
    'const m = await import(`${projectRoot}/web/js/model/model-config.js`);\nreturn typeof m.resolveConfig === "function" ? "ok" : "missing-export";',
    'ok'
  ),

  // Sandbox isolation: the untrusted code runs in a nested worker spawned by
  // the opaque-origin sandbox iframe, so the worker INHERITS that opaque
  // origin. That is what denies it the backend: its security origin is
  // "null", it has no window/document, and a fetch to the backend fails.
  // This is a tight regression guard — if the code ever ran in the privileged
  // engine worker instead, self.location.origin would be the real http origin
  // (and the fetch would reach the backend); if it ran in the main page,
  // `window` would be defined. Either fallback fails this assertion loudly.
  exploreTest(
    'explore-sandbox-isolation',
    'explore_code: runs in an opaque-origin worker with no backend access',
    'const origin = (self.location && self.location.origin) || "none";\nlet net;\ntry { await fetch(origin + "/api/health"); net = "reached"; } catch (_) { net = "blocked"; }\nreturn `origin=${origin};window=${typeof window};document=${typeof document};net=${net}`;',
    'origin=null;window=undefined;document=undefined;net=blocked'
  ),

  // Capability-mediated access works while the same script's DIRECT backend
  // access is denied: fs.readFile (serviced on the host over the MessagePort)
  // returns real content, but a direct fetch of that same file off the backend
  // is blocked by the worker's opaque origin. Proves the only way out is the
  // mediated channel.
  exploreTest(
    'explore-capability-vs-direct',
    'explore_code: capability works, direct backend access blocked',
    'const c = await fs.readFile("src/main.go");\nconst cap = c.includes("Hello, World!") ? "ok" : "no";\nlet direct;\ntry { await fetch("/api/completions/files?q=main"); direct = "reached"; } catch (_) { direct = "blocked"; }\nreturn `cap=${cap};direct=${direct}`;',
    'cap=ok;direct=blocked'
  ),
];
