//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Human-readable description
 * @property {object} input_schema - JSON Schema for parameters
 * @property {'read'|'write'|'meta'} category - Tool category for routing
 * @property {boolean} [delegatesToSubthread] - Stamped from the owning item's
 *   MANIFEST; tells the worker this tool MAY delegate to a subthread.
 */

// ============================================================================
// Tool Alias Resolution
// ============================================================================

/**
 * Alias map for tool name normalization.
 *
 * Two kinds of entry, both permanent:
 *   - Capitalised native names → their canonical lowercase Juggler key.
 *   - Superseded tool names → the name currently advertised. Conversations
 *     persist the tool name they were recorded with, so a model replaying its
 *     own history keeps emitting the older name for the lifetime of that
 *     document; the entry is what makes that call still execute.
 * @type {Record<string, string>}
 */
const TOOL_ALIASES = {
  'Bash': 'bash',
  'Read': 'read',
  'Write': 'write',
  'Edit': 'edit',
  'Grep': 'grep',
  'Glob': 'glob',
  'BatchRead': 'batch_read',
  'BatchGrep': 'batch_grep',
  'ExploreCode': 'query_code',
  'explore_code': 'query_code'
};

/**
 * Prefix the Claude CLI adds to MCP tools based on our --mcp-config server
 * name. The claudecode provider normally strips this in its Go-side parser
 * (canonicalToolName in cmd/juggler/providers/claudecode/), but we strip it
 * again here as a belt-and-braces guard: any tool-call name reaching the
 * registry should be a pure Juggler tool key, regardless of which provider
 * path it travelled.
 * @type {string}
 */
const MCP_JUGGLER_PREFIX = 'mcp__juggler__';

/**
 * Resolve tool name to its canonical form.
 *
 * Performs two transforms in order:
 *   1. Strip the `mcp__juggler__` prefix the Claude CLI adds to MCP tools
 *      (looped, so a doubly-prefixed name still resolves cleanly).
 *   2. Apply the capitalised-alias map (Bash → bash, BatchGrep → batch_grep, …).
 *
 * Composing them in this order lets a prefixed-and-capitalised name like
 * `mcp__juggler__BatchGrep` canonicalise all the way to `batch_grep`. Names
 * that don't match either rule pass through unchanged.
 * @param {string} toolName - Tool name from LLM (may be prefixed / aliased)
 * @returns {string} Canonical tool name
 */
export function resolveToolName(toolName) {
  let name = toolName;
  while (name.startsWith(MCP_JUGGLER_PREFIX)) {
    name = name.slice(MCP_JUGGLER_PREFIX.length);
  }
  return TOOL_ALIASES[name] || name;
}

/**
 * Map of blocked tool names to their blocking reason messages, so
 * response-handler can give a meaningful error when the LLM calls a blocked tool.
 * @type {Map<string, string>}
 */
let _blockedToolsMap = new Map();

/**
 * Get the reason why a tool was blocked by strategy filtering.
 * Call this when LLM tries to use a tool that doesn't exist in the available tools.
 * @param {string} toolName - Name of the tool
 * @returns {string|undefined} Blocking reason or undefined if not blocked
 */
export function getBlockedToolReason(toolName) {
  return _blockedToolsMap.get(toolName);
}

/**
 * Generate tool definitions dynamically from context item and action registries
 * @async
 * @returns {Promise<ToolDefinition[]>} Array of tool definitions
 */
export async function generateToolDefinitions() {
  const tools = [];

  const contextItemRegistry = (await import('../registries/context-item-registry.js')).default;
  await contextItemRegistry.init();

  // Collect tool definitions from all context items
  const allItems = contextItemRegistry.getAll();
  for (const { class: ItemClass } of allItems) {
    const itemClass = /** @type {any} */ (ItemClass);
    if (itemClass.getToolDefinitions) {
      const itemTools = itemClass.getToolDefinitions();
      // Carry the item's subthread-delegation capability onto each of its tool
      // definitions so the worker knows which tools MAY delegate (the per-call
      // decision still runs in buildSubthreadSpec). The flag is a manifest-level
      // property of the owning item, so it applies to every tool it declares.
      if (itemClass.MANIFEST?.delegatesToSubthread) {
        for (const t of itemTools) {
          t.delegatesToSubthread = true;
        }
      }
      tools.push(...itemTools);
    }
  }

  // Add meta tools (these don't map to plugins)
  tools.push(
    {
      name: 'drop_context_items',
      category: 'meta',
      description: 'Removes context items from context when no longer needed. Use this to free up context space.',
      input_schema: {
        type: 'object',
        properties: {
          itemIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of context item IDs to drop (e.g., ["ITEM_1", "ITEM_2"])'
          }
        },
        required: ['itemIds']
      }
    }
  );

  // Strategies filter tools inline via runLoop({ tools: filteredTools })
  // The return_result tool is NOT added here: the Go worker appends it to the
  // tool list for every turn that runs inside a thread (strategy.go), so it is
  // offered exactly when w.thread.itemID != "" — the single source of truth.
  _blockedToolsMap = new Map();
  return tools;
}

