//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   https://juggler.studio
//
//   This program is free software: you can redistribute it and/or modify it under the terms of
//   the GNU Affero General Public License as published by the Free Software Foundation, either
//   version 3 of the License, or (at your option) any later version. This program is distributed
//   in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
//   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file or
//   <https://www.gnu.org/licenses/agpl-3.0.html> for full terms.

import { modelLabel, modelLabelFromList } from '../model/model-display.js';
import { formatBytes, formatTimeAgo } from '../utils/format.js';
import { markPopupOpen } from '../utils/popup-manager.js';
import { addFilePath } from '../utils/properties-panel-helpers.js';
import { createCopyButton } from '../../sdk/lib/copy-button.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import wsService from '../services/websocket.js';
import { allInfoCards, isCardEnabled, setCardEnabled, INFO_CARDS_CHANGED_EVENT } from '../services/info-cards-manager.js';
import {
  getAttentionPrefs,
  setSoundEnabled,
  setNotifyEnabled,
  setChimeParam,
  resetChimeParams,
  previewChime,
  ATTENTION_PREFS_EVENT,
} from '../utils/attention-manager.js';
import { chimePatterns, chimeSounds } from '../utils/chime-synth.js';
import {
  mcpListServers,
  mcpGetConfig,
  mcpSetConfig,
  mcpServerControl,
  mcpGetLog,
  acpListAgents,
  acpGetConfig,
  acpSetConfig,
} from '../services/ops-api.js';
import {
  ConfigTabController,
  configFormToConfig,
  upsertConfigEntry,
  deleteConfigEntry,
  setConfigEntryEnabled,
  configScopeOf,
  makeNameValidator,
} from './config-tab.js';

/** Polling interval (ms) for refreshing the Connectivity tab while it's open. */
const CONNECTIVITY_POLL_MS = 2000;

/** Polling interval (ms) for tailing the selected log while the Logs tab is open. */
const LOGS_POLL_MS = 2000;

/**
 * Cap on the characters kept in the log viewer. Incremental appends never stop,
 * so a chatty log tailed for a long sitting would grow the <pre> unbounded;
 * once past this we drop the oldest characters (a whole-line boundary) to keep
 * the DOM bounded. Decoupled from the byte offset (which tracks file position),
 * so trimming what's shown never affects tailing.
 */
const LOGS_VIEWER_MAX_CHARS = 512 * 1024;



/**
 * One WAN tunnel mode this server's build registered, as reported by
 * GET /api/connectivity `wanModes`. The Connectivity tab's WAN section is
 * rendered entirely from this list; an empty list means the build has no WAN
 * feature and the section is hidden.
 * @typedef {object} WANMode
 * @property {string} mode - Wire id sent to POST /api/connectivity/tunnel
 * @property {string} title - Short mode name, e.g. "Direct P2P"
 * @property {string} description - One-paragraph explanation of trade-offs
 * @property {string} startLabel - Start-button label
 * @property {string} relayNote - Optional note shown while active
 * @property {string} unavailableHint - Shown instead of Start when unavailable
 * @property {boolean} available - Whether the mode can start on this machine
 */

/**
 * One connected viewer client, as reported by GET /api/connectivity `clients`
 * and the clients-changed event. The `id` lets a client exclude itself.
 * @typedef {object} ClientDescriptor
 * @property {string} id - Server-assigned client id
 * @property {string} origin - "local" (same machine), "lan", or "remote"
 * @property {string} detail - LAN IP, or remote transport label; "" for local
 * @property {string} userAgent - Raw User-Agent, when the transport had one
 * @property {number} connectedAt - Connect time, unix milliseconds
 */

/**
 * Human label for a client's origin, e.g. "Same machine", "LAN · 192.168.1.4",
 * or the remote transport name ("Cloudflare Tunnel relay", "Peer-to-peer").
 * @param {ClientDescriptor} c
 * @returns {string} The origin label.
 */
function clientOriginLabel(c) {
  switch (c.origin) {
    case 'local': return 'Same machine';
    case 'lan': return c.detail ? `LAN · ${c.detail}` : 'LAN';
    case 'remote': return c.detail || 'Remote';
    default: return 'Connected';
  }
}

/**
 * Coarse "Browser · OS" label from a User-Agent, best-effort. Returns '' when
 * nothing recognisable is present (UA parsing is deliberately shallow).
 * @param {string} ua
 * @returns {string} A "Browser · OS" label, or '' when nothing is recognised.
 */
function clientDeviceLabel(ua) {
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  let br = '';
  if (/Edg\//.test(ua)) br = 'Edge';
  else if (/OPR\//.test(ua)) br = 'Opera';
  else if (/Chrome\//.test(ua)) br = 'Chrome';
  else if (/Firefox\//.test(ua)) br = 'Firefox';
  else if (/Safari\//.test(ua)) br = 'Safari';
  return [br, os].filter(Boolean).join(' · ');
}

/**
 * Fetch a QR-code SVG for `url` from the server and inline it into `host`.
 * Inline (rather than <img>) so `fill="currentColor"` inherits the surrounding
 * text colour. The SVG is transparent (no background rect).
 * @param {HTMLElement} host
 * @param {string} url
 */
async function loadQRCodeSVG(host, url) {
  try {
    const res = await fetch(`/api/connectivity/qr?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    host.innerHTML = await res.text();
  } catch {
    // Network failure: leave the host empty rather than throwing.
  }
}

/** Polling interval (ms) for refreshing the MCP servers tab while it's open. */
const MCP_POLL_MS = 2000;

/** Polling interval (ms) for refreshing the ACP agents tab while it's open. */
const ACP_POLL_MS = 3000;

/**
 * One MCP server's config entry, as stored in a scope's mcp.json map.
 * @typedef {object} McpServerConfig
 * @property {string} command - Executable to launch (stdio transport)
 * @property {string[]} [args] - Command arguments (each may contain spaces)
 * @property {Record<string,string>} [env] - Environment variables (secret values)
 * @property {string} [transport] - Transport kind; defaults to stdio
 * @property {string} [url] - Endpoint URL for non-stdio transports
 * @property {boolean} [enabled] - Whether the manager should run this server
 * @property {boolean} [lazyTools] - Defer tool discovery until first use
 */

/**
 * Format an MCP server's tool count and schema-token cost as a short one-liner,
 * e.g. "3 tools · ~1.2k tokens/request" or "1 tool". The token clause is dropped
 * when the server reports zero schema tokens (e.g. before discovery completes).
 * @param {{toolCount?: number, schemaTokens?: number}} status - A McpServerStatus
 * @returns {string} The formatted "N tools · ~Xk tokens/request" summary.
 */
export function formatMcpTokenCost(status) {
  const n = (status && status.toolCount) || 0;
  const t = (status && status.schemaTokens) || 0;
  const tok = t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
  return `${n} tool${n === 1 ? '' : 's'}${t ? ` · ~${tok} tokens/request` : ''}`;
}

// The MCP servers and ACP agents tabs manage the same shape — a scope-keyed map
// of {command, args, env, enabled} subprocess entries — so their config helpers
// are shared generics from config-tab.js (see ConfigTabController). These named
// aliases keep the public surface the unit tests import; each tab differs only
// in its name validator, spelled out below.

export const mcpFormToConfig = configFormToConfig;
export const mcpUpsertMap = upsertConfigEntry;
export const mcpDeleteMap = deleteConfigEntry;
export const mcpSetEnabledMap = setConfigEntryEnabled;
export const mcpScopeOf = configScopeOf;

export const acpFormToConfig = configFormToConfig;
export const acpUpsertMap = upsertConfigEntry;
export const acpDeleteMap = deleteConfigEntry;
export const acpSetEnabledMap = setConfigEntryEnabled;
export const acpScopeOf = configScopeOf;

/**
 * Validate a proposed MCP server name. Names become part of the LLM tool id
 * (`mcp__<name>__<tool>`), so "juggler" is reserved for the built-in CLI bridge.
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateMcpServerName = makeNameValidator({
  article: 'A',
  noun: 'server',
  reserved: 'juggler',
  reservedMsg: '"juggler" is reserved for the built-in tools.',
});

/**
 * Validate a proposed ACP agent name. Names become the model id under the ACP
 * provider — not a tool prefix — so no word is reserved (unlike MCP).
 * @type {(name: string, existingNames?: string[]) => string}
 */
export const validateAcpAgentName = makeNameValidator({ article: 'An', noun: 'agent' });

/**
 * Map an ACP agent's status string to the shared MCP status-dot CSS class
 * (reused for visual consistency): available→running (green), unavailable→
 * failed (red), disabled→stopped (grey).
 * @param {string} status
 * @returns {'running'|'failed'|'stopped'} The dot class suffix.
 */
export function acpDotClass(status) {
  if (status === 'available') return 'running';
  if (status === 'unavailable') return 'failed';
  return 'stopped';
}

/**
 * Best-effort: enable the "acp" provider and refresh the model selector, so a
 * newly-added agent shows up in the picker immediately. Failure is non-fatal —
 * the provider can still be toggled on manually in the Provider API Keys tab.
 * @returns {Promise<void>}
 */
async function ensureAcpProviderEnabled() {
  try {
    await fetch('/api/config/provider-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'acp', enabled: true }),
    });
    const modelSelector = document.querySelector('model-selector');
    if (modelSelector && /** @type {any} */ (modelSelector).refresh) {
      await /** @type {any} */ (modelSelector).refresh();
    }
  } catch {
    // Non-fatal: the ACP provider can still be enabled manually.
  }
}

/**
 * Spec for the "MCP servers" tab: a stdio MCP server is a managed subprocess,
 * so it reports live status, supports Restart and a stderr Log disclosure, and
 * its name is a tool prefix (reserved-word validated). See {@link ConfigTabController}.
 * @type {import('./config-tab.js').ConfigTabSpec}
 */
const MCP_SPEC = {
  id: 'mcp',
  noun: 'server',
  formHostSelector: '#mcp-form',
  pollMs: MCP_POLL_MS,
  loadError: 'Failed to load MCP servers.',
  ops: {
    list: async () => (await mcpListServers()).servers || [],
    getConfig: () => mcpGetConfig(),
    setConfig: (scope, servers) => mcpSetConfig({ scope, servers }),
    restart: (name) => mcpServerControl({ server: name, action: 'restart' }),
    getLog: async (name) => (await mcpGetLog({ server: name })).log,
  },
  addLabel: 'Add server',
  emptyText: 'No MCP servers yet. Add one to give the assistant extra tools — for example a filesystem, GitHub, or database server.',
  // Importer seam: an "Import from…" button slots in next to Add later.
  toolbarExtra: (toolbar) => {
    const soon = document.createElement('span');
    soon.className = 'mcp-import-soon';
    soon.textContent = 'Importing from other apps is coming soon.';
    toolbar.appendChild(soon);
  },
  validateName: validateMcpServerName,
  dotClass: (s) => s.status || 'stopped',
  dotTitle: (s) => s.status || 'stopped',
  identityExtras: (s) => {
    if (!s.serverName) return null;
    const impl = document.createElement('span');
    impl.className = 'mcp-impl';
    impl.textContent = s.serverVersion ? `(${s.serverName} ${s.serverVersion})` : `(${s.serverName})`;
    return impl;
  },
  describe: (s) => formatMcpTokenCost(s),
  rowError: (s) => (s.status === 'failed' && s.error) ? (String(s.error).split('\n')[0] || '') : '',
  deleteConfirm: (name) => ({
    message: `Remove the MCP server "${name}"? Its tools will disappear from conversations.`,
    title: 'Remove server',
  }),
  formAddTitle: 'Add MCP server',
  namePlaceholder: 'name',
  nameHintAdd: 'A short id — becomes the tool prefix (mcp__<name>__…). No spaces or “/”.',
  nameHintEdit: 'Renaming means deleting and re-adding the server.',
  commandPlaceholder: 'npx',
  commandHint: 'The executable to launch (stdio transport).',
  argFirstPlaceholder: '-y',
  argRestPlaceholder: '@modelcontextprotocol/server-github',
  envKeyPlaceholder: 'API_TOKEN',
  saveFailMsg: 'Failed to save the server.',
};

/**
 * Spec for the "ACP agents" tab: an ACP agent is spawned per-conversation with
 * no persistent process, so status is just PATH-resolvability (no Restart/Log),
 * its name is a model id (no reserved word), and a successful save auto-enables
 * the ACP provider. See {@link ConfigTabController}.
 * @type {import('./config-tab.js').ConfigTabSpec}
 */
const ACP_SPEC = {
  id: 'acp',
  noun: 'agent',
  formHostSelector: '#acp-form',
  pollMs: ACP_POLL_MS,
  loadError: 'Failed to load ACP agents.',
  ops: {
    list: async () => (await acpListAgents()).agents || [],
    getConfig: () => acpGetConfig(),
    setConfig: (scope, agents) => acpSetConfig({ scope, agents }),
  },
  addLabel: 'Add agent',
  emptyText: 'No ACP agents yet. Add one — for example Gemini CLI in ACP mode — and it will appear as a model in the picker.',
  validateName: validateAcpAgentName,
  dotClass: (s) => acpDotClass(s.status),
  dotTitle: (s) => s.status || 'unavailable',
  describe: (s) => s.command || '(no command)',
  rowError: (s) => (s.status === 'unavailable' && s.error) ? s.error : '',
  deleteConfirm: (name) => ({
    message: `Remove the ACP agent "${name}"? It will disappear from the model picker.`,
    title: 'Remove agent',
  }),
  formAddTitle: 'Add ACP agent',
  namePlaceholder: 'gemini',
  nameHintAdd: 'A short id — becomes the model name in the picker. No spaces or “/”.',
  nameHintEdit: 'Renaming means deleting and re-adding the agent.',
  commandPlaceholder: 'gemini',
  commandHint: 'The agent executable to launch (resolved on PATH).',
  argFirstPlaceholder: '--experimental-acp',
  argRestPlaceholder: 'value',
  envKeyPlaceholder: 'API_KEY',
  saveFailMsg: 'Failed to save the agent.',
  // Provider AutoDetect is computed once at startup (sync.Once), so it won't
  // notice an agent added mid-session; enabling the provider closes that gap.
  // Only for an enabled agent — a disabled one adds nothing to the picker.
  onAfterSave: async ({ enabled }) => { if (enabled) await ensureAcpProviderEnabled(); },
};

/**
 * SettingsPanel - Configuration panel
 *
 * Displays a tabbed interface: Provider API Keys, Connectivity, and
 * Extensions.
 */
class SettingsPanel extends HTMLElement {
  constructor() {
    super();
    /** @type {string} @private */
    this.currentTab = 'providers';
    /** @type {object} @private */
    this.config = {};
    /** @type {any[]} @private */
    this.providers = [];
    /** @type {(() => void)|null} @private */
    this._releasePopupOpen = null;
    /** @type {boolean} @private */
    this._hasLoadedOnce = false;
    /** @type {number|undefined} @private */
    this._connectivityPollId = undefined;
    /** @type {number|undefined} @private - setInterval id for the Logs tab's tail poll. */
    this._logsPollId = undefined;
    /** @type {any[]} @private - Session log files reported by GET /api/logs. */
    this._logFiles = [];
    /** @type {string} @private - Absolute path of the log file shown in the viewer. */
    this._selectedLogPath = '';
    /** @type {number} @private - Byte offset already loaded into the viewer for the selected log. */
    this._logOffset = 0;
    /** @type {string} @private - Signature of the last-rendered picker file set (rebuild guard). */
    this._logFilesKey = '';
    /** @type {string} @private - Path the file-path control was last rendered for (rebuild guard). */
    this._filePathPath = '';
    /** @type {boolean} @private - True while a log tail fetch is in flight, so overlapping poll ticks don't double-append. */
    this._logTailBusy = false;
    /** @type {{lanEnabled: boolean, lanURLs: string[], tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, tunnelRelay: boolean, wanModes: WANMode[], clientCount: number, clients: ClientDescriptor[]}} @private */
    this.connectivity = { lanEnabled: false, lanURLs: [], tunnelEnabled: false, tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [], clientCount: 1, clients: [] };
    /** @type {((data: any) => void)|null} @private - Live update of the connected-client count while the panel is open. */
    this._onClientsChanged = null;
    /** @type {string} @private - Inline error from the most recent WAN action, set at the action site and cleared at the start of the next one. */
    this._wanError = '';
    /** @type {{provider: string, model: string, explicit?: boolean}} @private - Model new conversations are seeded with; explicit=false means automatic. */
    this.defaultModel = { provider: '', model: '', explicit: false };
    /** @type {((e: Event) => void)|null} @private - Re-syncs the Notifications controls when prefs change elsewhere (e.g. the header bell). */
    this._onAttentionPrefs = null;
    /** @type {HTMLElement|null} @private - The horizontally-scrollable tab strip; watched to drive its edge-fade affordance. */
    this._tabScrollEl = null;
    /** @type {(() => void)|null} @private */
    this._onTabScroll = null;
    /** @type {ResizeObserver|null} @private */
    this._tabResizeObserver = null;
    /** @type {ConfigTabController} @private - "MCP servers" tab (managed stdio subprocesses; Restart + Log). */
    this._mcpTab = new ConfigTabController(this, MCP_SPEC);
    /** @type {ConfigTabController} @private - "ACP agents" tab (per-conversation agents; no persistent process). */
    this._acpTab = new ConfigTabController(this, ACP_SPEC);
    /** @type {(() => void)|null} @private - Live refresh of the MCP tab off the plugin-changed broadcast. */
    this._onMcpChanged = null;
  }

  connectedCallback() {
    this.render();
    this.setupListeners();

    // Keep the Connectivity tab's connected-clients box live as viewers join or
    // leave, independent of the 2 s poll (which only runs while that tab is open).
    // Only the clients section re-renders — never the whole form — so open LAN/WAN
    // QR images and controls are left untouched.
    this._onClientsChanged = (/** @type {{count: number, clients: ClientDescriptor[]}} */ data) => {
      this.connectivity.clientCount = data.count;
      this.connectivity.clients = data.clients || [];
      if (this.currentTab === 'connectivity' && this._hasLoadedOnce) {
        this._refreshClientsSection();
      }
    };
    wsService.on('clients-changed', this._onClientsChanged);

    // Keep the MCP servers tab live: every config write / lifecycle change
    // auto-reconciles Go-side and broadcasts plugin-changed, so re-fetch and
    // re-render the list when that fires while the tab is open (this is what
    // flips a server starting→running without the user clicking). The 2 s poll
    // is a backstop for any missed broadcast.
    this._onMcpChanged = () => {
      if (this.currentTab === 'mcp' && this._hasLoadedOnce) {
        this._mcpTab.refresh();
      }
    };
    wsService.on('plugin-changed', this._onMcpChanged);
  }

  disconnectedCallback() {
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    this._mcpTab.stopPolling();
    this._acpTab.stopPolling();
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }
    if (this._onAttentionPrefs) {
      window.removeEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
      this._onAttentionPrefs = null;
    }
    if (this._onInfoCardsChanged) {
      window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
      this._onInfoCardsChanged = null;
    }
    if (this._onClientsChanged) {
      wsService.off('clients-changed', this._onClientsChanged);
      this._onClientsChanged = null;
    }
    if (this._onMcpChanged) {
      wsService.off('plugin-changed', this._onMcpChanged);
      this._onMcpChanged = null;
    }
    if (this._tabScrollEl && this._onTabScroll) {
      this._tabScrollEl.removeEventListener('scroll', this._onTabScroll);
    }
    this._onTabScroll = null;
    if (this._tabResizeObserver) {
      this._tabResizeObserver.disconnect();
      this._tabResizeObserver = null;
    }
    this._tabScrollEl = null;
  }

  /**
   * Render the settings panel
   * @private
   */
  render() {
    this.innerHTML = `
            <modal-backdrop class="settings-backdrop" id="settings-backdrop"></modal-backdrop>
            <modal-panel class="settings-container">
                <button class="close-button" id="settings-close" title="Close" aria-label="Close">×</button>
                <nav class="settings-tabs">
                    <div class="settings-tabs-scroll">
                        <button class="settings-tab active" data-tab="providers">Provider API Keys</button>
                        <button class="settings-tab" data-tab="default-model">Provider settings</button>
                        <button class="settings-tab" data-tab="connectivity">Connectivity</button>
                        <button class="settings-tab" data-tab="extensions">Extensions</button>
                        <button class="settings-tab" data-tab="mcp">MCP servers</button>
                        <button class="settings-tab" data-tab="acp">ACP agents</button>
                        <button class="settings-tab" data-tab="notifications">Notifications</button>
                        <button class="settings-tab" data-tab="info-cards">Info cards</button>
                        <button class="settings-tab" data-tab="shortcuts">Keyboard shortcuts</button>
                        <button class="settings-tab" data-tab="logs">Logs</button>
                    </div>
                </nav>

                <div class="settings-loading" id="settings-loading">
                    <juggler-spinner style="--size: 2.5rem"></juggler-spinner>
                    <div class="settings-loading-text">Loading settings...</div>
                </div>

                <main class="settings-content">
                    <section class="settings-tab-content active" id="tab-providers">
                        <p class="settings-description">
                            To set a new API key, enter it below and click "Save API Keys".
                            <br/>
                            These are stored in <code>~/.juggler/credentials.json</code>.
                        </p>

                        <div class="settings-form" id="provider-form">
                            <div id="provider-fields-container"></div>
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-default-model">
                        <div class="settings-section-heading">Default model</div>
                        <div class="settings-form" id="default-model-form">
                            <div id="default-model-field-container"></div>
                        </div>

                        <div class="settings-form" id="global-provider-settings"></div>
                    </section>

                     <section class="settings-tab-content" id="tab-extensions">
                         <plugin-catalog></plugin-catalog>
                    </section>

                    <section class="settings-tab-content" id="tab-mcp">
                        <p class="settings-description">
                            Connect external tools via the Model Context Protocol. Servers run as
                            local subprocesses; their tools appear to the assistant with approval.
                        </p>
                        <div class="settings-form" id="mcp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-acp">
                        <p class="settings-description">
                            Drive external agents that speak the Agent Client Protocol (e.g. Gemini
                            CLI, Zed agents). Each runs as a local subprocess and appears as a model
                            in the picker under the ACP provider. The agent runs its own tool loop.
                        </p>
                        <div class="settings-form" id="acp-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-connectivity">
                        <p class="settings-description">
                            Control who can reach this Juggler instance.
                        </p>
                        <div class="settings-form" id="connectivity-form">
                        </div>
                    </section>

                    <section class="settings-tab-content" id="tab-notifications">
                        <div class="settings-form" id="notifications-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-info-cards">
                        <p class="settings-description">
                            Info cards fill the empty space above the Bin in the sidebar
                            when there's room. Choose which ones to show &mdash; the tabs
                            always take priority.
                        </p>
                        <div class="settings-form" id="info-cards-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-shortcuts">
                        <p class="settings-description">
                            Keyboard shortcuts for common actions. Modifier keys are shown
                            for ${navigator.platform && /mac|iphone|ipad/i.test(navigator.platform) ? 'macOS' : 'this platform'}.
                        </p>
                        <div class="settings-form" id="shortcuts-form"></div>
                    </section>

                    <section class="settings-tab-content" id="tab-logs">
                        <p class="settings-description">
                            Logs for the current session. Pick a file to view it live &mdash; it
                            updates as the app writes to it. To report a bug, reveal the file and
                            zip its folder.
                        </p>
                        <div class="settings-form" id="logs-form">
                            <div class="logs-empty" id="logs-empty">No log files yet.</div>
                            <div class="logs-controls" id="logs-controls" hidden>
                                <label class="logs-picker-label" for="logs-picker">Log file</label>
                                <select class="logs-picker" id="logs-picker"></select>
                            </div>
                            <div class="logs-filepath" id="logs-filepath"></div>
                            <pre class="logs-viewer" id="logs-viewer" tabindex="0" hidden></pre>
                        </div>
                    </section>
                </main>
            </modal-panel>
        `;
    // Notifications needs no server fetch (per-window localStorage prefs), so
    // build it immediately rather than waiting on loadConfig like the other tabs.
    this.renderNotificationsForm();
    // Shortcuts are read straight from the KeyShortcutManager — no server fetch.
    this.renderShortcutsForm();
    // Info-card toggles are per-window prefs (localStorage) — no server fetch.
    this.renderInfoCardsForm();
  }

  /**
   * Setup event listeners
   * @private
   */
  setupListeners() {
    // Close button
    const closeButton = this.querySelector('#settings-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => this.close());
    }

    // Close on backdrop click
    const backdrop = this.querySelector('#settings-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', () => this.close());
    }

    // Tab switching
    const tabButtons = this.querySelectorAll('.settings-tab');
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tab = /** @type {HTMLElement} */ (button).dataset.tab;
        this.switchTab(tab);
      });
    });

    // Logs tab: switch the viewer to whichever log the picker selects. The
    // <select> is persistent (only its <option>s are rebuilt), so this one
    // listener survives every list refresh.
    const logsPicker = this.querySelector('#logs-picker');
    if (logsPicker) {
      logsPicker.addEventListener('change', (e) =>
        this._selectLog(/** @type {HTMLSelectElement} */ (e.target).value));
    }

    // Drive the tab strip's edge-fade affordance from its actual scroll state,
    // so a left/right fade appears only when there really are tabs hidden past
    // that edge (see .settings-tabs-scroll in components.css). The ResizeObserver
    // recomputes when the panel is first shown (0→real width) or the viewport
    // changes; the scroll listener handles swiping and scrollIntoView jumps.
    const tabScroll = this.querySelector('.settings-tabs-scroll');
    if (tabScroll) {
      this._tabScrollEl = /** @type {HTMLElement} */ (tabScroll);
      this._onTabScroll = () => this._updateTabOverflow();
      tabScroll.addEventListener('scroll', this._onTabScroll, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        this._tabResizeObserver = new ResizeObserver(() => this._updateTabOverflow());
        this._tabResizeObserver.observe(tabScroll);
      }
      this._updateTabOverflow();
    }
  }

  /**
   * Toggle the tab strip's start/end edge fades to match what's scrolled out of
   * view, so hidden tabs past an edge are always signalled. Driven by the
   * strip's own scroll/resize events, never from a render path.
   * @private
   */
  _updateTabOverflow() {
    const el = this._tabScrollEl;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    el.classList.toggle('overflow-start', el.scrollLeft > 1);
    el.classList.toggle('overflow-end', el.scrollLeft < maxScroll - 1);
  }

  /**
   * Switch to a different tab
   * @param {string|undefined} tabName - The tab to switch to
   * @private
   */
  switchTab(tabName) {
    if (!tabName) return;

    // Back-compat: the Extensions tab was historically the "context-items" tab
    // (it hosts <plugin-catalog>). Accept the old id so any saved/deep-linked
    // caller still lands on the right tab.
    if (tabName === 'context-items') tabName = 'extensions';

    this.currentTab = tabName;

    // Update tab buttons
    const tabButtons = this.querySelectorAll('.settings-tab');
    tabButtons.forEach(button => {
      const htmlButton = /** @type {HTMLElement} */ (button);
      if (htmlButton.dataset.tab === tabName) {
        button.classList.add('active');
        // Bring an off-screen tab into the horizontally-scrollable strip (the
        // strip swipes on narrow screens). Guarded for jsdom, where
        // scrollIntoView is absent.
        htmlButton.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
      } else {
        button.classList.remove('active');
      }
    });

    // Update tab content
    const tabContents = this.querySelectorAll('.settings-tab-content');
    tabContents.forEach(content => {
      if (content.id === `tab-${tabName}`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    // Per-tab background pollers: stop whichever was running, then arm the one
    // for the tab being shown, so neither polls while its tab is hidden.
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    this._mcpTab.stopPolling();
    this._acpTab.stopPolling();

    if (tabName === 'connectivity' && this._hasLoadedOnce) {
      this.refreshConnectivity();
      this._connectivityPollId = setInterval(() => this.refreshConnectivity(), CONNECTIVITY_POLL_MS);
    } else if (tabName === 'logs') {
      // The Logs tab fetches its own data (independent of loadConfig), so it
      // works even when opened directly on first load.
      this._openLogsTab();
      this._logsPollId = setInterval(() => this._pollLogTail(), LOGS_POLL_MS);
    } else if (tabName === 'mcp') {
      // The MCP/ACP tabs fetch their own data (via ops), so they work when
      // opened directly; each controller arms its own status poll while shown.
      this._mcpTab.show();
    } else if (tabName === 'acp') {
      this._acpTab.show();
    }
  }

  /**
   * Open the settings panel
   * @param {string} [tab] - Optional tab to switch to on open
   */
  async open(tab) {
    const isFirstLoad = !this._hasLoadedOnce;

    // Show panel - only show loading state on first load
    this.classList.add('show');
    if (isFirstLoad) {
      this.classList.remove('loaded');
    }

    // Escape and the browser/mobile Back button dismiss via popup-manager.
    if (!this._releasePopupOpen) {
      this._releasePopupOpen = markPopupOpen(() => this.close());
    }

    // Switch to specified tab if provided (before loading so tab is ready)
    if (tab) {
      this.switchTab(tab);
    }

    // Load config (only fetches from API on first load)
    if (isFirstLoad) {
      await this.loadConfig();
      this._hasLoadedOnce = true;
      this.classList.add('loaded');
    }
  }

  /**
   * Close the settings panel
   */
  close() {
    this.classList.remove('show');
    clearInterval(this._connectivityPollId);
    this._connectivityPollId = undefined;
    clearInterval(this._logsPollId);
    this._logsPollId = undefined;
    if (this._releasePopupOpen) {
      this._releasePopupOpen();
      this._releasePopupOpen = null;
    }

    // Stop each config tab's poll and drop any in-progress add/edit form and
    // open log/error so a reopen starts fresh at the list — the generic
    // text-input clear below would otherwise blank the form's fields while
    // leaving its working state set.
    this._mcpTab.close();
    this._acpTab.close();

    // Clear any unsaved input fields and update buttons
    const inputs = this.querySelectorAll('input[type="text"]');
    inputs.forEach(input => {
      /** @type {HTMLInputElement} */ (input).value = '';
    });
    this.updateAllButtons();
  }

  /**
   * Load current configuration from backend
   * @param {boolean} [renderFields=true] - Whether to render form fields (false when just updating status)
   * @private
   */
  async loadConfig(renderFields = true) {
    try {
      // Load config, providers, the default model, and connectivity state
      const [configResponse, providersResponse, defaultModelResponse, connectivityResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/providers'),
        fetch('/api/default-model'),
        fetch('/api/connectivity'),
      ]);

      if (!configResponse.ok) {
        throw new Error('Failed to load config');
      }
      if (!providersResponse.ok) {
        throw new Error('Failed to load providers');
      }

      this.config = await configResponse.json();
      const providersData = await providersResponse.json();
      this.providers = (providersData.providers || []).sort((/** @type {any} */ a, /** @type {any} */ b) =>
        a.displayName.localeCompare(b.displayName)
      );
      if (defaultModelResponse.ok) {
        this.defaultModel = await defaultModelResponse.json();
      }
      if (connectivityResponse.ok) {
        this.connectivity = await connectivityResponse.json();
      }

      // Generate provider form fields dynamically (only on initial load)
      if (renderFields) {
        this.renderProviderFields();
        this.renderGlobalProviderSettings();
        this.renderDefaultModelField();
        this.renderConnectivityFields();
      }

      // Update all buttons and placeholders
      this.updateAllButtons();
    } catch (error) {
      console.error('Failed to load config:', error);
      if (window.showAlert) {
        await window.showAlert('Failed to load configuration', 'Error');
      }
    }
  }

  /**
   * Render provider form fields dynamically based on available providers
   * @private
   */
  renderProviderFields() {
    const container = this.querySelector('#provider-fields-container');
    if (!container) return;

    // Clear existing fields
    container.innerHTML = '';

    // Generate a field for each provider
    for (const provider of this.providers) {
      if (provider.authType === 'oauth_bearer') {
        this._buildOAuthProviderField(provider, container);
        continue;
      }

      // Keyless provider (like Claude Code, Ollama) - show toggle instead of API key input
      if (provider.configKeyName === '') {
        this._buildKeylessProviderField(provider, container);
        continue;
      }

      // API key provider - show input field
      this._buildApiKeyProviderField(provider, container);
    }
  }

  /**
   * Render global provider settings that apply across every provider, shown
   * as a section on the Provider settings tab. Currently just the stream idle
   * timeout: the
   * window a streaming provider waits for the next event before declaring the
   * connection dead ("stream stalled: no data for 3m0s"). Raising it helps
   * gateways whose cold starts exceed the 180s default. Persists to
   * credentials.json via PUT /api/config; the server reads it live.
   * @private
   */
  renderGlobalProviderSettings() {
    const container = this.querySelector('#global-provider-settings');
    if (!container) return;
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.textContent = 'Stream idle timeout';
    container.appendChild(heading);

    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = 'Seconds to wait';
    infoColumn.appendChild(nameLabel);
    const description = document.createElement('div');
    description.className = 'provider-description';
    description.textContent =
      'Seconds to wait for the next stream event before treating the connection ' +
      'as dropped ("stream stalled"). Raise it for gateways with slow cold ' +
      'starts. Leave blank for the default (180).';
    infoColumn.appendChild(description);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const row = document.createElement('div');
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'stream-idle-timeout-input';
    input.inputMode = 'numeric';
    input.placeholder = '180';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).streamIdleTimeout || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).streamIdleTimeout || '')) return;
      if (value !== '' && !/^\d+$/.test(value)) {
        status.textContent = 'Enter a whole number of seconds.';
        return;
      }
      if (value !== '' && parseInt(value, 10) <= 0) {
        status.textContent = 'Must be greater than zero.';
        return;
      }
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stream_idle_timeout: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config).streamIdleTimeout = value;
        status.textContent = value ? `Saved. Waiting up to ${value}s.` : 'Saved. Using default (180s).';
      } catch (e) {
        console.error('[SettingsPanel] Failed to save stream idle timeout:', e);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    controlColumn.appendChild(row);
    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for an OAuth (bearer) provider: name, optional
   * description and a sign-in status line, with no API-key input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildOAuthProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = provider.available
      ? (provider.authHint || 'Signed in')
      : (provider.authHint || 'Sign in to continue');
    controlColumn.appendChild(status);

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for a keyless provider (like Claude Code, Ollama): name,
   * optional description and an enable/disable toggle in place of an API-key
   * input.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildKeylessProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    if (provider.description) {
      const description = document.createElement('div');
      description.className = 'provider-description';
      description.textContent = provider.description;
      infoColumn.appendChild(description);
    }

    const toggleWrapper = document.createElement('div');
    toggleWrapper.className = 'provider-toggle-wrapper';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = `${provider.name}-toggle`;
    toggle.className = 'provider-toggle';
    toggle.checked = provider.available;

    const toggleLabel = document.createElement('label');
    toggleLabel.setAttribute('for', toggle.id);
    toggleLabel.className = 'toggle-switch';

    toggle.addEventListener('change', async () => {
      await this.toggleProviderEnabled(provider, toggle.checked);
    });

    toggleWrapper.appendChild(toggle);
    toggleWrapper.appendChild(toggleLabel);
    controlColumn.appendChild(toggleWrapper);

    // Ollama: expose the daemon host so users can point at a
    // non-default (LAN / remote) Ollama instance without
    // restarting the app. Saved as the `ollama_host` raw
    // credential; backend re-fetches the model list on change.
    if (provider.name === 'ollama') {
      controlColumn.appendChild(this._buildOllamaHostRow());
    }

    // Claude Code: let users point at the `claude` CLI explicitly for obscure
    // install locations auto-detection can't reach. Saved as the
    // `claudecode_binary_path` raw credential; a non-empty save also enables
    // the provider so it becomes selectable without restarting.
    if (provider.name === 'claudecode') {
      controlColumn.appendChild(this._buildClaudeBinaryRow(provider, toggle));
    }

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the field for an API-key provider: name, optional "Get API Key"
   * link, the key input with save/delete buttons, active badge and source
   * hint.
   * @param {any} provider - Provider info object
   * @param {Element} container - Element to append the field group to
   * @private
   */
  _buildApiKeyProviderField(provider, container) {
    const fieldGroup = document.createElement('div');
    fieldGroup.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const fieldId = `${provider.name}-key`;
    const saveButtonId = `${provider.name}-save`;
    const deleteButtonId = `${provider.name}-delete`;

    const nameLabel = document.createElement('label');
    nameLabel.className = 'provider-name';
    nameLabel.setAttribute('for', fieldId);
    nameLabel.textContent = provider.displayName;
    infoColumn.appendChild(nameLabel);

    // "Get API Key" link
    if (provider.apiKeyURL) {
      const keyLink = document.createElement('a');
      keyLink.href = provider.apiKeyURL;
      keyLink.target = '_blank';
      keyLink.rel = 'noopener noreferrer';
      keyLink.className = 'get-api-key-link';
      keyLink.textContent = 'Get API Key \u2192';
      infoColumn.appendChild(keyLink);
    }

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId;
    input.name = provider.configKeyName;
    input.placeholder = '...';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;

    const activeBadge = document.createElement('span');
    activeBadge.id = `${provider.name}-active-badge`;
    activeBadge.className = 'provider-active-badge';
    activeBadge.style.display = 'none';
    activeBadge.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg><span>key is active</span>';

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'provider-buttons';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.id = saveButtonId;
    saveButton.className = 'settings-btn primary small';
    saveButton.textContent = 'Save';
    saveButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.id = deleteButtonId;
    deleteButton.className = 'settings-btn danger small';
    deleteButton.textContent = 'Delete';
    deleteButton.style.display = 'none';

    // Add input event listener to update buttons
    input.addEventListener('input', () => {
      this.updateAllButtons();
    });

    // Save button handler
    saveButton.addEventListener('click', async () => {
      await this.saveProviderKey(provider, input.value.trim());
    });

    // Delete button handler
    deleteButton.addEventListener('click', async () => {
      await this.deleteProviderKey(provider);
    });

    buttonGroup.appendChild(saveButton);
    buttonGroup.appendChild(deleteButton);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(activeBadge);
    inputWrapper.appendChild(buttonGroup);

    const sourceHint = document.createElement('div');
    sourceHint.id = `${provider.name}-source`;
    sourceHint.className = 'key-source-hint';
    sourceHint.style.display = 'none';

    controlColumn.appendChild(inputWrapper);
    controlColumn.appendChild(sourceHint);

    // OpenAI-compatible: expose the gateway base URL and optional custom
    // request headers (JSON), so one provider covers any Chat-Completions
    // gateway. Saved as raw credentials; the backend re-fetches models on save.
    if (provider.name === 'openai-compatible') {
      controlColumn.appendChild(this._buildOpenAICompatRows());
    }

    fieldGroup.appendChild(infoColumn);
    fieldGroup.appendChild(controlColumn);
    container.appendChild(fieldGroup);
  }

  /**
   * Build the base-URL and custom-headers rows for the OpenAI-compatible
   * provider. Base URL saves as `openai_compatible_base_url`; headers save as
   * `openai_compatible_headers` (a JSON object string). Both persist via
   * /api/config on blur or Enter; empty clears the override.
   * @returns {HTMLElement} The rows wrapper to append to the control column.
   * @private
   */
  _buildOpenAICompatRows() {
    const wrapper = document.createElement('div');

    /**
     * @param {string} key - config key posted to /api/config
     * @param {string} configField - camelCase field on this.config
     * @param {string} placeholder - input placeholder
     * @param {(v: string) => string|null} validate - returns an error string or null
     * @returns {HTMLElement} The input row element.
     */
    const buildRow = (key, configField, placeholder, validate) => {
      const row = document.createElement('div');
      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'provider-input-wrapper';

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.spellcheck = false;
      input.value = /** @type {any} */ (this.config)[configField] || '';
      inputWrapper.appendChild(input);
      row.appendChild(inputWrapper);

      const status = document.createElement('div');
      status.className = 'key-source-hint';
      row.appendChild(status);

      const save = async () => {
        const value = input.value.trim();
        if (value === (/** @type {any} */ (this.config)[configField] || '')) return;
        const err = validate(value);
        if (err) {
          status.textContent = err;
          return;
        }
        status.textContent = 'Saving…';
        try {
          const response = await fetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
          });
          if (!response.ok) throw new Error(`Server returned ${response.status}`);
          /** @type {any} */ (this.config)[configField] = value;
          status.textContent = value ? 'Saved.' : 'Cleared.';
        } catch (e) {
          console.error(`[SettingsPanel] Failed to save ${key}:`, e);
          status.textContent = 'Failed to save.';
        }
      };

      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
          input.blur();
        }
      });
      return row;
    };

    wrapper.appendChild(buildRow(
      'openai_compatible_base_url', 'openaiCompatibleBaseURL',
      'https://gateway.example.com/v1', () => null,
    ));
    wrapper.appendChild(buildRow(
      'openai_compatible_headers', 'openaiCompatibleHeaders',
      '{"User-Agent": "my-app/1.0"}',
      (v) => {
        if (v === '') return null;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return 'Headers must be a JSON object.';
          }
          return null;
        } catch {
          return 'Invalid JSON.';
        }
      },
    ));

    return wrapper;
  }

  /**
   * Render the single "Default model" picker. The dropdown offers an
   * "Automatic" option (server picks a preferred available model) plus every
   * model grouped by provider. The current default is preselected; changing
   * it persists immediately via PUT /api/default-model.
   * @private
   */
  renderDefaultModelField() {
    const container = this.querySelector('#default-model-field-container');
    if (!container) return;
    container.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const infoColumn = document.createElement('div');
    infoColumn.className = 'provider-info';
    const nameLabel = document.createElement('div');
    nameLabel.className = 'provider-name';
    nameLabel.textContent = 'New conversations use';
    infoColumn.appendChild(nameLabel);

    const controlColumn = document.createElement('div');
    controlColumn.className = 'provider-control';

    const select = document.createElement('select');
    select.className = 'default-model-select';
    select.id = 'default-model-select';

    const current = this.defaultModel || { provider: '', model: '', explicit: false };
    const explicit = !!current.explicit;
    const currentValue = explicit && current.provider && current.model
      ? `${current.provider} ${current.model}`
      : '';
    let currentValueIsValid = false;

    // "Automatic" — clears the stored value; the server then picks the
    // preferred available model when seeding a new conversation.
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = 'Automatic';
    if (!explicit) autoOpt.selected = true;
    select.appendChild(autoOpt);

    for (const provider of this.providers) {
      if (!provider.modelsWithContext || provider.modelsWithContext.length === 0) continue;
      const group = document.createElement('optgroup');
      group.label = provider.available
        ? provider.displayName
        : `${provider.displayName} (no API key)`;
      for (const m of /** @type {Array<{id: string, displayName?: string}>} */ (provider.modelsWithContext)) {
        const opt = document.createElement('option');
        const val = `${provider.name} ${m.id}`;
        opt.value = val;
        opt.textContent = modelLabel(m.displayName, m.id);
        if (val === currentValue) {
          opt.selected = true;
          currentValueIsValid = true;
        }
        group.appendChild(opt);
      }
      select.appendChild(group);
    }

    // An explicitly-set model that is no longer in the provider list:
    // surface it as a selected "unavailable" option so the state is visible.
    if (currentValue && !currentValueIsValid) {
      const orphanGroup = document.createElement('optgroup');
      orphanGroup.label = 'Currently set (unavailable)';
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.selected = true;
      const refProvider = this.providers.find((/** @type {any} */ p) => p.name === current.provider);
      opt.textContent = `${refProvider ? modelLabelFromList(this.providers, refProvider.name, current.model) : `${current.provider} / ${current.model}`} — unavailable`;
      orphanGroup.appendChild(opt);
      select.insertBefore(orphanGroup, select.firstChild ? select.firstChild.nextSibling : null);
    }

    select.addEventListener('change', () => this._saveDefaultModel(select.value));

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    status.style.display = 'block';
    status.textContent = this._defaultModelStatusText(current);

    controlColumn.appendChild(select);
    controlColumn.appendChild(status);

    row.appendChild(infoColumn);
    row.appendChild(controlColumn);
    container.appendChild(row);
  }

  /**
   * @param {{provider: string, model: string, explicit?: boolean}} ref
   * @returns {string} short status describing the current default-model state
   * @private
   */
  _defaultModelStatusText(ref) {
    if (!ref || !ref.explicit) {
      if (ref && ref.provider && ref.model) {
        return `Automatic — currently ${modelLabelFromList(this.providers, ref.provider, ref.model)}.`;
      }
      return 'Automatic — no provider is configured yet.';
    }
    const p = this.providers.find((/** @type {any} */ pp) => pp.name === ref.provider);
    if (!p) return 'Provider not registered.';
    if (!p.available) return p.authType === 'oauth_bearer'
      ? (p.authHint || 'Provider is unavailable. Sign in to continue.')
      : 'Provider is configured but has no API key.';
    const hasModel = p.modelsWithContext && p.modelsWithContext.some((/** @type {{id: string}} */ m) => m.id === ref.model);
    if (p.modelsWithContext && !hasModel) {
      return 'Model is not in the provider’s current model list.';
    }
    return 'Active.';
  }

  /**
   * Persist the chosen default model. An empty value clears it (Automatic).
   * @param {string} value - "<provider> <model>" or "" for Automatic
   * @private
   */
  async _saveDefaultModel(value) {
    let body;
    if (!value) {
      body = { provider: '', model: '' };
    } else {
      const sep = value.indexOf(' ');
      body = { provider: value.slice(0, sep), model: value.slice(sep + 1) };
    }
    try {
      const response = await fetch('/api/default-model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      // Reflect the saved state locally and re-render so the status hint
      // and selection update without a full reload.
      this.defaultModel = { provider: body.provider, model: body.model, explicit: !!(body.provider && body.model) };
      this.renderDefaultModelField();
    } catch (err) {
      console.error('[SettingsPanel] Failed to save default model:', err);
      if (window.showAlert) {
        await window.showAlert('Failed to save default model.', 'Error');
      }
    }
  }

  /**
   * Build the host-URL input row for the Ollama provider. Loads the
   * current value from `this.config.ollamaHost`; saves via /api/config on
   * blur or Enter. Empty value clears the override (falls back to env var
   * or default localhost:11434 on the server).
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildOllamaHostRow() {
    // Wrapper is a no-op fragment-like div so the caller can append a
    // single child; visual layout comes from the parent `.provider-control`
    // column (`flex-direction: column; gap: 0.375rem`).
    const row = document.createElement('div');

    // Reuse the same wrapper as API-key rows so the input picks up the
    // shared border / focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'ollama-host-input';
    input.placeholder = 'http://localhost:11434';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).ollamaHost || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).ollamaHost || '')) return;
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ollama_host: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config).ollamaHost = value;
        status.textContent = value
          ? `Saved. Pointing at ${value}.`
          : 'Saved. Using default (http://localhost:11434).';
      } catch (err) {
        console.error('[SettingsPanel] Failed to save Ollama host:', err);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    return row;
  }

  /**
   * Build the CLI binary-path input row for the Claude Code provider. Loads the
   * current value from `this.config.claudecodeBinaryPath`; saves via /api/config
   * on blur or Enter. Empty clears the override (falls back to JUGGLER_CLAUDE_PATH
   * then auto-detection on the server). A non-empty save also enables the
   * provider so it becomes selectable without a restart.
   * @param {any} provider - Provider info object (for the enable call)
   * @param {HTMLInputElement} toggle - The provider's enable checkbox, kept in sync
   * @returns {HTMLElement} The row element to append to the control column.
   * @private
   */
  _buildClaudeBinaryRow(provider, toggle) {
    const row = document.createElement('div');

    // Reuse the API-key row wrapper so the input inherits the shared border /
    // focus-ring styling without provider-specific CSS.
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'provider-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'claudecode-binary-input';
    input.placeholder = 'CLI path (leave blank for auto)';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.value = /** @type {any} */ (this.config).claudecodeBinaryPath || '';
    inputWrapper.appendChild(input);
    row.appendChild(inputWrapper);

    const status = document.createElement('div');
    status.className = 'key-source-hint';
    row.appendChild(status);

    const save = async () => {
      const value = input.value.trim();
      if (value === (/** @type {any} */ (this.config).claudecodeBinaryPath || '')) return;
      status.textContent = 'Saving…';
      try {
        const response = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claudecode_binary_path: value }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        /** @type {any} */ (this.config).claudecodeBinaryPath = value;
        if (value) {
          // A user pointing us at a binary means "use Claude Code" — enable it
          // (and reflect that in the toggle) so the model is immediately
          // selectable without a separate click.
          if (!toggle.checked) {
            toggle.checked = true;
            await this.toggleProviderEnabled(provider, true);
          }
          status.textContent = `Saved. Using ${value}.`;
        } else {
          status.textContent = 'Saved. Auto-detecting the claude CLI.';
        }
      } catch (err) {
        console.error('[SettingsPanel] Failed to save Claude Code binary path:', err);
        status.textContent = 'Failed to save.';
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        input.blur();
      }
    });

    return row;
  }

  /**
   * Toggle enabled state for a keyless provider
   * @param {any} provider - Provider info object
   * @param {boolean} enabled - Whether to enable or disable the provider
   * @private
   */
  async toggleProviderEnabled(provider, enabled) {
    try {
      const response = await fetch('/api/config/provider-enabled', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: provider.name,
          enabled: enabled
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update provider');
      }

      // Refresh model selector to pick up new provider
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to toggle provider:', error);
      // Revert toggle on error
      const toggle = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-toggle`));
      if (toggle) {
        toggle.checked = !enabled;
      }
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to update provider',
          'Error'
        );
      }
    }
  }

  /**
   * Update all provider buttons and placeholders based on current state
   * @private
   */
  updateAllButtons() {
    const configObj = /** @type {any} */ (this.config);

    for (const provider of this.providers) {
      const hasKey = configObj.keys?.[provider.name] || false;
      const input = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-key`));
      const saveButton = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-save`));
      const deleteButton = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-delete`));
      const sourceHint = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-source`));
      const activeBadge = /** @type {HTMLElement|null} */ (this.querySelector(`#${provider.name}-active-badge`));

      const inputHasValue = !!(input && input.value.trim() !== '');

      // Update placeholder based on key source
      if (input) {
        if (provider.keySource === 'env') {
          input.placeholder = `using $${provider.envVarName}`;
          input.disabled = true;
        } else if (hasKey) {
          input.placeholder = '';
          input.disabled = false;
        } else {
          input.placeholder = 'enter a key';
          input.disabled = false;
        }
      }

      // Show "key is active" badge when a credentials-file key exists and the
      // input is empty (i.e. user isn't currently typing a replacement).
      if (activeBadge) {
        const showBadge = hasKey && provider.keySource !== 'env' && !inputHasValue;
        activeBadge.style.display = showBadge ? 'inline-flex' : 'none';
      }

      // Update source hint
      if (sourceHint) {
        if (provider.keySource === 'env') {
          sourceHint.textContent = `Using environment variable $${provider.envVarName}`;
          sourceHint.style.display = 'block';
        } else {
          sourceHint.textContent = '';
          sourceHint.style.display = 'none';
        }
      }

      // Show save button only if input has value and key is not from env var
      if (saveButton) {
        const hasInputValue = input && input.value.trim() !== '';
        saveButton.style.display = (hasInputValue && provider.keySource !== 'env') ? 'block' : 'none';
      }

      // Show delete button only if key exists in credentials file (not env var)
      if (deleteButton) {
        deleteButton.style.display = (hasKey && provider.keySource !== 'env') ? 'block' : 'none';
      }
    }
  }

  /**
   * Save API key for a specific provider
   * @param {any} provider - Provider info object
   * @param {string} apiKey - API key to save
   * @returns {Promise<void>} Completes when the API key is saved
   * @private
   */
  async saveProviderKey(provider, apiKey) {
    if (!apiKey) return;

    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          [provider.configKeyName]: apiKey
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save API key');
      }

      // Clear the input so the UI returns to the "key is active" state
      const input = /** @type {HTMLInputElement|null} */ (this.querySelector(`#${provider.name}-key`));
      if (input) input.value = '';

      // Reload config from server to get actual state (don't re-render fields)
      await this.loadConfig(false);

      // Refresh model selector to pick up new provider
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to save API key:', error);
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to save API key',
          'Error'
        );
      }
    }
  }

  /**
   * Fetch current connectivity state and re-render the connectivity fields.
   * @param {boolean} [force=false] - Re-render even when the server state is
   *   unchanged. Action handlers pass true so a busy button resets and any
   *   inline error shows even on a no-op result; the background poll leaves it
   *   false so an unchanged tick is a no-op.
   * @private
   */
  async refreshConnectivity(force = false) {
    try {
      const res = await fetch('/api/connectivity');
      if (!res.ok) return;
      const next = await res.json();
      const prev = this.connectivity;
      this.connectivity = next;
      // The connected-clients section owns no inputs or QR images, so refresh it
      // every tick — that keeps the relative "connected N ago" times and the
      // membership current without a full-form rebuild.
      this._refreshClientsSection();
      // Skip the full re-render if nothing observable in the LAN/WAN form has
      // changed. Without this the 2 s poll wipes the connectivity form
      // (innerHTML = '') every tick, killing input focus and re-loading QR
      // images. The client list is excluded here — it's handled just above.
      const serialise = (/** @type {any} */ c) => JSON.stringify({
        lanEnabled: c.lanEnabled,
        lanURLs: c.lanURLs || [],
        tunnelEnabled: c.tunnelEnabled,
        tunnelURL: c.tunnelURL || '',
        tunnelMode: c.tunnelMode || '',
        tunnelRelay: !!c.tunnelRelay,
        wanModes: c.wanModes || [],
      });
      if (!force && prev && serialise(prev) === serialise(next)) return;
      this.renderConnectivityFields();
    } catch (e) {
      console.error('Failed to refresh connectivity:', e);
    }
  }

  /**
   * Render the Notifications tab: per-window attention prefs (sound, notify) plus
   * abstract rotary controls for the chime voice. Reads initial values from
   * {@link getAttentionPrefs} (localStorage, no server fetch) and keeps the
   * controls in sync with the header bell via {@link ATTENTION_PREFS_EVENT} — so
   * the sound toggle and the bell always reflect the same `sound` pref.
   * @private
   */
  renderNotificationsForm() {
    const container = this.querySelector('#notifications-form');
    if (!container) return;
    const prefs = getAttentionPrefs();

    container.innerHTML = '';

    // The conversation's tab in the bar ALWAYS flashes when it needs you — that's
    // not a setting. This toggle governs only the extra out-of-app signal, which
    // differs by mode: a Dock-icon bounce in the desktop app, or a marker on this
    // browser tab's title in a browser. The copy names whichever one applies.
    const desktopApp = document.documentElement.dataset.windowMode === '1';

    // ── On/off toggles ────────────────────────────────────────────────
    // The sound toggle is the same `sound` pref the header bell drives; flipping
    // either updates the other live via ATTENTION_PREFS_EVENT.
    const soundRow = this._buildAttentionToggleRow(
      'Play notification sounds',
      'Chime when a conversation you’re not viewing needs you. Also toggled by the header bell.',
      prefs.sound,
      (on) => setSoundEnabled(on),
    );
    const notifyRow = this._buildAttentionToggleRow(
      desktopApp ? 'Bounce the Dock icon' : 'Flash the browser tab',
      desktopApp
        ? 'When a conversation needs attention, bounce the app’s Dock icon.'
        : 'When a conversation needs attention, mark this browser tab’s title so you can spot it',
      prefs.notify,
      (on) => setNotifyEnabled(on),
    );
    container.appendChild(soundRow.row);
    container.appendChild(notifyRow.row);

    // ── Chime voice controls (abstract, 0..1) ──────────────────────────
    const chimeRow = this._buildChimeControlsRow(prefs.chime);
    container.appendChild(chimeRow.row);

    // Keep this tab's controls in sync when prefs change elsewhere (the header
    // bell, or another open settings panel). Registered once; removed in
    // disconnectedCallback.
    if (!this._onAttentionPrefs) {
      this._onAttentionPrefs = () => {
        const p = getAttentionPrefs();
        soundRow.input.checked = p.sound;
        notifyRow.input.checked = p.notify;
        chimeRow.controls.pattern.setValue(p.chime.pattern);
        chimeRow.controls.sound.setValue(p.chime.sound);
        chimeRow.controls.volume.setValue(p.chime.volume);
      };
      window.addEventListener(ATTENTION_PREFS_EVENT, this._onAttentionPrefs);
    }
  }

  /**
   * Render the Keyboard shortcuts tab: every command from the KeyShortcutManager,
   * grouped by category, each showing its current binding for this platform. The
   * manager is the single source of truth, so this needs no server fetch. Read-only
   * for now; each row's `.provider-control` is where a future "record binding"
   * affordance will live.
   * @private
   */
  renderShortcutsForm() {
    const container = this.querySelector('#shortcuts-form');
    if (!container) return;
    container.innerHTML = '';

    for (const group of keyShortcutManager.byCategory()) {
      const heading = document.createElement('h3');
      heading.className = 'settings-section-heading';
      heading.textContent = group.category;
      container.appendChild(heading);

      for (const def of group.shortcuts) {
        container.appendChild(this._buildShortcutRow(def));
      }
    }
  }

  /**
   * Render the Info cards tab: one enable/disable toggle per ambient sidebar card
   * (Tips, Git status, …), read from the InfoCardsManager. No server fetch — these
   * are per-window localStorage prefs. This is where the Tips toggle now lives
   * (moved out of Keyboard shortcuts).
   * @private
   */
  renderInfoCardsForm() {
    const container = this.querySelector('#info-cards-form');
    if (!container) return;
    container.innerHTML = '';

    for (const card of allInfoCards()) {
      const { row, input } = this._buildAttentionToggleRow(
        card.label,
        card.description,
        card.enabled,
        (on) => setCardEnabled(card.id, on),
      );
      input.dataset.cardId = card.id;
      container.appendChild(row);
    }

    // Keep the toggles in sync when a card is hidden/re-enabled elsewhere (the ×
    // on a sidebar card fires INFO_CARDS_CHANGED_EVENT). Rebind to the current
    // inputs; removed in disconnectedCallback.
    if (this._onInfoCardsChanged) window.removeEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
    this._onInfoCardsChanged = () => {
      container.querySelectorAll('input[data-card-id]').forEach((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        if (input.dataset.cardId) input.checked = isCardEnabled(input.dataset.cardId);
      });
    };
    window.addEventListener(INFO_CARDS_CHANGED_EVENT, this._onInfoCardsChanged);
  }

  /**
   * Build one shortcut row: label + description on the left, the current key on
   * the right as a `<kbd>`.
   * @param {import('../services/key-shortcut-manager.js').ShortcutDef} def - The shortcut definition.
   * @returns {HTMLElement} The row element.
   * @private
   */
  _buildShortcutRow(def) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field shortcut-row';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = def.label;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = def.description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control shortcut-control';
    const key = document.createElement('kbd');
    key.className = 'shortcut-keycap';
    key.textContent = keyShortcutManager.formatBinding(def.id);
    ctrl.appendChild(key);

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Build a labelled on/off toggle row matching the keyless-provider toggle
   * markup (`.provider-toggle-wrapper` > checkbox + `.toggle-switch` label).
   * @param {string} name - Control label.
   * @param {string} description - Sub-label hint.
   * @param {boolean} checked - Initial state.
   * @param {(on: boolean) => void} onChange - Called with the new state.
   * @returns {{row: HTMLElement, input: HTMLInputElement}} The row and its checkbox input.
   * @private
   */
  _buildAttentionToggleRow(name, description, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'provider-name';
    nameEl.textContent = name;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = description;
    info.appendChild(nameEl);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';
    const wrapper = document.createElement('div');
    wrapper.className = 'provider-toggle-wrapper';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'provider-toggle';
    input.id = `attention-${name.toLowerCase().replace(/[^a-z]+/g, '-')}-toggle`;
    input.checked = checked;
    const label = document.createElement('label');
    label.setAttribute('for', input.id);
    label.className = 'toggle-switch';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.appendChild(input);
    wrapper.appendChild(label);
    ctrl.appendChild(wrapper);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, input };
  }

  /**
   * Build the chime customisation section: a Pattern popup and a Sound popup (the
   * curated menus), a Volume rotary, and the preview/reset buttons.
   * @param {import('../utils/chime-synth.js').ChimeParams} chime
   * @returns {{row: HTMLElement, controls: {pattern: {setValue: (v: string) => void}, sound: {setValue: (v: string) => void}, volume: {setValue: (v: number) => void}}}} The row and named controls.
   * @private
   */
  _buildChimeControlsRow(chime) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field chime-controls-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Chime';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Pick a pattern and sound, set the volume, and preview it.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control chime-controls';

    // The two curated popup menus (tune + timbre).
    const menus = document.createElement('div');
    menus.className = 'chime-menus';
    const pattern = this._buildChimeSelect('Pattern', chimePatterns(), chime.pattern, (v) => {
      setChimeParam('pattern', v);
      previewChime();
    });
    const sound = this._buildChimeSelect('Sound', chimeSounds(), chime.sound, (v) => {
      setChimeParam('sound', v);
      previewChime();
    });
    menus.appendChild(pattern.el);
    menus.appendChild(sound.el);
    ctrl.appendChild(menus);

    // The volume rotary sits with the preview/reset buttons on the action row.
    const actions = document.createElement('div');
    actions.className = 'chime-actions';
    const volume = this._buildChimeRotary('Volume', chime.volume, (v) => setChimeParam('volume', v), () => previewChime());
    actions.appendChild(volume.el);

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'settings-btn primary small chime-preview-btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => previewChime());
    actions.appendChild(previewBtn);

    // Reset every control to the default voice. The resulting prefs event
    // re-syncs the menus/rotary via _onAttentionPrefs, then we preview it.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'settings-btn small chime-reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      resetChimeParams();
      previewChime();
    });
    actions.appendChild(resetBtn);

    ctrl.appendChild(actions);

    row.appendChild(info);
    row.appendChild(ctrl);
    return { row, controls: { pattern, sound, volume } };
  }

  /**
   * Build one labelled popup menu (a native `<select>`) for a curated chime list.
   * @param {string} name - Control label ('Pattern' | 'Sound').
   * @param {Array<{id: string, name: string}>} options - The menu entries.
   * @param {string} value - The currently selected id.
   * @param {(v: string) => void} onChange - Called with the new id on selection.
   * @returns {{el: HTMLElement, select: HTMLSelectElement, setValue: (v: string) => void}} The wrapper, select, and setter.
   * @private
   */
  _buildChimeSelect(name, options, value, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-select-field';

    const label = document.createElement('span');
    label.className = 'chime-select-label';
    label.textContent = name;

    const select = document.createElement('select');
    select.className = 'chime-select';
    select.setAttribute('aria-label', name);
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.id;
      el.textContent = opt.name;
      select.appendChild(el);
    }
    const setValue = (/** @type {string} */ v) => {
      select.value = v;
      // A stored id no longer in the list (a removed entry) leaves value unset;
      // fall back to the first option so the menu always shows a real choice.
      if (!select.value && select.options.length) select.selectedIndex = 0;
    };
    setValue(value);
    select.addEventListener('change', () => onChange(select.value));

    wrap.appendChild(label);
    wrap.appendChild(select);
    return { el: wrap, select, setValue };
  }

  /**
   * Build one drag-up/down rotary chime control.
   * @param {string} name
   * @param {number} value
   * @param {(v: number) => void} onInput
   * @param {() => void} onRelease
   * @returns {{el: HTMLElement, input: HTMLInputElement, setValue: (v: number) => void}} The wrapper, hidden range input, and setter.
   * @private
   */
  _buildChimeRotary(name, value, onInput, onRelease) {
    const wrap = document.createElement('label');
    wrap.className = 'chime-rotary';

    const knob = document.createElement('span');
    knob.className = 'chime-rotary-knob';
    const outer = document.createElement('span');
    outer.className = 'chime-rotary-outer';
    const inner = document.createElement('span');
    inner.className = 'chime-rotary-inner';
    const tick = document.createElement('span');
    tick.className = 'chime-rotary-tick';
    knob.appendChild(outer);
    knob.appendChild(inner);
    knob.appendChild(tick);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'chime-rotary-input';
    input.min = '0';
    input.max = '1';
    input.step = '0.01';
    input.value = String(value);
    input.setAttribute('aria-label', name);
    input.setAttribute('orient', 'vertical');

    const label = document.createElement('span');
    label.className = 'chime-rotary-label';
    label.textContent = name;

    const setValue = (/** @type {number} */ v) => {
      const clamped = Math.max(0, Math.min(1, v));
      input.value = String(clamped);
      knob.style.setProperty('--angle', `${120 + (clamped * 300)}deg`);
    };

    let dragStartY = 0;
    let dragStartValue = 0;
    let dragging = false;
    /** @type {number | null} */
    let activePointerId = null;

    input.addEventListener('input', () => {
      setValue(Number(input.value));
      onInput(Number(input.value));
    });

    input.addEventListener('change', () => onRelease());

    // The move/end listeners live on window, not the knob, so a drag keeps
    // tracking the finger after it leaves the small dial — pointer capture is
    // unreliable in the mobile WebView, so we don't depend on it to hold.
    const onMove = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      const dy = dragStartY - e.clientY;
      if (Math.abs(dy) > 2) dragging = true;
      const next = dragStartValue + (dy / 140);
      setValue(next);
      onInput(Number(input.value));
    };
    const endDrag = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== activePointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      if (knob.hasPointerCapture(activePointerId)) knob.releasePointerCapture(activePointerId);
      activePointerId = null;
      if (e.type === 'pointercancel') return;
      if (!dragging) input.focus();
      onRelease();
    };

    knob.addEventListener('pointerdown', (e) => {
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      dragging = false;
      dragStartY = e.clientY;
      dragStartValue = Number(input.value);
      try { knob.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });

    setValue(value);
    wrap.appendChild(knob);
    wrap.appendChild(input);
    wrap.appendChild(label);
    return { el: wrap, input, setValue };
  }

  /**
   * Render the Connectivity tab content.
   * @private
   */
  renderConnectivityFields() {
    const container = this.querySelector('#connectivity-form');
    if (!container) return;
    const c = this.connectivity;

    container.innerHTML = '';

    // ── Connected clients ─────────────────────────────────────────────
    // Lists the OTHER clients sharing this session (this window excluded). The
    // box IS the section element (a standard provider-field row) so it keeps the
    // normal inter-box gap; _refreshClientsSection rebuilds only its contents,
    // so live updates never touch the LAN/WAN form below.
    const clientsSection = document.createElement('div');
    clientsSection.id = 'connectivity-clients-section';
    clientsSection.className = 'settings-group provider-field connectivity-clients';
    container.appendChild(clientsSection);
    this._refreshClientsSection();

    // ── LAN access row ────────────────────────────────────────────────
    container.appendChild(this._buildLANAccessRow(c));

    // ── WAN access section (one block per server-registered mode) ─────
    // A build with no registered WAN modes reports an empty list and gets
    // no WAN section at all.
    if ((c.wanModes || []).length > 0) {
      container.appendChild(this._buildWANAccessRow(c));
    }
  }

  /**
   * (Re)build the connected-clients box contents in place: a "Connected clients"
   * label on the left, and on the right a list with one line per OTHER client
   * (this window is filtered out by id) — its origin, device, and how long it's
   * been connected — or a muted "none" line. Safe to call before the box exists
   * (no-op) and cheap to call on every poll tick (no inputs or QR images).
   * @private
   */
  _refreshClientsSection() {
    const section = this.querySelector('#connectivity-clients-section');
    if (!section) return;

    const all = this.connectivity.clients || [];
    // Exclude our own window by id. Before the session id is known (a brief
    // window at startup) nothing matches, so drop one entry so we never count
    // ourselves as an "other" client.
    const selfId = wsService.clientId;
    let others = selfId ? all.filter((c) => c.id !== selfId) : all.slice(1);
    // Oldest first, so the list order stays stable as clients join.
    others = others.slice().sort((a, b) => (a.connectedAt || 0) - (b.connectedAt || 0));

    section.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'Connected clients';
    info.appendChild(name);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (others.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'connectivity-clients-empty';
      empty.textContent = 'No other clients connected';
      ctrl.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'connectivity-client-list';
      for (const c of others) {
        const li = document.createElement('li');
        li.className = 'connectivity-client';

        const dot = document.createElement('span');
        dot.className = `connectivity-client-dot origin-${c.origin || 'unknown'}`;
        li.appendChild(dot);

        const originEl = document.createElement('span');
        originEl.className = 'connectivity-client-origin';
        originEl.textContent = clientOriginLabel(c);
        li.appendChild(originEl);

        // Device + connected-since, muted. Either may be absent.
        const parts = [clientDeviceLabel(c.userAgent), formatTimeAgo(c.connectedAt)].filter(Boolean);
        if (parts.length) {
          const meta = document.createElement('span');
          meta.className = 'connectivity-client-meta';
          meta.textContent = parts.join(' — ');
          li.appendChild(meta);
        }

        list.appendChild(li);
      }
      ctrl.appendChild(list);
    }

    section.appendChild(info);
    section.appendChild(ctrl);
  }

  /**
   * Build the LAN access row: a Start/Stop control (matching the WAN mode
   * blocks) plus a URL/QR block per reachable LAN address when enabled.
   * @param {{lanEnabled: boolean, lanURLs: string[]}} c - Connectivity state
   * @returns {HTMLElement} The row element to append to the connectivity form.
   * @private
   */
  _buildLANAccessRow(c) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = 'LAN access';
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = 'Allow other devices on your local network to connect.';
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (c.lanEnabled) {
      if (c.lanURLs && c.lanURLs.length > 0) {
        // Lay the per-address URL/QR blocks out as a left-to-right flow that
        // wraps onto new lines, rather than a single stacked column. The LAN
        // URL is http://<ip>, which a native window's WebKit won't hand to the
        // system browser; the block routes clicks via the loopback opener.
        const list = document.createElement('div');
        list.className = 'connectivity-url-list';
        for (const url of c.lanURLs) {
          list.appendChild(this._buildConnectivityURLBlock(url));
        }
        ctrl.appendChild(list);
      } else {
        const hint = document.createElement('div');
        hint.className = 'key-source-hint';
        hint.style.display = 'block';
        hint.textContent = 'No LAN interfaces detected.';
        ctrl.appendChild(hint);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._setLAN(false);
      });
      ctrl.appendChild(stopBtn);
    } else {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = 'Start LAN access';
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._setLAN(true);
      });
      ctrl.appendChild(startBtn);
    }

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Enable or disable LAN access, then re-render from authoritative state.
   * @param {boolean} enabled
   * @private
   */
  async _setLAN(enabled) {
    try {
      await fetch('/api/connectivity/lan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (e) {
      console.error('Failed to set LAN access:', e);
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build the WAN access section: one block per WAN mode the server's build
   * registered, rendered entirely from the `wanModes` the connectivity API
   * reports. Only one tunnel is ever active; the active mode shows its URL/QR
   * and a Stop button. Driven purely from connectivity state — never from
   * optimistic local toggles.
   * @param {{tunnelEnabled: boolean, tunnelURL: string, tunnelMode: string, wanModes: WANMode[]}} c - Connectivity state
   * @returns {HTMLElement} The section element to append to the connectivity form.
   * @private
   */
  _buildWANAccessRow(c) {
    const section = document.createElement('div');
    section.className = 'connectivity-wan';

    const heading = document.createElement('div');
    heading.className = 'connectivity-wan-heading';
    heading.textContent = 'WAN access';
    section.appendChild(heading);

    const activeMode = c.tunnelEnabled ? (c.tunnelMode || '') : '';

    for (const mode of c.wanModes || []) {
      section.appendChild(this._buildWANModeBlock({
        mode: mode.mode,
        title: mode.title,
        description: mode.description,
        startLabel: mode.startLabel || `Start ${mode.title}`,
        available: !!mode.available,
        isActive: activeMode === mode.mode,
        url: activeMode === mode.mode ? c.tunnelURL : '',
        relayNote: mode.relayNote || '',
        unavailableHint: mode.unavailableHint || '',
      }));
    }

    if (this._wanError) {
      const err = document.createElement('div');
      err.className = 'key-source-hint connectivity-wan-error';
      err.style.display = 'block';
      err.textContent = this._wanError;
      section.appendChild(err);
    }

    return section;
  }

  /**
   * Build a single WAN-mode block: title + copy on the left, and on the right
   * either a Start button, or (when this mode is the active tunnel) its URL/QR
   * and a Stop button, or (when unavailable) the mode's install hint.
   * @param {{mode: string, title: string, description: string, startLabel: string, available: boolean, isActive: boolean, url: string, relayNote?: string, unavailableHint?: string}} opts
   * @returns {HTMLElement} The mode block element.
   * @private
   */
  _buildWANModeBlock(opts) {
    const row = document.createElement('div');
    row.className = 'settings-group provider-field';

    const info = document.createElement('div');
    info.className = 'provider-info';
    const name = document.createElement('div');
    name.className = 'provider-name';
    name.textContent = opts.title;
    const desc = document.createElement('div');
    desc.className = 'provider-description';
    desc.textContent = opts.description;
    info.appendChild(name);
    info.appendChild(desc);

    const ctrl = document.createElement('div');
    ctrl.className = 'provider-control';

    if (opts.isActive) {
      const statusHint = document.createElement('div');
      statusHint.className = 'key-source-hint';
      statusHint.style.display = 'block';
      statusHint.textContent = opts.url
        ? 'Open this URL in a remote browser to connect.'
        : 'Connecting…';
      ctrl.appendChild(statusHint);

      if (opts.url) {
        ctrl.appendChild(this._buildConnectivityURLBlock(opts.url));
      }

      if (opts.relayNote) {
        const note = document.createElement('div');
        note.className = 'key-source-hint';
        note.style.display = 'block';
        note.textContent = opts.relayNote;
        ctrl.appendChild(note);
      }

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'settings-btn danger small';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
        this._stopTunnel();
      });
      ctrl.appendChild(stopBtn);
    } else if (opts.available) {
      const startBtn = document.createElement('button');
      startBtn.type = 'button';
      startBtn.className = 'settings-btn primary small';
      startBtn.textContent = opts.startLabel;
      startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        this._startTunnel(opts.mode);
      });
      ctrl.appendChild(startBtn);
    } else {
      ctrl.appendChild(this._buildWANUnavailableHint(opts.unavailableHint || `${opts.title} is not available on this machine.`));
    }

    row.appendChild(info);
    row.appendChild(ctrl);
    return row;
  }

  /**
   * Render a WAN-mode unavailable hint as text, turning any http(s) URLs it
   * contains into external links so a plain-text hint from the server can still
   * point at install docs.
   * @param {string} text - The mode's unavailableHint
   * @returns {HTMLElement} The hint element.
   * @private
   */
  _buildWANUnavailableHint(text) {
    const hint = document.createElement('div');
    hint.className = 'key-source-hint';
    hint.style.display = 'block';
    for (const part of text.split(/(https?:\/\/[^\s]+)/)) {
      if (/^https?:\/\//.test(part)) {
        const link = document.createElement('a');
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'connectivity-url';
        link.textContent = part;
        hint.appendChild(link);
      } else if (part) {
        hint.appendChild(document.createTextNode(part));
      }
    }
    return hint;
  }

  /**
   * Start a WAN tunnel in the given mode. The backend auto-stops any other-mode
   * tunnel on an explicit different-mode start. Re-renders from authoritative
   * state afterwards.
   * @param {string} mode - A wire mode id from the server's wanModes list
   * @private
   */
  async _startTunnel(mode) {
    this._wanError = '';
    try {
      const res = await fetch('/api/connectivity/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, mode }),
      });
      const data = await res.json();
      if (!data.ok) this._wanError = data.error || 'Failed to start tunnel';
    } catch (e) {
      this._wanError = 'Failed to start tunnel';
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Stop whichever WAN tunnel is currently active.
   * @private
   */
  async _stopTunnel() {
    this._wanError = '';
    try {
      const res = await fetch('/api/connectivity/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      const data = await res.json();
      if (!data.ok) this._wanError = data.error || 'Failed to stop tunnel';
    } catch (e) {
      this._wanError = 'Failed to stop tunnel';
    }
    await this.refreshConnectivity(true);
  }

  /**
   * Build a connectivity URL block: a clickable link (routed through the
   * loopback opener) with a copy-to-clipboard button, alongside an inline QR
   * code for the same URL.
   * @param {string} url - The URL to link to and encode as a QR code
   * @returns {HTMLElement} The URL block element to append to a control column.
   * @private
   */
  _buildConnectivityURLBlock(url) {
    const urlBlock = document.createElement('div');
    urlBlock.className = 'connectivity-url-block';
    const urlRow = document.createElement('div');
    urlRow.className = 'connectivity-url-row';
    const urlLink = document.createElement('a');
    urlLink.href = url;
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.className = 'connectivity-url';
    urlLink.textContent = url;
    const copyBtn = createCopyButton(url, 'connectivity-url-copy', 'Copy URL to clipboard');
    urlRow.appendChild(urlLink);
    urlRow.appendChild(copyBtn);
    const qrHost = document.createElement('div');
    qrHost.className = 'connectivity-qr';
    qrHost.setAttribute('role', 'img');
    qrHost.setAttribute('aria-label', 'QR code');
    loadQRCodeSVG(qrHost, url);
    urlBlock.appendChild(urlRow);
    urlBlock.appendChild(qrHost);
    return urlBlock;
  }

  /**
   * Open (or re-open) the Logs tab: fetch the current session's log list,
   * populate the picker, and load the selected file's tail. Safe to call
   * repeatedly — it preserves the current selection across refreshes. Shares the
   * tail-busy guard with the poll so the two never overlap.
   * @private
   */
  async _openLogsTab() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      await this._refreshLogList();
      await this._fetchLogContent(true);
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Fetch the session log list and reconcile the UI: toggle the empty state,
   * keep (or default) the selection, and rebuild the picker only when the file
   * set actually changed so a 2s poll never disrupts an open dropdown.
   * @private
   */
  async _refreshLogList() {
    /** @type {any[]} */
    let files = [];
    try {
      const res = await fetch('/api/logs');
      if (res.ok) files = (await res.json()).files || [];
    } catch {
      // Treat a failed fetch as "no logs" and fall through to the empty state.
    }
    this._logFiles = files;

    const hasFiles = files.length > 0;
    const empty = this.querySelector('#logs-empty');
    const controls = this.querySelector('#logs-controls');
    const viewer = this.querySelector('#logs-viewer');
    if (empty) /** @type {HTMLElement} */ (empty).hidden = hasFiles;
    if (controls) /** @type {HTMLElement} */ (controls).hidden = !hasFiles;
    if (viewer) /** @type {HTMLElement} */ (viewer).hidden = !hasFiles;

    // Keep the current selection; if it vanished (log rotated away) or is unset,
    // default to server.log, then the first file.
    if (!files.some((f) => f.path === this._selectedLogPath)) {
      const preferred = files.find((f) => f.name === 'server.log') || files[0];
      this._selectedLogPath = preferred ? preferred.path : '';
      this._logOffset = 0;
    }

    // Rebuild the picker only when the set of files changed (added/removed),
    // and the path control only when the selection changed — so <reveal-button>
    // and the <option>s aren't recreated on every tick.
    const key = files.map((f) => f.path).join('\n');
    if (key !== this._logFilesKey) {
      this._logFilesKey = key;
      this._renderLogPicker();
    }
    if (this._selectedLogPath !== this._filePathPath) {
      this._filePathPath = this._selectedLogPath;
      this._updateLogFilePathControl();
    }
  }

  /**
   * Rebuild the picker's <option>s from this._logFiles, grouped by kind
   * (Server / Conversations / App) with a size hint per entry, reflecting the
   * current selection. The change listener lives on the persistent <select>
   * (see setupListeners), so it is not re-wired here.
   * @private
   */
  _renderLogPicker() {
    const picker = /** @type {HTMLSelectElement|null} */ (this.querySelector('#logs-picker'));
    if (!picker) return;
    picker.textContent = '';

    for (const group of [
      { key: 'server', label: 'Server' },
      { key: 'conversations', label: 'Conversations' },
      { key: 'app', label: 'App' },
    ]) {
      const inGroup = this._logFiles.filter((f) => f.group === group.key);
      if (inGroup.length === 0) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const file of inGroup) {
        const opt = document.createElement('option');
        opt.value = file.path;
        opt.textContent = `${file.name} — ${formatBytes(file.size)}`;
        if (file.path === this._selectedLogPath) opt.selected = true;
        optgroup.appendChild(opt);
      }
      picker.appendChild(optgroup);
    }
  }

  /**
   * Switch the viewer to a different log file: reset the tail offset, clear the
   * viewer, refresh the path control, and load the new file's tail.
   * @param {string} path - Absolute path of the newly-selected log
   * @private
   */
  _selectLog(path) {
    if (!path || path === this._selectedLogPath) return;
    this._selectedLogPath = path;
    this._logOffset = 0;
    const viewer = this.querySelector('#logs-viewer');
    if (viewer) viewer.textContent = '';
    this._filePathPath = path;
    this._updateLogFilePathControl();
    this._fetchLogContent(true);
  }

  /**
   * Render the standard file-path control (copy + reveal-in-Finder) for the
   * selected log into the #logs-filepath row, replacing any previous one.
   * @private
   */
  _updateLogFilePathControl() {
    const host = this.querySelector('#logs-filepath');
    if (!host) return;
    host.textContent = '';
    if (this._selectedLogPath) addFilePath(/** @type {HTMLElement} */ (host), this._selectedLogPath);
  }

  /**
   * Fetch the selected log from the current offset and render it. On `reset`
   * (file switch / first open) or a server-reported replaced window (initial
   * tail / rotation) the viewer content is replaced; otherwise the newly
   * appended bytes are appended. Autoscroll sticks to the bottom only when the
   * user was already there, so scrolling up to read history isn't interrupted.
   * @param {boolean} [reset=false]
   * @private
   */
  async _fetchLogContent(reset = false) {
    const path = this._selectedLogPath;
    const viewer = this.querySelector('#logs-viewer');
    if (!path || !viewer) return;

    const offset = reset ? 0 : this._logOffset;
    let data;
    try {
      const res = await fetch(`/api/logs/content?path=${encodeURIComponent(path)}&offset=${offset}`);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return; // Transient; the next poll retries.
    }
    // Drop a stale response for a file the user has since switched away from.
    if (path !== this._selectedLogPath) return;

    const pinned = this._isViewerAtBottom(/** @type {HTMLElement} */ (viewer));
    if (reset || data.replaced) {
      viewer.textContent = data.content;
    } else if (data.content) {
      viewer.appendChild(document.createTextNode(data.content));
    }
    this._trimViewer(/** @type {HTMLElement} */ (viewer));
    this._logOffset = data.size;
    if (reset || pinned) viewer.scrollTop = viewer.scrollHeight;
  }

  /**
   * Keep the viewer's text bounded (see LOGS_VIEWER_MAX_CHARS): when it grows
   * past the cap, drop the oldest characters, rounding forward to the next line
   * boundary so a partial first line isn't left dangling. No-op below the cap.
   * @param {HTMLElement} viewer
   * @private
   */
  _trimViewer(viewer) {
    const text = viewer.textContent || '';
    if (text.length <= LOGS_VIEWER_MAX_CHARS) return;
    let cut = text.length - LOGS_VIEWER_MAX_CHARS;
    const nl = text.indexOf('\n', cut);
    if (nl !== -1) cut = nl + 1;
    viewer.textContent = text.slice(cut);
  }

  /**
   * One tail poll while the Logs tab is open. Tails only the selected file's
   * newly-appended bytes — one cheap incremental read. The list is refreshed on
   * open (not every tick), so new files / size changes are picked up on reopen
   * rather than costing a second request per poll. The in-flight guard drops a
   * tick if the previous poll's fetch hasn't returned, so a slow response can't
   * double-append. When nothing is selected yet (opened before any log existed),
   * it keeps re-listing until a file appears.
   * @private
   */
  async _pollLogTail() {
    if (this._logTailBusy) return;
    this._logTailBusy = true;
    try {
      if (this._selectedLogPath) {
        await this._fetchLogContent(false);
      } else {
        await this._refreshLogList();
        await this._fetchLogContent(true);
      }
    } finally {
      this._logTailBusy = false;
    }
  }

  /**
   * Whether the viewer is scrolled to (within a line or two of) the bottom —
   * the condition under which new log lines should keep it pinned there.
   * @param {HTMLElement} el
   * @returns {boolean} True when pinned to (or within a couple of lines of) the bottom.
   * @private
   */
  _isViewerAtBottom(el) {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
  }

  /**
   * Delete API key for a specific provider
   * @param {any} provider - Provider info object
   * @private
   */
  async deleteProviderKey(provider) {
    try {
      // Send empty string to delete the key
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          [provider.configKeyName]: ''
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete API key');
      }

      // Reload config from server to get actual state (don't re-render fields)
      await this.loadConfig(false);

      // Refresh model selector to update available providers
      const modelSelector = document.querySelector('model-selector');
      if (modelSelector && modelSelector.refresh) {
        await modelSelector.refresh();
      }
    } catch (error) {
      console.error('Failed to delete API key:', error);
      if (window.showAlert) {
        await window.showAlert(
          error instanceof Error ? error.message : 'Failed to delete API key',
          'Error'
        );
      }
    }
  }

}

customElements.define('settings-panel', SettingsPanel);

// Global helper to open settings panel
// @ts-ignore - Adding custom property to window
window.openSettings = function(tab) {
  let panel = document.querySelector('settings-panel');
  if (!panel) {
    panel = document.createElement('settings-panel');
    document.body.appendChild(panel);
  }
  // @ts-ignore - open method exists on SettingsPanel custom element
  panel.open(tab);
};
