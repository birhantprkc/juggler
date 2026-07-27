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

/**
 * The "MCP servers" and "ACP agents" settings tabs. Both manage the same shape —
 * a scope-keyed map of {command, args, env, enabled} subprocess entries — so they
 * share the generic {@link ConfigTabController} (from config-tab.js) and differ
 * only in a small per-tab spec plus a thin wrapper that owns lifecycle. The MCP
 * wrapper additionally live-refreshes off the `plugin-changed` broadcast while
 * visible; the ACP wrapper auto-enables the ACP provider after a successful save.
 * @module components/settings/subprocess-tabs
 */

import wsService from '../../services/websocket.js';
import {
  mcpListServers,
  mcpGetConfig,
  mcpSetConfig,
  mcpServerControl,
  mcpGetLog,
  acpListAgents,
  acpGetConfig,
  acpSetConfig,
} from '../../services/ops-api.js';
import { ConfigTabController, makeNameValidator } from '../config-tab.js';

/** Polling interval (ms) for refreshing the MCP servers tab while it's open. */
const MCP_POLL_MS = 2000;

/** Polling interval (ms) for refreshing the ACP agents tab while it's open. */
const ACP_POLL_MS = 3000;

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
 * @type {import('../config-tab.js').ConfigTabSpec}
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
  // MCP servers can be local subprocesses (stdio) or remote endpoints (http/sse).
  supportsTransport: true,
  urlPlaceholder: 'https://example.com/mcp',
  urlHint: 'The remote MCP endpoint URL (http/sse transport).',
  headerKeyPlaceholder: 'Authorization',
};

/**
 * Spec for the "ACP agents" tab: an ACP agent is spawned per-conversation with
 * no persistent process, so status is just PATH-resolvability (no Restart/Log),
 * its name is a model id (no reserved word), and a successful save auto-enables
 * the ACP provider. See {@link ConfigTabController}.
 * @type {import('../config-tab.js').ConfigTabSpec}
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
 * "MCP servers" tab: managed stdio subprocesses (Restart + Log). Wraps a
 * {@link ConfigTabController} and, while visible, live-refreshes off the
 * `plugin-changed` broadcast — every config write / lifecycle change
 * auto-reconciles Go-side and broadcasts it, which is what flips a server
 * starting→running without the user clicking (the 2 s poll is a backstop).
 */
export class McpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, MCP_SPEC);
    /** @type {boolean} @private - True while this tab is the visible one. */
    this._visible = false;
    /** @type {(() => void)|null} @private - Live refresh off the plugin-changed broadcast. */
    this._onMcpChanged = () => {
      if (this._visible) this.controller.refresh();
    };
    wsService.on('plugin-changed', this._onMcpChanged);
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this._visible = true;
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this._visible = false;
    this.controller.stopPolling();
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this._visible = false;
    this.controller.close();
  }

  /** Element disconnected: drop the plugin-changed subscription and stop polling. */
  dispose() {
    if (this._onMcpChanged) {
      wsService.off('plugin-changed', this._onMcpChanged);
      this._onMcpChanged = null;
    }
    this.controller.stopPolling();
  }
}

/**
 * "ACP agents" tab: per-conversation agents with no persistent process. A thin
 * {@link ConfigTabController} wrapper with no extra broadcast wiring.
 */
export class AcpTab {
  /**
   * @param {HTMLElement} host - The settings-panel element (DOM query scope).
   */
  constructor(host) {
    /** @type {ConfigTabController} @private */
    this.controller = new ConfigTabController(host, ACP_SPEC);
  }

  /** Tab became visible: fetch and arm the controller's status poll. */
  show() {
    this.controller.show();
  }

  /** Tab hidden: stop the controller's status poll. */
  hide() {
    this.controller.stopPolling();
  }

  /** Panel closed: reset the controller to a clean list view. */
  close() {
    this.controller.close();
  }

  /** Element disconnected: stop polling. */
  dispose() {
    this.controller.stopPolling();
  }
}
