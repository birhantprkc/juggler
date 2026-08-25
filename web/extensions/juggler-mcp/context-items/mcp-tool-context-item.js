//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { mcpSnapshot, mcpCallTool } from 'juggler/ops';
// First-party builtin reaching a core singleton, the same way @juggler/core
// reaches ../../../js/services/*. This is the websocket the engine already uses;
// importing the module by its stable URL yields that same singleton instance.
import wsService from '../../../js/services/websocket.js';

/**
 * @typedef {object} McpToolInfo
 * @property {string} server - Owning server name
 * @property {string} name - Raw MCP tool name
 * @property {string} title - Display title (falls back to name)
 * @property {string} description - Server-provided description
 * @property {object} inputSchema - JSON Schema for the tool's arguments
 * @property {boolean} readOnly - annotations.readOnlyHint
 * @property {boolean} destructive - annotations.destructiveHint
 * @property {number} schemaTokens - ~chars/4 estimate of the input schema
 */

/**
 * Module-level snapshot of every discovered MCP tool, plus an index from the
 * LLM-facing tool name to its owning server/tool. `getToolDefinitions()` is
 * static and synchronous, so it must read a cache that is kept fresh out of
 * band (the ES module is import-cached — its top level runs once — so we can't
 * rely on re-import to refresh it).
 * @type {McpToolInfo[]}
 */
let discoveredTools = [];
/** @type {Map<string, McpToolInfo>} */
let toolByLLMName = new Map();
/**
 * Whether the snapshot is the final word — it came back AND every enabled server
 * had published its tools by then. "No MCP tools", "nobody has asked yet" and "a
 * server is still connecting" are the same empty list to every reader, so this is
 * what tells them apart. Until it is set, the snapshot is re-fetched before each
 * turn's tool list, which is the backstop for the `plugin-changed` broadcast
 * below: with only the broadcast, one missed notification meant an empty tool
 * list for the rest of the session while every UI surface listed them in full.
 * @type {boolean}
 */
let loaded = false;
/**
 * In-flight refresh, so concurrent waiters share one round-trip.
 * @type {Promise<void>|null}
 */
let inFlight = null;

/** The permission itemType all MCP tool rules are stored under. */
const ITEM_TYPE = 'mcp-tool';

/** Max characters of a server-supplied tool description passed to the model. */
const MAX_DESC_CHARS = 1024;

/**
 * The LLM-facing tool name for a server/tool pair. `mcp__<server>__<tool>` is
 * the convention users know from other agents; it is collision-proof across
 * servers. (A server literally named "juggler" would collide with the Claude
 * CLI's `mcp__juggler__` strip in tool-generator.js — avoid that name.)
 * @param {string} server - Server name
 * @param {string} tool - Raw tool name
 * @returns {string} The LLM-facing tool name
 */
export function mcpLLMName(server, tool) {
  return `mcp__${server}__${tool}`;
}

/**
 * Build one LLM tool definition from a discovered tool. Read-only tools map to
 * the `read` category (so read/planning strategies include them and they run in
 * parallel); everything else is a mutating `write` (destructive-by-default).
 * Pure — exported for unit testing.
 * @param {McpToolInfo} t - A discovered tool
 * @returns {{name: string, category: 'read'|'write', description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}} Tool definition
 */
export function buildToolDefinition(t) {
  // Cast, not a guarantee: this schema is whatever a third-party MCP server
  // published, so it is the one tool schema in the tree that no annotation can
  // vouch for. It is checked at the provider seam before being advertised to
  // the model, and a server that publishes a malformed one loses that tool
  // rather than the whole tool list.
  const schema = /** @type {import('juggler/strategy-type').JSONObjectSchema} */ (
    (t.inputSchema && typeof t.inputSchema === 'object')
      ? t.inputSchema
      : { type: 'object', properties: {} }
  );
  let description = t.description || `${t.title || t.name} (via MCP server "${t.server}")`;
  if (description.length > MAX_DESC_CHARS) {
    description = description.slice(0, MAX_DESC_CHARS) + '…';
  }
  return {
    name: mcpLLMName(t.server, t.name),
    category: t.readOnly ? 'read' : 'write',
    description,
    input_schema: schema
  };
}

/**
 * The glob rule values that can auto-approve a call to server/tool.
 * @param {string} server - Server name
 * @param {string} tool - Raw tool name
 * @returns {{exact: string, readonly: string, all: string}} Rule values
 */
export function mcpRuleValues(server, tool) {
  return { exact: `${server}/${tool}`, readonly: `${server}/#readonly`, all: `${server}/*` };
}

/**
 * Escalating "don't ask again" suggestions, narrowest breadth first: this exact
 * tool, then (only if the tool is read-only) all read-only tools on the server,
 * then every tool on the server. Pure — exported for unit testing.
 * @param {{server: string, tool: string, readOnly: boolean}} t - Target tool
 * @returns {import('juggler/context-item').ApprovalSuggestion[]} Suggestions, narrowest first
 */
export function mcpApprovalSuggestions(t) {
  const rv = mcpRuleValues(t.server, t.tool);
  /** @type {import('juggler/context-item').ApprovalSuggestion[]} */
  const out = [
    { itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.exact }], patterns: [`${t.server}/${t.tool}`] }
  ];
  if (t.readOnly) {
    out.push({ itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.readonly }], label: `all read-only tools on "${t.server}"` });
  }
  out.push({ itemType: ITEM_TYPE, rules: [{ kind: 'glob', value: rv.all }], label: `all tools on "${t.server}" (trust this server)` });
  return out;
}

/**
 * Whether a set of persisted glob rule values auto-approves this call. A
 * `#readonly` grant applies ONLY when the tool is annotated read-only — never an
 * approval based on annotations alone. Pure — exported for unit testing.
 * @param {Set<string>} values - Persisted glob rule values for the mcp-tool itemType
 * @param {{server: string, tool: string, readOnly: boolean}} t - Target tool
 * @returns {boolean} True if auto-approved
 */
export function mcpIsPermitted(values, t) {
  const rv = mcpRuleValues(t.server, t.tool);
  if (values.has(rv.exact)) return true;
  if (values.has(rv.all)) return true;
  if (t.readOnly && values.has(rv.readonly)) return true;
  return false;
}

/**
 * Refresh the module-level snapshot from the Go manager's cache. Best-effort:
 * a failure (e.g. the API token isn't installed yet at first import) leaves the
 * previous snapshot in place. Calling it also reconciles the manager to the
 * active project Go-side, so enabled servers start discovering.
 * @returns {Promise<void>} Result
 */
async function refreshSnapshot() {
  try {
    const res = await mcpSnapshot();
    const tools = Array.isArray(res?.tools) ? res.tools : [];
    const index = new Map();
    for (const t of tools) index.set(mcpLLMName(t.server, t.name), t);
    discoveredTools = tools;
    toolByLLMName = index;
    // Only stop asking once the server says every enabled MCP server has
    // answered. An absent `complete` means nothing is reporting discovery state
    // (a bare test double), where re-asking forever would be the worse guess.
    loaded = res?.complete !== false;
  } catch (err) {
    // Leave the last-known snapshot untouched; a later refresh will update it.
    // Say so, though: a refresh that keeps failing looks exactly like a server
    // with no tools — an empty list, forever, and no other trace anywhere. Debug
    // level because the first call routinely loses a race with the API token.
    console.debug('[MCP] Couldn\'t refresh the tool snapshot:', err);
  }
}

/**
 * Refresh, sharing one in-flight request between concurrent callers. The tool
 * list is built per turn and several surfaces can ask at once; without this each
 * would open its own snapshot round-trip, and each of those can be holding the
 * server's bounded wait for a slow MCP server to connect.
 * @returns {Promise<void>} Resolves when the refresh settles
 */
function refreshOnce() {
  if (!inFlight) {
    inFlight = refreshSnapshot().finally(() => { inFlight = null; });
  }
  return inFlight;
}

// Kick an initial best-effort load (also starts Go-side discovery). Not awaited
// at top level: a slow/failed fetch must never wedge registry init.
refreshOnce();

// Refresh whenever the tool set changes. The Go manager broadcasts
// `plugin-changed` (via the server) on every snapshot change — a server became
// ready, crashed, or sent tools/list_changed — which the engine also uses to
// reload registries. This module is imported during contextItemRegistry.init(),
// which runs BEFORE engine-app installs its own plugin-changed→reloadRegistries
// listener, so our refresh is registered first and runs ahead of the rebuild.
// We also refresh on (re)connect, by which point the API token is installed.
try {
  wsService.on('plugin-changed', () => { void refreshSnapshot(); });
  wsService.on('open', () => { void refreshSnapshot(); });
} catch {
  // No wsService in this context (e.g. a bare unit harness) — the initial
  // refresh above still applies.
}

/**
 * MCP tool bridge. ONE context-item class exposes MANY tools: one per tool
 * discovered across all connected MCP servers. Each tool result is a first-class
 * context item — summarized, truncated, droppable, richly rendered — not a raw
 * JSON blob wedged into history.
 * @augments ContextItem
 */
class McpToolContextItem extends ContextItem {
  static MANIFEST = {
    id: ITEM_TYPE,
    name: 'MCP Tools',
    version: '1.0.0',
    description: 'Tools provided by connected MCP (Model Context Protocol) servers',
    author: 'Juggler Team',
    requiresApproval: true
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  /** @returns {string} Short type label shown on item cards and the permissions popup */
  static getTypeName() {
    return 'MCP';
  }

  /**
   * Load the snapshot before the tool list is built, until one comes back with
   * every enabled server accounted for.
   *
   * The first snapshot request is also what starts Go-side discovery, so without
   * this the very request that builds a turn's tool list would be the one
   * kicking the servers off — and the turn would go out with no MCP tools in it
   * while the settings panel, asking a moment later, lists them all. The server
   * side holds that first answer until the servers have settled, so one await is
   * usually enough. A server slower than that wait, or one that failed its first
   * attempt and reconnected, costs a turn instead of the session: this keeps
   * asking until the answer is final, and `plugin-changed` keeps it current after
   * that. The repeat calls are a local snapshot read, and only park while a
   * server is on its first connect attempt.
   * @returns {Promise<void>|void} Resolves once a complete snapshot has loaded
   */
  static prepareToolDefinitions() {
    if (loaded) return;
    return refreshOnce();
  }

  /**
   * One tool definition per discovered MCP tool. Read from the module-level
   * snapshot, which {@link prepareToolDefinitions} has loaded and
   * `plugin-changed` keeps current.
   * @returns {Array<{name: string, category: 'read'|'write', description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} One tool definition per discovered MCP tool
   */
  static getToolDefinitions() {
    return discoveredTools.map(buildToolDefinition);
  }

  /**
   * Human display title for the tool-action, e.g. "github: create_issue".
   * @override
   * @param {Record<string, unknown>} _toolInput
   * @param {string} toolName - The (resolved) LLM tool name
   * @returns {string} Result value
   */
  static getToolActionTitle(_toolInput, toolName) {
    const info = toolByLLMName.get(toolName);
    if (!info) return toolName;
    return `${info.server}: ${info.title || info.name}`;
  }

  /**
   * Resolve this instance's target (server, tool, info) from the invoked tool
   * name the framework set on the item.
   * @returns {{server: string, tool: string, info: McpToolInfo|undefined, llm: string}} The resolved target for this instance
   * @private
   */
  _target() {
    const llm = this.toolName || '';
    const info = toolByLLMName.get(llm);
    return { server: info?.server || '', tool: info?.name || '', info, llm };
  }

  /**
   * Validate/normalize arguments. The base prepare() has already coerced the
   * input against the declared schemas; here we only confirm the tool is known.
   * @override
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const { info, llm } = this._target();
    if (!info) {
      return { valid: false, error: `Unknown MCP tool "${llm}" (its server may be stopped or reconfigured)` };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Permission key: all MCP tool rules live under one itemType, with the
   * server/tool encoded in the rule value.
   * @override
   * @returns {string} Result value
   */
  getPermissionKey() {
    return ITEM_TYPE;
  }

  /**
   * Auto-approve when a matching rule exists. Annotations are UNVERIFIED hints
   * from an untrusted server, so a `#readonly` grant only applies when THIS
   * tool is annotated read-only — never an approval based on annotations alone.
   * @override
   * @param {Record<string, unknown>} _toolInput
   * @returns {boolean} True when auto-approved
   */
  isPermitted(_toolInput) {
    const { server, tool, info } = this._target();
    if (!info) return false;
    const mt = this.messageThread;
    if (!mt) return false;
    const values = new Set(
      mt.getRulesFor(ITEM_TYPE)
        .filter((r) => r.kind === 'glob')
        .map((r) => String(r.value))
    );
    return mcpIsPermitted(values, { server, tool, readOnly: info.readOnly });
  }

  /**
   * Escalating "don't ask again" choices, narrowest breadth first.
   * @override
   * @param {Record<string, unknown>} _toolInput
   * @returns {import('juggler/context-item').ApprovalSuggestion[]} Escalating approval suggestions, narrowest first
   */
  getApprovalSuggestions(_toolInput) {
    const { server, tool, info } = this._target();
    if (!info) return [];
    return mcpApprovalSuggestions({ server, tool, readOnly: info.readOnly });
  }

  /**
   * Approval dialog: name the server, the tool, and the arguments.
   * @override
   * @param {Record<string, unknown>} params
   * @returns {Promise<import('juggler/context-item').ApprovalConfig|null>} Approval dialog config
   */
  async getApprovalConfig(params) {
    const { server, info } = this._target();
    const title = `MCP: ${server} / ${info?.title || info?.name || 'tool'}`;
    const desc = info?.description ? `${info.description}\n\n` : '';
    let argStr = '';
    try {
      argStr = JSON.stringify(params ?? {}, null, 2);
    } catch {
      argStr = String(params);
    }
    return { title, message: `${desc}Arguments:\n\n${argStr}` };
  }

  /**
   * Invoke the tool via the Go manager, honoring cancellation.
   * @param {Record<string, unknown>} params - Prepared arguments
   * @returns {Promise<{server: string, tool: string, content: import('../../../js/services/ops-api.js').McpContentBlock[], isError: boolean, text: string}>} The tool call result
   */
  async execute(params) {
    const { server, tool, info, llm } = this._target();
    if (!info) {
      throw new Error(`Unknown MCP tool "${llm}"`);
    }
    const result = await mcpCallTool({ server, tool, args: /** @type {object} */ (params) }, this.signal);
    const blocks = Array.isArray(result?.content) ? result.content : [];
    return { server, tool, content: blocks, isError: !!result?.isError, text: McpToolContextItem._extractText(blocks) };
  }

  /**
   * Concatenate the text of all text blocks.
   * @param {import('../../../js/services/ops-api.js').McpContentBlock[]} blocks
   * @returns {string} Result value
   * @private
   */
  static _extractText(blocks) {
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  /**
   * Summarize a non-text block for the LLM when there is no text content.
   * @param {import('../../../js/services/ops-api.js').McpContentBlock} b
   * @returns {string} Result value
   * @private
   */
  static _describeBlock(b) {
    switch (b?.type) {
      case 'image': return `[image: ${b.mimeType || 'image'}]`;
      case 'audio': return `[audio: ${b.mimeType || 'audio'}]`;
      case 'resource': return `[resource: ${b.uri || ''}]`;
      case 'resource_link': return `[resource link: ${b.uri || ''}${b.name ? ` (${b.name})` : ''}]`;
      default: return '[content]';
    }
  }

  /**
   * Format the outcome for the LLM + UI. isError from the server marks the item
   * failed even though execute() didn't throw.
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result for LLM and UI
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'MCP tool call failed');
    }
    const result = /** @type {{content: any[], isError: boolean, text: string}} */ (outcome.result || {});
    let text = result.text || '';
    if (!text) {
      const blocks = Array.isArray(result.content) ? result.content : [];
      text = blocks.map((b) => McpToolContextItem._describeBlock(b)).join('\n') || '(no content)';
    }
    // The call itself succeeded; `isError` is the server marking its own result
    // as a failure, which the item carries through as a failed summary.
    return result.isError
      ? this.failureSummary(this.truncateForLLM(text))
      : this.successSummary(this.truncateForLLM(text));
  }

  /**
   * Status line in the viewer.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus
   * @param {Record<string, unknown>} toolInput
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config, or null
   */
  getStatusUI(actionStatus, toolInput) {
    void toolInput;
    const info = this._target().info;
    const label = info ? `${info.server}: ${info.title || info.name}` : (this.toolName || 'MCP tool');

    return this.buildStatusUI(actionStatus, {
      typeName: 'MCP',
      pending: `Calling ${label}…`,
      success: () => {
        const result = /** @type {{isError?: boolean}} */ (actionStatus?.result || {});
        // A completed call whose result the server flagged as an error.
        return result.isError
          ? { summary: `${label} — tool reported an error`, status: /** @type {const} */ ('error') }
          : label;
      },
      failurePrefix: `${label} failed`
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Result value
   */
  static getResultSectionLabel(_toolName) {
    return 'Result';
  }

  /**
   * Render the call details: server, tool, arguments, and any non-text content
   * blocks (images inline). Text content is left to the result section.
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {void} Nothing
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolName } = ctx;
    const info = toolByLLMName.get(toolName);
    if (info) {
      helpers.addSubsection(wrapper, 'Server', info.server, 'properties-panel-code');
      helpers.addSubsection(wrapper, 'Tool', info.name, 'properties-panel-code');
    }
    let argStr = '';
    try {
      argStr = JSON.stringify(input ?? {}, null, 2);
    } catch {
      argStr = String(input);
    }
    if (argStr && argStr !== '{}') {
      helpers.addSubsection(wrapper, 'Arguments', argStr, 'properties-panel-code');
    }
  }
}

export default McpToolContextItem;
