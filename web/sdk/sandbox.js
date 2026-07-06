//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/sandbox` — host-provided sandboxed code execution.
 *
 * `runInSandbox(code, { capabilities, timeoutMs })` runs an untrusted
 * JavaScript string in an isolated iframe (opaque origin, no DOM access to the
 * host page) and returns its result. Caller-supplied capabilities are exposed
 * to the code as named bindings and serviced over a MessagePort on the host
 * side; the sandbox also injects the built-ins `path` and `projectRoot`. Lets
 * an extension run dynamic code without weakening the host page's CSP.
 */
export { runInSandbox } from './lib/sandbox-runner.js';
