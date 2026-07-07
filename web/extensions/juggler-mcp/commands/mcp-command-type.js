//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Apache-2.0 - see LICENSE
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   SPDX-License-Identifier: Apache-2.0

import CommandType from 'juggler/command-type';
import { mcpListServers, mcpServerControl, mcpGetLog } from 'juggler/ops';
import { extractErrorMessage } from 'juggler/ui';

/**
 * `/mcp` — inspect and control MCP servers from the composer.
 *
 *   /mcp                     list servers, status, tool counts, schema tokens
 *   /mcp start|stop|restart <name>
 *   /mcp reload              re-read config and reconcile
 *   /mcp logs <name>         recent stderr for diagnostics
 *
 * Text-first in phase 1; a richer panel is phase 2.
 * @augments CommandType
 */
class McpCommandType extends CommandType {
  static MANIFEST = {
    id: 'mcp',
    name: 'MCP Servers',
    version: '1.0.0',
    description: 'List and control connected MCP servers',
    icon: 'icon-search'
  };

  /**
   * @param {string[]} args
   * @returns {Promise<import('juggler/command-type').CommandResult>} Command result
   */
  async execute(args) {
    const [sub, name] = args;
    try {
      switch ((sub || '').toLowerCase()) {
        case '':
        case 'list':
          return { handled: true, message: await McpCommandType._list() };
        case 'start':
        case 'stop':
        case 'restart':
          if (!name) return { handled: true, message: `Usage: /mcp ${sub} <server>` };
          await mcpServerControl({ server: name, action: /** @type {any} */ (sub) });
          return { handled: true, message: await McpCommandType._list() };
        case 'reload': {
          // Any server works as the reconcile target; the manager reloads all.
          const { servers } = await mcpListServers();
          const target = servers[0]?.name;
          if (target) await mcpServerControl({ server: target, action: 'reload' });
          return { handled: true, message: await McpCommandType._list() };
        }
        case 'logs':
          if (!name) return { handled: true, message: 'Usage: /mcp logs <server>' };
          {
            const { log } = await mcpGetLog({ server: name });
            return { handled: true, message: log ? `MCP "${name}" recent output:\n\n${log}` : `No recent output for "${name}".` };
          }
        default:
          return { handled: true, message: `Unknown subcommand "${sub}". Try: /mcp, /mcp start|stop|restart <server>, /mcp reload, /mcp logs <server>` };
      }
    } catch (err) {
      return { handled: true, message: `MCP command failed: ${extractErrorMessage(err)}` };
    }
  }

  /**
   * Render the server table as text.
   * @returns {Promise<string>} Rendered text
   * @private
   */
  static async _list() {
    const { servers } = await mcpListServers();
    if (!servers || servers.length === 0) {
      return 'No MCP servers configured. Add them to ~/.juggler/mcp.json or <project>/.juggler/mcp.json.';
    }
    const lines = servers.map((s) => {
      const tok = s.schemaTokens ? ` · ~${McpCommandType._fmtTokens(s.schemaTokens)} tokens/request` : '';
      const err = s.error ? `\n    ↳ ${String(s.error).split('\n')[0]}` : '';
      const ver = s.serverName ? ` [${s.serverName}${s.serverVersion ? ' ' + s.serverVersion : ''}]` : '';
      return `• ${s.name} — ${s.status}${ver} · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}${tok}${err}`;
    });
    return `MCP servers:\n${lines.join('\n')}`;
  }

  /**
   * @param {number} n
   * @returns {string} Result value
   * @private
   */
  static _fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
}

export default McpCommandType;
