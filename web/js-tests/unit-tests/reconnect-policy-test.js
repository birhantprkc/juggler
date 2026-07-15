//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Reconnect-policy tests — the WebSocketService applies ONE generic reconnect
 * policy to every transport (WebSocket, WebRTC-LAN, juggler.studio): a dropped
 * link is detected, the service backs off, and it re-establishes via a single
 * transport-specific primitive (this._reestablish), looping until reconnected.
 *
 * These cases pin that uniformity directly on a throwaway WebSocketService:
 *   - any non-intentional transport death enters the shared backoff loop;
 *   - an intentional teardown or an expected failed-probe close does NOT;
 *   - the backoff timer fires whatever re-establish primitive the current
 *     transport installed (not a hardcoded socket reconnect);
 *   - studio's primitive reloads directly (its only recovery), throttled by
 *     the rate-limiter, and re-arms the same loop instead of storming when the
 *     reload is throttled or the link already recovered.
 * @module unit-tests/reconnect-policy-test
 */

import { assert } from '../utilities/test-helpers.js';
import { WebSocketService } from '../../js/services/websocket.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Capture the callback the next setTimeout schedules, without waiting on the
   * real backoff delay. Restores the global immediately so nothing else is
   * affected. Returns the captured callback (or null if none scheduled).
   * @param {() => void} fn - Code that is expected to schedule one setTimeout.
   * @returns {(() => void)|null} The captured callback, or null if none scheduled.
   */
  const captureScheduled = (fn) => {
    const orig = globalThis.setTimeout;
    /** @type {(() => void)|null} */
    let cb = null;
    // @ts-ignore - test stub
    globalThis.setTimeout = (/** @type {() => void} */ f) => { cb = f; return 0; };
    try {
      fn();
    } finally {
      globalThis.setTimeout = orig;
    }
    return cb;
  };

  /**
   * Count how many times a given wsService event fires while fn runs.
   * @param {WebSocketService} svc
   * @param {string} event
   * @param {() => void} fn
   * @returns {number} Number of times the event fired.
   */
  const countEvent = (svc, event, fn) => {
    let n = 0;
    const cb = () => { n++; };
    svc.on(/** @type {any} */ (event), cb);
    try {
      fn();
    } finally {
      svc.off(/** @type {any} */ (event), cb);
    }
    return n;
  };

  await run('non-intentional transport death enters the shared reconnect loop', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._reestablish = () => {}; // socket primitive stub
    let attempts = 0;
    let closes = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    svc.on('close', () => { closes++; });
    // A real link drop with no intentional/suppress flags set.
    svc._onTransportClosed(new Event('close'), null);
    // Stop the pending backoff timer from firing the stub after the test.
    svc._intentionalDisconnect = true;
    assert(svc.connected === false, 'link marked down on close');
    assert(closes === 1, `close emitted once; got ${closes}`);
    assert(attempts === 1, `entered the backoff loop (reconnect-attempt emitted); got ${attempts}`);
  });

  await run('intentional disconnect does NOT enter the reconnect loop', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._intentionalDisconnect = true;
    const attempts = countEvent(svc, 'reconnect-attempt', () => {
      svc._onTransportClosed(new Event('close'), null);
    });
    assert(attempts === 0, `intentional disconnect must not reconnect; got ${attempts} attempts`);
    assert(svc.connected === false, 'still marked down');
  });

  await run('expected failed-probe close skips reconnect and clears the suppress flag', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    svc._suppressNextCloseReconnect = true;
    const attempts = countEvent(svc, 'reconnect-attempt', () => {
      svc._onTransportClosed(new Event('close'), null);
    });
    assert(attempts === 0, `suppressed close must not reconnect; got ${attempts} attempts`);
    assert(svc._suppressNextCloseReconnect === false, 'suppress flag is consumed (one-shot)');
  });

  await run('backoff timer fires the current transport re-establish primitive', async () => {
    const svc = new WebSocketService();
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    const cb = captureScheduled(() => svc._reconnect());
    assert(cb, 'a backoff timer was scheduled');
    assert(reestablished === 0, 're-establish is deferred to the timer, not called synchronously');
    cb?.();
    assert(reestablished === 1, `timer invoked the transport primitive; got ${reestablished}`);
  });

  await run('death handler routes into the same loop that fires the primitive (generic policy)', async () => {
    const svc = new WebSocketService();
    svc.connected = true;
    let reestablished = 0;
    svc._reestablish = () => { reestablished++; };
    // Capture the timer scheduled by the death → _reconnect path.
    const cb = captureScheduled(() => svc._onTransportClosed(new Event('close'), null));
    assert(cb, 'transport death scheduled a backoff timer');
    cb?.();
    assert(reestablished === 1, `the death path drives the same re-establish primitive; got ${reestablished}`);
  });

  await run('studio re-establish reloads directly to recover (no health probe over the dead tunnel)', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true; // bypass the rate-limiter
    let reloaded = 0;
    let fetched = 0;
    svc._reloadPage = () => { reloaded++; };
    const origFetch = globalThis.fetch;
    // @ts-ignore - test stub: recovery must NOT depend on any fetch (it would be
    // tunneled through the dead DataChannel and 504 forever).
    globalThis.fetch = async () => { fetched++; return { ok: true }; };
    try {
      await svc._reloadWhenReachable();
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(reloaded === 1, `link death → reload to recover; got ${reloaded}`);
    assert(fetched === 0, `recovery must not probe the network (circular over studio); got ${fetched} fetches`);
  });

  await run('studio re-establish re-arms the loop instead of reloading when throttled', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => false; // rate-limiter says "too soon"
    let reloaded = 0;
    let rearmed = 0;
    svc._reloadPage = () => { reloaded++; };
    svc._reconnect = () => { rearmed++; };
    await svc._reloadWhenReachable();
    assert(reloaded === 0, 'must NOT reload while throttled (no reload storm)');
    assert(rearmed === 1, `throttled reload re-arms the same backoff loop; got ${rearmed}`);
  });

  await run('studio re-establish aborts cleanly if the link already recovered', async () => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true;
    svc.connected = true; // link came back before the primitive ran
    let reloaded = 0;
    let rearmed = 0;
    svc._reloadPage = () => { reloaded++; };
    svc._reconnect = () => { rearmed++; };
    await svc._reloadWhenReachable();
    assert(reloaded === 0, 'no reload once the link is already back');
    assert(rearmed === 0, 'no needless re-arm once connected');
  });

  return { passed, failed, errors };
}
