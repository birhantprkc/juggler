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
 *
 * The second half pins what a recovered link MEANS, which is the expensive
 * question. A viewer's reconnect is decided by the boot id the server puts in
 * its session message: unchanged, the same process is still there and the page
 * catches up over the live document; changed, the page was served by a process
 * that is gone — its token is refused and its cache-busted module URLs 404 —
 * and only a reload recovers. Reloading is the exception, and every route to
 * one is pinned here, including the ones with no boot id to compare.
 * @module unit-tests/reconnect-policy-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import wsService, { WebSocketService } from '../../js/services/websocket.js';

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

  /**
   * A stand-in for the transport, carrying the four handlers
   * _configureTransport installs plus a record of having been closed.
   * @returns {any} Fake transport.
   */
  const makeTransport = () => ({
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    closed: false,
    /** Record the close instead of touching a real socket. */
    close() { this.closed = true; },
    /** Swallow outbound frames. */
    send() { /* nothing listening */ }
  });

  /**
   * A viewer service whose socket has just reopened after a genuine drop, with
   * the 'open' event still withheld pending the session message.
   * @param {string|null} recordedBootId - The boot id this page recorded on its first connection.
   * @returns {{svc: WebSocketService, transport: any, reloads: () => number, opens: () => number}} Service under test and its counters.
   */
  const reconnecting = (recordedBootId) => {
    const svc = new WebSocketService();
    svc._shouldReloadOnReconnect = () => true; // the throttle has its own cases
    let reloaded = 0;
    let opened = 0;
    svc._reloadPage = () => { reloaded++; };
    svc.on('open', () => { opened++; });
    svc.serverBootId = recordedBootId;
    const transport = makeTransport();
    svc._configureTransport(transport, 'WebSocket');
    svc._transport = transport;
    svc._reconnectAttempts = 3;
    transport.onopen(new Event('open'));
    return { svc, transport, reloads: () => reloaded, opens: () => opened };
  };

  /**
   * The session frame the server seeds every connection with.
   * @param {string} [bootId] - The server instance's boot id; omitted entirely when undefined.
   * @returns {string} Raw JSON frame.
   */
  const sessionFrame = (bootId) => JSON.stringify(
    bootId === undefined
      ? { type: 'session', clientId: 'client-1' }
      : { type: 'session', clientId: 'client-1', bootId }
  );

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

  await run('a reconnect withholds open until the server says which server it is', async () => {
    const { svc, opens } = reconnecting('boot-1');
    assert(opens() === 0, `open is withheld while the server is unidentified; got ${opens()}`);
    assert(svc.connected === false, 'the link is not reported up while undecided');
  });

  await run('an unchanged boot id catches up: open is released and nothing reloads', async () => {
    const { svc, reloads, opens } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame('boot-1'));
    assert(reloads() === 0, `the same server must not cost a reload; got ${reloads()}`);
    assert(opens() === 1, `open released once the server matched; got ${opens()}`);
    assert(svc.connected === true, 'the link is up');
    assert(svc._reconnectAttempts === 0, 'the backoff counter is reset by settling');
    // 'open' IS the catch-up: ConnectionManager's open handler is what runs the
    // state-vector resync. The live case at the end of this file drives that
    // whole chain against the real server.
  });

  await run('a changed boot id reloads: the page belongs to a server that is gone', async () => {
    const { svc, reloads, opens } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame('boot-2'));
    assert(reloads() === 1, `a restarted server must reload the page; got ${reloads()}`);
    assert(opens() === 0, 'a page on its way out never reports the link up');
    assert(svc.connected === false, 'and never treats the link as usable');
  });

  await run('a reconnect with no boot id recorded reloads (nothing to compare against)', async () => {
    const { reloads, svc } = reconnecting(null);
    svc._handleMessageData(sessionFrame('boot-1'));
    assert(reloads() === 1, `an unverifiable reconnect must reload; got ${reloads()}`);
  });

  await run('a session that carries no boot id reloads (same reason)', async () => {
    const { reloads, svc } = reconnecting('boot-1');
    svc._handleMessageData(sessionFrame(undefined));
    assert(reloads() === 1, `a server that will not name itself must reload; got ${reloads()}`);
  });

  await run('a reconnect that dies before identifying the server reloads', async () => {
    const { svc, transport, reloads } = reconnecting('boot-1');
    let attempts = 0;
    svc.on('reconnect-attempt', () => { attempts++; });
    // The signature of a restarted server: it completes the upgrade, then closes
    // the socket because this page's token belongs to the process it replaced.
    transport.onclose(new Event('close'));
    assert(reloads() === 1, `an open that dies unidentified must reload; got ${reloads()}`);
    assert(attempts === 0, 'and must not also re-arm the loop it is reloading out of');
  });

  await run('a restart while throttled drops the link and re-arms the loop instead of storming', async () => {
    const { svc, transport, reloads, opens } = reconnecting('boot-1');
    svc._shouldReloadOnReconnect = () => false; // rate-limiter says "too soon"
    let rearmed = 0;
    svc._reconnect = () => { rearmed++; };
    svc._handleMessageData(sessionFrame('boot-2'));
    assert(reloads() === 0, 'must NOT reload while throttled (no reload storm)');
    assert(opens() === 0, 'and must not carry on against a server that knows nothing of this page');
    assert(transport.closed === true, 'the connection to the restarted server is dropped');
    assert(rearmed === 1, `the backoff loop is re-armed so the overlay keeps counting; got ${rearmed}`);
  });

  await run('the engine settles its reconnect at once (it has no page to go stale)', async () => {
    const g = /** @type {any} */ (globalThis);
    const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
    const previous = g.JUGGLER_ENGINE;
    g.JUGGLER_ENGINE = true;
    try {
      const svc = new WebSocketService();
      let reloaded = 0;
      let opened = 0;
      svc._reloadPage = () => { reloaded++; };
      svc._shouldReloadOnReconnect = () => true;
      svc.on('open', () => { opened++; });
      const transport = makeTransport();
      svc._configureTransport(transport, 'WebSocket');
      svc._reconnectAttempts = 3;
      transport.onopen(new Event('open'));
      assert(opened === 1, `the engine's open is released immediately; got ${opened}`);
      assert(reloaded === 0, 'the engine never reloads — resync is its only recovery');
      assert(svc.connected === true, 'the engine link is up straight away');
    } finally {
      if (had) g.JUGGLER_ENGINE = previous; else delete g.JUGGLER_ENGINE;
    }
  });

  // The whole policy against the real server, on this page's live socket: the
  // boot id it sends is stable across a reconnect, so the page stays and its
  // 'open' is released — which is what sets the resync off (ConnectionManager's
  // open handler; this page deliberately doesn't load app.js, so that handler
  // isn't here, and resync-offline-edit-test drives the recovery itself over
  // this same reconnect path). Everything above stubs the server; this is the
  // case that catches the two of them disagreeing.
  await run('a real reconnect to the same server carries on without reloading', async () => {
    const originalReload = wsService._reloadPage;
    let reloaded = 0;
    let opens = 0;
    const onOpen = () => { opens++; };
    wsService._reloadPage = () => { reloaded++; };
    wsService.on('open', onOpen);
    try {
      // The harness opens this page's socket by waiting on 'open', and the
      // session frame lands a turn later — so it can still be in flight when a
      // unit suite begins. Wait for the server to have named itself.
      await waitFor(
        () => typeof wsService.serverBootId === 'string' && wsService.serverBootId.length > 0,
        { timeoutMs: 5000, description: 'the server to name itself in the session message' }
      );
      const bootIdBefore = wsService.serverBootId;

      await wsService.simulateDisconnect();
      // simulateDisconnect is a clean teardown, so it leaves the attempt counter
      // at zero. A real drop does not — set it, so this reconnects as one.
      wsService._reconnectAttempts = 1;
      await wsService.reconnect();

      assert(reloaded === 0, `an unchanged boot id must not reload; got ${reloaded}`);
      assert(wsService.serverBootId === bootIdBefore, 'still talking to the same server');
      assert(wsService.connected === true, 'the link is up again');
      assert(opens === 1, `open released once the server matched, which is what runs the resync; got ${opens}`);
    } finally {
      wsService._reloadPage = originalReload;
      wsService.off('open', onOpen);
    }
  });

  return { passed, failed, errors };
}
