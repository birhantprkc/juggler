//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { recordTape } from '../utils/event-tape.js';
import { isEngine } from '../../sdk/lib/client-role.js';
import { fetchJson } from './http.js';

const WEBRTC_CHUNK_TYPE = '__juggler_dc_chunk';
const WEBRTC_CHUNK_SIZE = 16 * 1024;

/**
 * @typedef {'open'|'close'|'error'|'message'|'session'|'file-change'|'project-changed'|'plugin-changed'|'retry'|'streaming-error'|'providers-update'|'providers-ready'|'shell-output'|'reconnect-attempt'|'processing-heartbeat'|'engine-bridge'|'update-status'|'clients-changed'} WSEventType
 */

/**
 * @typedef {'text'|'thinking'|'redacted_thinking'|'tool_use'|'tool_result'|'citation'|'image'|'code'|'code_result'} ContentBlockType
 */

/**
 * @typedef {object} ContentBlock
 * @property {ContentBlockType} type - The type of content block
 * @property {string} [content] - The content of the block
 * @property {string} [text] - Text content (for text blocks from API)
 * @property {string} [thinking] - Thinking content (for thinking blocks from API)
 * @property {string} [signature] - Thinking signature (for thinking blocks from Anthropic)
 * @property {string} [id] - Tool use ID (API format)
 * @property {string} [name] - Tool name (API format)
 * @property {{[key: string]: unknown}} [input] - Tool input (API format)
 * @property {string} [toolUseId] - Tool use ID (internal format)
 * @property {string} [toolName] - Tool name (internal format)
 * @property {{[key: string]: unknown}} [toolInput] - Tool input parameters (internal format)
 * @property {{[key: string]: unknown}} [metadata] - Provider-specific metadata (citations, signatures, etc.)
 */

/**
 * @typedef {function(unknown): void} WSEventCallback
 */

/**
 * WebSocket service for real-time communication with Juggler backend
 * @class
 */
class WebSocketService {
  constructor() {
    /** @type {WebSocket|RTCDataChannel|null} @private */
    this._transport = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {string|null} - This client's server-assigned id, from the session message. Used to exclude self from the connected-clients list. */
    this.clientId = null;
    /**
     * The server instance this page belongs to, taken from the session message's
     * boot id. Recorded on the first session message and compared on every
     * reconnect — see {@link WebSocketService#_resolveReconnect}.
     * @type {string|null}
     */
    this.serverBootId = null;
    /**
     * Set while a viewer's reconnect waits for the session message that says
     * which server answered. The 'open' event is withheld for that window
     * (parked in {@link WebSocketService#_heldOpenEvent}), because everything
     * downstream of 'open' treats the link as one worth catching up over, and
     * against a restarted server it is not.
     * @type {boolean} @private
     */
    this._reconnectPending = false;
    /** @type {Event|undefined} @private - The withheld 'open' event, released once the server is identified. */
    this._heldOpenEvent = undefined;
    /** @type {string} @private - Name of the current transport, for the connected log line. */
    this._transportLabel = 'WebSocket';
    /** @type {number} @private */
    this._reconnectAttempts = 0;
    /** @type {boolean} @private */
    this._intentionalDisconnect = false;
    /** @type {boolean} @private */
    this._suppressNextCloseReconnect = false;
    /**
     * How to re-establish the CURRENT transport after the link drops. Set by
     * connect() to a transport-specific thunk so the backoff loop in
     * _reconnect() stays transport-agnostic: every transport drops into the
     * same detect → back off → re-establish → repeat policy, differing only in
     * this one primitive.
     *   - WebSocket / WebRTC-LAN: reopen the socket; its own open/close events
     *     re-drive the loop.
     *   - juggler.studio: reload the page (the only way to re-run the external
     *     bootstrap's WebRTC handshake), gated on a server reachability probe
     *     so a still-dead link can't cause a reload storm.
     * @type {(() => void)|null} @private
     */
    this._reestablish = null;
    /** @type {number} @private */
    this._dcChunkSeq = 0;
    /** @type {Map<string, {total: number, parts: string[], received: number}>} @private */
    this._dcIncomingChunks = new Map();
    /** @type {Record<WSEventType, WSEventCallback[]>} @private */
    this._listeners = {
      open: [],
      close: [],
      error: [],
      message: [],
      session: [],
      'file-change': [],
      'project-changed': [],
      'plugin-changed': [],
      retry: [],
      'streaming-error': [],
      'providers-update': [],
      'providers-ready': [],
      'shell-output': [],
      'reconnect-attempt': [],
      'processing-heartbeat': [],
      'engine-bridge': [],
      'update-status': [],
      'clients-changed': []
    };
  }

  connect() {
    this._intentionalDisconnect = false;

    const role = isEngine() ? 'engine' : 'viewer';

    // Default re-establish primitive for socket transports: reopen the socket.
    // Its open/close events feed the shared backoff loop. The studio branch
    // below overrides this with a reload-based primitive (its handshake lives in
    // an external bootstrap that only a full page reload can re-run).
    this._reestablish = () => this.connect();

    // juggler.studio remote path: the bootstrap page has already established a
    // WebRTC DataChannel and published window.__jugglerStudio, then injected
    // the app into this same page without navigating. Adopt that channel as the
    // realtime transport instead of opening our own. This MUST precede the
    // LAN-https WebRTC/WS branch below: studio is the remote transport and has
    // no WS-relay fallback (there is no relay reachable from a remote browser —
    // recovery is a full page reload, which re-runs bootstrap). The LAN/local
    // case keeps the _connectWebRTC → _connectWebSocket relay fallback intact.
    if (role === 'viewer' && typeof globalThis.window !== 'undefined' && /** @type {any} */ (window).__jugglerStudio) {
      this._adoptStudioChannel();
      return;
    }

    if (role === 'viewer' && globalThis.location.protocol === 'https:' && typeof globalThis.RTCPeerConnection !== 'undefined') {
      this._connectWebRTC(role).catch((error) => {
        console.warn('[WebSocket] WebRTC direct transport failed; falling back to WebSocket relay:', error);
        if (!this.connected && !this._intentionalDisconnect) {
          this._connectWebSocket(role);
        }
      });
      return;
    }

    this._connectWebSocket(role);
  }

  /**
   * @param {string} role
   * @private
   */
  _connectWebSocket(role) {
    // globalThis.location works in both the window (Location) and a module
    // worker (WorkerLocation), so the engine can build its WS URL off-thread.
    const loc = globalThis.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    // Replay the per-instance session token (embedded in the served page) so the
    // server accepts the viewer upgrade (see cmd/juggler/server/api_auth.go). The
    // engine worker has no token global and is exempt server-side, so it simply
    // omits the param.
    const token = /** @type {{__jugglerToken?: string}} */ (globalThis).__jugglerToken;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const wsUrl = `${protocol}//${loc.host}/api/ws?role=${role}${tokenParam}`;
    this._transport = new WebSocket(wsUrl);
    this._configureTransport(this._transport, 'WebSocket');
  }

  /**
   * @param {string} role
   * @returns {Promise<void>}
   * @private
   */
  async _connectWebRTC(role) {
    const pc = new window.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    try {
      const dc = pc.createDataChannel('juggler', { ordered: true });
      /** @type {RTCDataChannel & {__pc?: RTCPeerConnection}} */ (dc).__pc = pc;
      this._transport = /** @type {any} */ (dc);
      this._configureTransport(/** @type {any} */ (dc), 'WebRTC');

      const opened = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebRTC DataChannel open timeout')), 8000);
        dc.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve(undefined);
        }, { once: true });
        dc.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('WebRTC DataChannel error'));
        }, { once: true });
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this._waitForIceGathering(pc, 5000);

      const answer = await fetchJson('/api/webrtc/signal', {
        method: 'POST',
        body: { role, offer: pc.localDescription },
        errorPrefix: 'WebRTC signaling failed',
      });
      await pc.setRemoteDescription(answer.answer);
      await opened;
    } catch (error) {
      this._suppressNextCloseReconnect = true;
      pc.close();
      this._transport = null;
      throw error;
    }
  }

  /**
   * Adopt the WebRTC DataChannel that the juggler.studio bootstrap page already
   * opened (published on window.__jugglerStudio), using it as the realtime
   * transport. The channel is already OPEN, so we mark connected synchronously
   * and fire the open path rather than waiting on an onopen event.
   * @private
   */
  _adoptStudioChannel() {
    /** @type {{dc: RTCDataChannel, sendFrame: (text: string) => void, setRealtimeHandler: (fn: (raw: string) => void) => void}} */
    const studio = /** @type {any} */ (window).__jugglerStudio;

    // Use a minimal send-adapter, NOT the raw RTCDataChannel, as this._transport.
    // studio.sendFrame already applies the __juggler_dc_chunk envelope, and
    // _sendTransport only chunks when this._transport is `instanceof RTCDataChannel` —
    // so routing through this plain object correctly skips our chunker and
    // avoids double-chunking the same payload.
    this._transport = /** @type {any} */ ({
      send: (/** @type {string} */ payload) => studio.sendFrame(payload),
      close: () => {}
    });

    // Inbound frames arrive already reassembled (chunks merged) and pre-filtered
    // (http/chunk frames removed) by bootstrap, so feed them straight in.
    studio.setRealtimeHandler((/** @type {string} */ raw) => this._handleMessageData(raw));

    // The channel is open at adoption time; settle it as a first connection.
    // There was no prior connection to compare servers against, so this never
    // takes the reconnect handshake in _configureTransport.
    this._transportLabel = 'studio';
    this._settleOpen(undefined);

    // Studio's only recovery lever is a full page reload (it re-runs the
    // external bootstrap's WebRTC handshake — app-side JS can't rebuild the
    // channel). Gate the reload on a server reachability probe so a still-dead
    // link can't reload-storm; see _reloadWhenReachable. This plugs into the
    // SAME backoff loop as every other transport via this._reestablish.
    this._reestablish = () => this._reloadWhenReachable();

    // Route channel death through the shared transport-death handler so studio
    // uses the identical reconnect policy as the socket transports.
    const onDead = (/** @type {Event} */ event) => this._onTransportClosed(event, studio.dc);
    studio.dc.addEventListener('close', onDead);
    studio.dc.addEventListener('error', onDead);
  }

  /**
   * @param {RTCPeerConnection} pc
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   * @private
   */
  _waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(done, timeoutMs);
      /** Finish waiting for ICE gathering. */
      function done() {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      }
      /** Resolve once browser ICE gathering completes. */
      function onState() {
        if (pc.iceGatheringState === 'complete') done();
      }
      pc.addEventListener('icegatheringstatechange', onState);
    });
  }

  /**
   * @param {WebSocket|RTCDataChannel} transport
   * @param {string} label
   * @private
   */
  _configureTransport(transport, label) {
    this._transportLabel = label;
    transport.onopen = (event) => {
      // A viewer's reconnect is not settled here. Which server answered decides
      // whether this page can carry on — the same instance means the outage was
      // a link blip and the Yjs resync repairs it — and that is only knowable
      // from the session message, so withhold 'open' until _resolveReconnect
      // reads it. The engine is exempt: it is a headless page with no token or
      // cache-busted asset URLs baked into it and no reload to fall back on, so
      // resync is its recovery either way.
      if (this._reconnectAttempts > 0 && !isEngine()) {
        this._reconnectPending = true;
        this._heldOpenEvent = event;
        return;
      }
      this._settleOpen(event);
    };

    transport.onclose = (/** @type {CloseEvent|Event} */ event) => this._onTransportClosed(event, transport);

    transport.onerror = (/** @type {Event} */ error) => {
      console.error(`[ESSENTIAL] [${label}] transport error (type=${error?.type})`, error);
      this._emit('error', error);
    };

    transport.onmessage = (event) => {
      this._handleMessageData(event.data);
    };
  }

  /**
   * Single transport-death handler for EVERY transport (WebSocket, WebRTC-LAN,
   * juggler.studio). Marks the link down, notifies listeners, and — unless this
   * was an intentional teardown or an expected failed-probe close — enters the
   * shared backoff reconnect loop. The loop is transport-agnostic; HOW the link
   * is actually re-established is the per-transport this._reestablish thunk.
   * @param {CloseEvent|Event} event - The close/error event
   * @param {WebSocket|RTCDataChannel|null} [transport] - The dead transport (for PC cleanup)
   * @private
   */
  _onTransportClosed(event, transport) {
    this.connected = false;
    // A reconnect whose socket opened and then died before the server ever said
    // who it is. That is what a restarted server looks like from here: it
    // completes the upgrade and then closes the socket because the token this
    // page replays belongs to a process that is gone. Left alone it flaps
    // forever — every bogus open would reset the backoff — so the page reloads,
    // being exactly as stale as the token it sent.
    const diedUnidentified = this._reconnectPending;
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    this._emit('close', event);
    const pc = transport && /** @type {any} */ (transport).__pc;
    if (pc) pc.close();
    // Skip auto-reconnect for an intentional disconnect or an expected failed
    // WebRTC probe that is about to fall back to the WebSocket relay.
    if (this._suppressNextCloseReconnect) {
      this._suppressNextCloseReconnect = false;
      return;
    }
    if (diedUnidentified && this._reloadStalePage('the link opened and closed without the server identifying itself')) {
      return;
    }
    if (!this._intentionalDisconnect) {
      this._reconnect();
    }
  }

  /**
   * Inbound messages that are identified by their `type`, keyed by that type.
   * Each route translates one wire message into the service events subscribers
   * listen for, and is dispatched by {@link WebSocketService#_handleMessageData}
   * before the shape-matched cases (retry, streaming-error) and the generic
   * 'message' emit. Returning `false` declines the message so it falls through to
   * those cases — only engine-bridge does that, for a malformed channel.
   * @type {Record<string, (ws: WebSocketService, data: any) => boolean|void>}
   */
  static TYPED_MESSAGE_ROUTES = {
    [WEBRTC_CHUNK_TYPE]: (ws, data) => {
      ws._handleTransportChunk(data);
    },

    'file-change': (ws, data) => {
      ws._emit('file-change', data.changes);
    },

    // Project switch (server-side change of the loaded project)
    'project-changed': (ws, data) => {
      ws._emit('project-changed', { projectPath: data.projectPath || '' });
    },

    // Plugin file changes (hot reload)
    'plugin-changed': (ws, data) => {
      ws._emit('plugin-changed', data.path);
    },

    'providers-update': (ws, data) => {
      ws._emit('providers-update', data.providers);
      // Whether this snapshot is the settled, post-compute list (true) or the
      // pre-compute connect seed (false). Emitted second so any 'providers-update'
      // listener has already applied the array before readiness is signalled.
      ws._emit('providers-ready', data.ready === true);
    },

    // Version/update-status pushes (server re-evaluated the remote version
    // manifest and the surfaced notice changed).
    'update-status': (ws, data) => {
      ws._emit('update-status', data);
    },

    // Connected-client changes (a viewer joined or left). `count` is the total
    // number of viewer clients (this one included); `clients` describes each, so
    // listeners can exclude self by id and show origin/connect-time.
    'clients-changed': (ws, data) => {
      ws._emit('clients-changed', { count: data.count, clients: data.clients || [] });
    },

    'shell-output': (ws, data) => {
      ws._emit('shell-output', data);
    },

    // Cross-origin engine→viewer event bridge. Each viewer's WS
    // sees this message exactly once, so emit it as a direct
    // wsService event for subscribers that prefer per-WS delivery
    // (e.g. the test harness's exec counter). The engine itself
    // both originated the message and skips its own replay.
    //
    // Also replay onto a same-window BroadcastChannel so existing
    // BC subscribers (action-progress, etc.) keep working. In the
    // multi-iframe test pool the BC path inherently fans the
    // event N-1 ways (sender doesn't get its own posts but every
    // sibling iframe does), which is why new test instrumentation
    // should subscribe to 'engine-bridge' on wsService instead.
    'engine-bridge': (ws, data) => {
      if (typeof data.channel !== 'string') return false;
      if (isEngine()) return true;
      // The engine has no tape of its own (separate window, no
      // BroadcastChannel reach), so its bridged events are the
      // only record of what it executed. Stamp them onto this
      // viewer's tape so a failure block shows the engine's
      // tool-exec timeline interleaved with local events.
      // Record a COMPACT summary, never the raw payload: progress
      // events carry the tool's accumulated output, and retaining
      // those strings in a 2000-entry ring across every iframe
      // turns a large-output tool run into a memory bomb.
      const p = /** @type {any} */ (data.payload) || {};
      recordTape('engine:' + data.channel.replace(/^juggler-/, ''),
        p.conversationId ?? null, {
          toolUseId: p.toolUseId,
          toolName: p.toolName,
          phase: p.phase,
          ok: p.ok,
          status: p.status,
          aborted: p.aborted,
          eventType: p.event?.type,
          contentLen: typeof p.event?.content === 'string' ? p.event.content.length : undefined,
          accumulatedLen: typeof p.accumulatedOutput === 'string' ? p.accumulatedOutput.length : undefined
        });
      ws._emit('engine-bridge', { channel: data.channel, payload: data.payload });
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const bc = new BroadcastChannel(data.channel);
          bc.postMessage(data.payload);
          bc.close();
        } catch (err) {
          console.error('[WebSocket] engine-bridge replay failed:', err);
        }
      }
      return true;
    },

    // Processing heartbeat from backend
    processing_heartbeat: (ws, data) => {
      ws._emit('processing-heartbeat', data);
    }
  };

  /**
   * @param {any} rawData
   * @private
   */
  _handleMessageData(rawData) {

    // Ignore empty or whitespace-only messages (newlines from streaming)
    if (!rawData || String(rawData).trim().length === 0) {
      return;
    }

    try {
      const data = JSON.parse(String(rawData));

      // Messages identified by `type` route through the table above. A route
      // returning false declined the message (see engine-bridge), so it falls
      // through to the shape-matched cases below.
      const route = WebSocketService.TYPED_MESSAGE_ROUTES[data.type];
      if (route && route(this, data) !== false) return;

      // Handle retry notifications ONLY (has retry:true and attempt/maxRetries fields)
      if (data.retry === true && data.attempt !== undefined && data.maxRetries !== undefined) {
        this._emit('retry', data);
        return;
      }

      // Handle retryable error notifications - these are INFO, not fatal errors
      // Backend sends these when an error occurs but will retry
      // Emit as 'streaming-error' event so UI can show the actual error details
      if (data.error && data.message && !data.chunk && !data.response) {
        console.warn('[WebSocket] Streaming error received:', data.message);
        this._emit('streaming-error', data);
        return;
      }

      // Record every inbound WS message in the event tape so the
      // failure dump can correlate JS-side reception with worker-side
      // sends.
      recordTape('ws-in', /** @type {any} */ (data).conversationId || null, {
        type: data.type,
        workerMsgType: /** @type {any} */ (data).workerMsgType
      });

      // Handle session initialization message from server
      if (data.type === 'session') {
        // Remember our own server-assigned id so the connected-clients UI can
        // exclude this window from the list of other clients.
        if (data.clientId) this.clientId = data.clientId;
        // The boot id rides the same message, and on a reconnect it decides
        // whether this page carries on or reloads. A page on its way out has
        // nothing worth handing to listeners.
        if (this._resolveReconnect(data.bootId)) return;
        this._emit('session', data);
      } else {
        // All other messages go through normal message handler
        this._emit('message', data);
      }
    } catch (error) {
      console.error(`[ESSENTIAL] [WebSocket] Failed to parse message: ${error}`);
      console.error(`[ESSENTIAL] [WebSocket] Raw message data: ${rawData}`);
      console.error(`[ESSENTIAL] [WebSocket] Message length: ${rawData ? String(rawData).length : 0}`);
    }
  }

  /**
   * Send text over the selected transport. DataChannels are chunked because
   * SCTP implementations have much lower practical message-size ceilings than
   * WebSocket frames, and worker init can contain a large serialized document.
   * @param {string} payload
   * @private
   */
  _sendTransport(payload) {
    if (!this._transport) throw new Error('transport not connected');
    // globalThis (not window): the engine runs in a Web Worker with no
    // `window`, and this send path runs for every outbound message. WebRTC
    // is viewer-only anyway, so RTCDataChannel is simply absent in the worker.
    const RTCDataChannelCtor = /** @type {any} */ (globalThis).RTCDataChannel;
    if (typeof RTCDataChannelCtor !== 'undefined' && this._transport instanceof RTCDataChannelCtor && payload.length > WEBRTC_CHUNK_SIZE) {
      const id = `${Date.now().toString(36)}-${(++this._dcChunkSeq).toString(36)}`;
      const total = Math.ceil(payload.length / WEBRTC_CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        this._transport.send(JSON.stringify({
          type: WEBRTC_CHUNK_TYPE,
          id,
          index: i,
          total,
          data: payload.slice(i * WEBRTC_CHUNK_SIZE, (i + 1) * WEBRTC_CHUNK_SIZE)
        }));
      }
      return;
    }
    this._transport.send(payload);
  }

  /**
   * Serialize `obj` and hand it to the transport, applying the uniform
   * connected-guard + try/catch that every send* method needs. `label` names
   * the message in the two error logs ("Not connected, cannot send <label>" /
   * "Failed to send <label>: <error>"). Pass `{silent: true}` for the
   * fire-and-forget senders (session-changed, engine-bridge, tool-started) that
   * must not log on a dead link.
   * @param {object} obj - Payload object to JSON-serialize and send
   * @param {string} label - Human name of the message for the error logs
   * @param {{silent?: boolean}} [opts]
   * @returns {boolean} True if handed to the transport; false on guard/serialize failure
   * @private
   */
  _sendJson(obj, label, opts = {}) {
    if (!this.connected || !this._transport) {
      if (!opts.silent) {
        console.error(`[ESSENTIAL] [WebSocket] Not connected, cannot send ${label}`);
      }
      return false;
    }
    try {
      this._sendTransport(JSON.stringify(obj));
      return true;
    } catch (error) {
      if (!opts.silent) {
        console.error(`[ESSENTIAL] [WebSocket] Failed to send ${label}: ${error}`);
      }
      return false;
    }
  }

  /**
   * @param {{id?: string, index?: number, total?: number, data?: string}} chunk
   * @private
   */
  _handleTransportChunk(chunk) {
    if (typeof chunk.id !== 'string' || typeof chunk.index !== 'number' || typeof chunk.total !== 'number' || typeof chunk.data !== 'string') {
      return;
    }
    if (chunk.total <= 0 || chunk.index < 0 || chunk.index >= chunk.total) return;
    let entry = this._dcIncomingChunks.get(chunk.id);
    if (!entry) {
      entry = { total: chunk.total, parts: new Array(chunk.total), received: 0 };
      this._dcIncomingChunks.set(chunk.id, entry);
    }
    if (entry.total !== chunk.total) {
      this._dcIncomingChunks.delete(chunk.id);
      return;
    }
    if (entry.parts[chunk.index] === undefined) {
      entry.parts[chunk.index] = chunk.data;
      entry.received++;
    }
    if (entry.received === entry.total) {
      this._dcIncomingChunks.delete(chunk.id);
      this._handleMessageData(entry.parts.join(''));
    }
  }

  disconnect() {
    this._intentionalDisconnect = true;
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    if (this._transport) {
      const pc = /** @type {any} */ (this._transport).__pc;
      this._transport.close();
      if (pc) pc.close();
      this._transport = null;
    }
    this.connected = false;
  }

  /**
   * @typedef {object} ToolDefinition
   * @property {string} name - Tool name
   * @property {string} description - Tool description
   * @property {object} input_schema - JSON Schema for parameters
   */

  /**
   * @typedef {object} ModelConfig
   * @property {string} [provider] - LLM provider name
   * @property {string} [model] - LLM model name
   */

  /**
   * Send an LLM request over the transport.
   * @param {string} systemPrompt - System prompt with instructions
   * @param {import('../../sdk/lib/message.js').Message[]} messages - Array of Message objects
   * @param {ToolDefinition[]} tools - Tool definitions for LLM to use
   * @param {string} conversationId - Conversation ID for routing responses
   * @param {ModelConfig} modelConfig - Model configuration (provider and model)
   * @param {string} [transactionId] - Transaction ID for tracking this LLM call
   * @returns {boolean} True if message sent successfully, false otherwise
   */
  send(systemPrompt, messages, tools, conversationId, modelConfig, transactionId = '') {
    if (!this.connected || !this._transport) {
      console.error(`[ESSENTIAL] [WebSocket] Not connected, cannot send message`);
      return false;
    }

    // Validate model configuration: a concrete (provider, model) pair must
    // be present.
    const hasConcrete = modelConfig && modelConfig.provider && modelConfig.model &&
            modelConfig.provider.trim() !== '' && modelConfig.model.trim() !== '';
    if (!modelConfig || !hasConcrete) {
      console.error(`[ESSENTIAL] [WebSocket] Cannot send message without valid model configuration`);
      return false;
    }

    return this._sendJson({
      systemPrompt,
      messages,
      tools,
      conversationId,
      modelConfig,
      transactionId: transactionId || '' // Ensure empty string if undefined/null
    }, 'message');
  }

  /**
   * Send a shell-start request to execute a command with streaming output
   * @param {string} shellId - Unique ID for this shell execution
   * @param {string} convId - Conversation that owns this shell (spill-file bucket); '' when unknown
   * @param {string} command - Shell command to execute
   * @param {string} [cwd] - Working directory (optional)
   * @param {number} [timeout] - Timeout in milliseconds (optional)
   * @returns {boolean} True if sent successfully
   */
  sendShellStart(shellId, convId, command, cwd, timeout) {
    return this._sendJson({
      type: 'shell-start',
      shellId,
      convId,
      command,
      cwd,
      timeout
    }, 'shell-start');
  }

  /**
   * Send a tool execution response back to the server (for claudecode provider)
   * @param {string} requestId - Request ID to correlate with request
   * @param {string} content - Tool result content
   * @param {'success'|'error'|'cancelled'} resultStatus - Outcome of tool execution
   * @param {string} [category] - Tool category: "read", "write", "meta"
   * @returns {boolean} True if sent successfully
   */
  sendToolResponse(requestId, content, resultStatus, category) {
    return this._sendJson({
      type: 'tool_use_response',
      requestId,
      content,
      resultStatus: resultStatus || 'success',
      category: category || ''
    }, 'tool response');
  }

  /**
   * Signal to server that the user approved a tool and execution is starting.
   * This allows the server to begin its execution timeout only from this point.
   * @param {string} requestId - Request ID from the tool_use_request
   */
  sendToolStarted(requestId) {
    this._sendJson({ type: 'tool_use_started', requestId }, 'tool_use_started', { silent: true });
  }

  /**
   * Send shouldContinue response back to server (iteration control callback)
   * @param {string} requestId - Request ID from server
   * @param {boolean} shouldContinue - Whether to continue the loop
   * @param {string} message - Message to inject if stopping
   * @returns {boolean} True if sent successfully
   */
  sendShouldContinueResponse(requestId, shouldContinue, message) {
    return this._sendJson({
      type: 'should_continue_response',
      requestId,
      shouldContinue,
      message
    }, 'should_continue response');
  }

  /**
   * Send a shell-cancel request to stop a running shell command
   * @param {string} shellId - ID of the shell to cancel
   * @returns {boolean} True if sent successfully
   */
  sendShellCancel(shellId) {
    return this._sendJson({ type: 'shell-cancel', shellId }, 'shell-cancel');
  }

  /**
   * Send a message to the worker via WebSocket
   * Wraps message in worker-message envelope for server routing
   * @param {string} conversationId - Conversation ID to route message to
   * @param {{type: string, [key: string]: unknown}} message - Message to send to worker
   * @returns {boolean} True if sent successfully
   */
  sendWorkerMessage(conversationId, message) {
    if (!this.connected || !this._transport) {
      // A dropped yjs-sync is recovered, so it is not an error: the ops stay in
      // this client's doc and the reconnect resync ships them to the worker as
      // the delta since its state vector (worker-manager.resyncReadyConversations).
      // Every other worker message is genuinely lost with nothing to replay it.
      const line = `[ESSENTIAL] [WebSocket] Not connected, cannot send worker message (type=${message?.type}, connected=${this.connected}, ws=${!!this._transport})`;
      if (message?.type === 'yjs-sync') {
        console.warn(line);
      } else {
        console.error(line);
      }
      return false;
    }

    if (!conversationId) {
      console.error(`[ESSENTIAL] [WebSocket] Cannot send worker message without conversationId`);
      return false;
    }

    const envelope = {
      type: 'worker-message',
      conversationId,
      workerMsgType: message.type,
      payload: message
    };
    recordTape('ws-out', conversationId, {
      workerMsgType: message.type,
      ackId: /** @type {any} */ (message).ackId
    });
    return this._sendJson(envelope, 'worker message');
  }

  /**
   * Notify other views that session state has changed.
   * The server broadcasts this to all other viewers in the same session.
   * @returns {boolean} Whether the message was sent
   */
  sendSessionChanged() {
    return this._sendJson({ type: 'session-changed' }, 'session-changed', { silent: true });
  }

  /**
   * Tell the server this engine's realm is still running.
   *
   * The server cannot infer that from the socket: in WebKit the WebSocket lives
   * in the network process, so a suspended or wedged engine keeps completing
   * handshakes and answering pings while executing nothing. This beat is sent
   * from the module worker — the realm a tool would actually run in — so it
   * cannot be answered on behalf of an engine that has stopped.
   *
   * Silent: a beat that misses because the link is down is not news, and the
   * reconnect path reports that already.
   * @returns {boolean} True if sent
   */
  sendEngineHeartbeat() {
    return this._sendJson({ type: 'engine-heartbeat' }, 'engine-heartbeat', { silent: true });
  }

  /**
   * Report the outcome of the run the server asked this engine to make.
   *
   * Not silent: the process that asked is blocked on this message, so a send
   * that fails is the difference between a result and a run that never answers.
   * @param {{requestId: string, status: string, conversationId: string, turns: number, finalText: string, parkedTool: string, errorText: string}} result - The run's outcome
   * @returns {boolean} True if sent
   */
  sendOneShotResult(result) {
    return this._sendJson({ type: 'one-shot-result', ...result }, 'one-shot-result');
  }

  /**
   * Bridge a cross-window event from the engine to every viewer via the
   * server. Viewer-side WS handler replays the payload into a local
   * BroadcastChannel(channel) so in-page subscribers fire.
   * @param {string} channel - BroadcastChannel name (e.g. 'juggler-action-progress')
   * @param {unknown} payload - Payload to deliver to viewers
   * @returns {boolean} True if sent
   */
  sendEngineBridge(channel, payload) {
    return this._sendJson({ type: 'engine-bridge', channel, payload }, 'engine-bridge', { silent: true });
  }

  /**
   * Register an event listener
   * @param {WSEventType} event - Event type to listen for
   * @param {WSEventCallback} callback - Callback function
   */
  on(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event].push(callback);
    } else {
      console.error(`[ESSENTIAL] [WebSocket] Cannot register listener for unknown event '${event}'`);
    }
  }

  /**
   * @param {WSEventType} event
   * @param {WSEventCallback} callback
   */
  off(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Emit an event to all registered listeners
   * @param {WSEventType} event - Event type
   * @param {any} data - Event data
   * @private
   */
  _emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(callback => callback(data));
    }
  }

  /**
   * Mark the link up and release the 'open' event — the single place that does
   * either, for a first connection and for a reconnect cleared to carry on
   * alike.
   * @param {Event|undefined} event - The transport's open event.
   * @private
   */
  _settleOpen(event) {
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    this._reconnectAttempts = 0;
    this.connected = true;
    console.info(`[WebSocket] Connected via ${this._transportLabel}`);
    this._emit('open', event);
  }

  /**
   * Read the session message's boot id and, on a reconnect, decide what the
   * outage meant.
   *
   * The boot id names the server process. Unchanged, it is the same server we
   * were talking to a moment ago: it still holds this project's workers, still
   * honours the token and the cache-busted asset URLs baked into this page, and
   * everything missed while the socket was down is recovered by the Yjs
   * state-vector resync that releasing 'open' sets off. Changed, the server
   * restarted: this page was served by a process that no longer exists, so its
   * token is refused, its `/v<version>/` module URLs 404, and its project may
   * not even be the same one. Nothing short of a reload recovers from that.
   *
   * A reconnect that arrives with no boot id to compare — the server sent none,
   * or this page never received a session message to record one from — is
   * treated as a restart. The comparison is the only evidence there is, and
   * without it carrying on would mean assuming the good case.
   * @param {string|undefined} bootId - The session message's boot id.
   * @returns {boolean} True if a reload was started, so nothing else matters.
   * @private
   */
  _resolveReconnect(bootId) {
    if (!this._reconnectPending) {
      // First connection of this page: nothing to compare against yet, so just
      // record which server it belongs to.
      if (bootId) this.serverBootId = bootId;
      return false;
    }
    if (bootId && bootId === this.serverBootId) {
      this._settleOpen(this._heldOpenEvent);
      return false;
    }
    const reason = `server instance changed (was ${this.serverBootId || 'unknown'}, now ${bootId || 'unknown'})`;
    if (this._reloadStalePage(reason)) return true;
    // Throttled — the server is restarting repeatedly, and one reload per
    // restart is a reload loop. Drop this connection rather than carry on
    // against a server whose workers know nothing of this page, and re-arm the
    // backoff loop that keeps the disconnection overlay counting down, so the
    // reload is retried as soon as the throttle allows one.
    this._suppressNextCloseReconnect = true;
    try {
      this._transport?.close();
    } catch {
      /* already closing */
    }
    this.connected = false;
    this._reconnect();
    return true;
  }

  /**
   * Reload because this page belongs to a server instance that is gone.
   * Throttled, so a crash-looping server cannot put the viewer in a reload
   * loop; the caller decides what to do with the link when it is refused.
   * @param {string} reason - What made the page stale, for the log line.
   * @returns {boolean} True if the reload was started.
   * @private
   */
  _reloadStalePage(reason) {
    this._reconnectPending = false;
    this._heldOpenEvent = undefined;
    if (!this._shouldReloadOnReconnect()) return false;
    console.warn(`[ESSENTIAL] [WebSocket] Reloading: ${reason}`);
    this._reloadPage();
    return true;
  }

  /**
   * Gate a reload-to-recover so a flapping connection can't trigger a reload
   * storm. Returns true at most once per RELOAD_THROTTLE_MS (tracked in
   * sessionStorage so it survives the reload itself, per tab). When throttled,
   * the caller keeps trying to re-establish the link instead.
   * @returns {boolean} True if a reload-to-recover is allowed right now
   * @private
   */
  _shouldReloadOnReconnect() {
    const KEY = 'jugglerLastReconnectReload';
    const RELOAD_THROTTLE_MS = 60000;
    let last = 0;
    try {
      last = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;
    } catch {
      // sessionStorage unavailable — fail open is unsafe (storm risk), so
      // fail closed: skip the reload, keep the live connection.
      return false;
    }
    const now = Date.now();
    if (now - last < RELOAD_THROTTLE_MS) {
      console.warn('[ESSENTIAL] [WebSocket] Skipping reload-on-reconnect (throttled) — link is flapping');
      return false;
    }
    try {
      sessionStorage.setItem(KEY, String(now));
    } catch {
      /* ignore write failure */
    }
    return true;
  }

  _reconnect() {
    this._reconnectAttempts++;

    // Tiered delay: 1s for first 50, 2s for next 50, 5s after that
    let delay;
    if (this._reconnectAttempts <= 50) {
      delay = 1000;
    } else if (this._reconnectAttempts <= 100) {
      delay = 2000;
    } else {
      delay = 5000;
    }

    // Emit reconnect-attempt event with delay so UI can show countdown
    this._emit('reconnect-attempt', { attempt: this._reconnectAttempts, delayMs: delay });

    setTimeout(() => {
      if (this.connected || this._intentionalDisconnect) return;
      // Re-establish via the current transport's primitive (set in connect()).
      // Fall back to a plain reconnect if connect() never ran.
      (this._reestablish || (() => this.connect()))();
    }, delay);
  }

  /**
   * Reload the page. A single overridable seam so both reload-to-recover paths
   * (the socket onopen reload-on-reconnect and the studio reachability reload)
   * go through one place, and tests can spy it without touching globals.
   * @private
   */
  _reloadPage() {
    globalThis.location.reload();
  }

  /**
   * Studio re-establish primitive: reload the page to re-run the external
   * bootstrap's WebRTC handshake. A reload is studio's sole recovery — app-side
   * JS cannot rebuild the DataChannel once it dies.
   *
   * We deliberately do NOT probe /api/health (or any other endpoint) first.
   * Over studio the service worker tunnels EVERY same-origin request from this
   * page — /api/health included — through the very DataChannel that just died,
   * so the probe can only ever return an instant 504. Gating the reload on it
   * therefore wedged the session in an endless health-check loop that never
   * recovered (the reachability signal it waited for was unreachable by
   * construction). There is no out-of-band path to juggler.studio from here to
   * probe instead, and a reload's success depends on the P2P host being
   * reachable — which cannot be known without redoing the handshake anyway.
   *
   * So reload directly, relying on two existing storm-guards: this loop is only
   * ever entered on a real link death, _shouldReloadOnReconnect throttles reloads
   * to once per 60s (sessionStorage-backed, survives the reload), and a reload
   * against a still-dead host ends on bootstrap's static "connection isn't
   * possible" panel (no auto-retry) — so it cannot storm. When throttled we
   * re-arm the shared backoff loop instead, keeping the disconnection overlay
   * countdown alive until a reload is allowed again.
   * @returns {Promise<void>}
   * @private
   */
  async _reloadWhenReachable() {
    if (this.connected || this._intentionalDisconnect) return;
    if (this._shouldReloadOnReconnect()) {
      this._reloadPage();
      return;
    }
    // Reload throttled (link is flapping) — re-arm the same backoff loop that
    // drives the disconnection overlay countdown rather than reload-storming.
    this._reconnect();
  }

  /**
   * Check if WebSocket is currently connected
   * @returns {boolean} True if connected, false otherwise
   */
  isConnected() {
    return this.connected;
  }

  // ============================================================================
  // Test Harness Methods
  // ============================================================================

  /**
   * Simulate WebSocket disconnection for testing.
   * Closes the connection without triggering auto-reconnect.
   * @returns {Promise<void>}
   */
  async simulateDisconnect() {
    this._intentionalDisconnect = true;
    if (this._transport) {
      this._transport.close();
    }
    this.connected = false;
    // Wait for close to complete
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  /**
   * Reconnect WebSocket for testing (after simulateDisconnect).
   * Re-establishes connection.
   * @returns {Promise<void>}
   */
  async reconnect() {
    // Reset intentional disconnect flag
    this._intentionalDisconnect = false;

    // Reconnect
    this.connect();

    // Wait for connection to establish
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Reconnect timeout'));
      }, 5000);

      const onOpen = () => {
        clearTimeout(timeout);
        this.off('open', onOpen);
        this.off('error', onError);
        resolve();
      };

      const onError = (/** @type {unknown} */ err) => {
        clearTimeout(timeout);
        this.off('open', onOpen);
        this.off('error', onError);
        reject(err);
      };

      this.on('open', onOpen);
      this.on('error', onError);
    });
  }
}

// Export singleton instance
const wsService = new WebSocketService();
export default wsService;

// Also export the class for isolated unit testing of the reconnect policy.
export { WebSocketService };
