//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the shared clipboard helper.
 *
 * The behavioural property under test is the one that broke copy buttons in
 * browser tabs on the LAN: in an *insecure context* there is no
 * `navigator.clipboard`, so copying must fall back to the legacy
 * `execCommand('copy')` path — and only when that ALSO fails should it throw,
 * with a message that names the real cause (insecure origin) rather than a
 * generic "failed to copy".
 *
 * We exercise the logic by stubbing `navigator.clipboard`,
 * `document.execCommand`, and `window.isSecureContext`, so the test is
 * deterministic regardless of the context the harness itself runs in.
 * @module unit-tests/clipboard-test
 */

import {
  copyToClipboard,
  clipboardUnavailableMessage,
} from '../../sdk/lib/clipboard.js';

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Install a temporary override for a property, returning a restore function.
 * Handles read-only accessor props (like navigator.clipboard) via
 * defineProperty.
 * @param {object} obj - Target object.
 * @param {string} prop - Property name.
 * @param {*} value - Stub value.
 * @returns {() => void} Restore function.
 */
function override(obj, prop, value) {
  const had = Object.prototype.hasOwnProperty.call(obj, prop);
  const prev = Object.getOwnPropertyDescriptor(obj, prop);
  Object.defineProperty(obj, prop, { value, configurable: true, writable: true });
  return () => {
    if (prev) Object.defineProperty(obj, prop, prev);
    else if (had) { /* unreachable */ }
    else delete (/** @type {any} */ (obj))[prop];
  };
}

/**
 * Run the clipboard test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];
  const tally = (n) => { if (n) passed += n; else failed += 1; };

  // === 1. Secure-context path: async Clipboard API is used. ===
  {
    let captured = null;
    const restore = override(navigator, 'clipboard', {
      writeText: async (t) => { captured = t; },
    });
    try {
      await copyToClipboard('hello-secure');
      tally(check(captured === 'hello-secure',
        'secure: should write via navigator.clipboard.writeText', errors));
    } catch (e) {
      tally(check(false, `secure: unexpected throw: ${e && e.message}`, errors));
    } finally {
      restore();
    }
  }

  // === 2. Insecure context (no navigator.clipboard): legacy fallback copies. ===
  {
    const restoreClip = override(navigator, 'clipboard', undefined);
    let execArg = null;
    const restoreExec = override(document, 'execCommand', (cmd) => {
      if (cmd === 'copy') { execArg = true; return true; }
      return false;
    });
    try {
      await copyToClipboard('hello-insecure');
      tally(check(execArg === true,
        'insecure: should fall back to execCommand("copy")', errors));
    } catch (e) {
      tally(check(false, `insecure: should NOT throw when legacy copy works: ${e && e.message}`, errors));
    } finally {
      restoreExec();
      restoreClip();
    }
  }

  // === 3. Async API present but rejects: still falls back to legacy. ===
  {
    const restoreClip = override(navigator, 'clipboard', {
      writeText: async () => { throw new Error('NotAllowedError'); },
    });
    let used = false;
    const restoreExec = override(document, 'execCommand', (cmd) => {
      if (cmd === 'copy') { used = true; return true; }
      return false;
    });
    try {
      await copyToClipboard('rejecting');
      tally(check(used === true,
        'reject: a rejecting writeText should fall through to the legacy path', errors));
    } catch (e) {
      tally(check(false, `reject: should recover via legacy path: ${e && e.message}`, errors));
    } finally {
      restoreExec();
      restoreClip();
    }
  }

  // === 4. Both paths fail: throws a descriptive, actionable Error. ===
  {
    const restoreClip = override(navigator, 'clipboard', undefined);
    const restoreExec = override(document, 'execCommand', () => false);
    const restoreSecure = override(window, 'isSecureContext', false);
    try {
      await copyToClipboard('doomed');
      tally(check(false, 'fail: should throw when no path succeeds', errors));
    } catch (e) {
      const msg = (e && e.message) || '';
      tally(check(msg.length > 0 && msg !== 'Failed to copy',
        'fail: error message must be specific, not the generic "Failed to copy"', errors));
      // Insecure origin → message must point at the real cause (http/https).
      tally(check(/https|secure|http/i.test(msg),
        'fail: insecure-context message should mention the secure-origin requirement', errors));
    } finally {
      restoreSecure();
      restoreExec();
      restoreClip();
    }
  }

  // === 5. clipboardUnavailableMessage is always a non-empty string. ===
  {
    const msg = clipboardUnavailableMessage();
    tally(check(typeof msg === 'string' && msg.length > 0,
      'message: clipboardUnavailableMessage should return a non-empty string', errors));
  }

  return { passed, failed, errors };
}
