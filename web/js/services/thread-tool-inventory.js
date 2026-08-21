//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which tools a thread offers the model, and which its strategy holds back.
 *
 * This is the single place the answer is worked out. The turn path asks for
 * `offered` and sends exactly that; the System Prompt panel shows the same
 * result to the user. Answering the question twice — once to send, once to
 * display — is how a transparency surface ends up quietly disagreeing with what
 * was actually sent, so there is one function and both callers use it.
 *
 * `withheld` exists because "the tool is not there" and "the tool is there but
 * your strategy won't allow it" are different problems with the same symptom,
 * and only this function can tell them apart.
 */

import { generateToolDefinitions } from './tool-generator.js';
import { estimateValueTokens } from '../utils/token-estimate.js';

/**
 * @typedef {object} ToolInventory
 * @property {Array<Record<string, any>>} offered - Tools the model is given, in the order it receives them.
 * @property {Array<Record<string, any>>} withheld - Tools the strategy removed.
 * @property {string} strategyName - Display name of the strategy that did the withholding, or '' if none did.
 */

/**
 * Build the tool inventory for one thread.
 *
 * A thread with no strategy, or a strategy that doesn't filter, offers
 * everything — the common case, and the one where `withheld` is empty.
 * @param {{strategy?: any}|null|undefined} messageThread - The thread whose turn this is.
 * @returns {Promise<ToolInventory>} What the model gets, and what it doesn't.
 */
export async function buildToolInventory(messageThread) {
  return splitToolsByStrategy(await generateToolDefinitions(), messageThread?.strategy);
}

/**
 * Split a tool set into what a strategy allows through and what it holds back.
 *
 * The decision itself, separated from where the tools come from: `offered` is
 * the strategy's own output, passed on untouched, so nothing can differ between
 * what this reports and what the strategy would hand the turn. Pure — exported
 * for unit testing.
 * @param {Array<Record<string, any>>} all - Every tool registered for this session.
 * @param {any} strategy - The thread's strategy, if it has one.
 * @returns {ToolInventory} What the model gets, and what it doesn't.
 */
export function splitToolsByStrategy(all, strategy) {
  if (typeof strategy?.filterTools !== 'function') {
    return { offered: all, withheld: [], strategyName: '' };
  }

  const offered = strategy.filterTools(all) || [];
  const kept = new Set(offered.map((/** @type {any} */ t) => t?.name));
  return {
    offered,
    withheld: all.filter((/** @type {any} */ t) => !kept.has(t?.name)),
    strategyName: strategyDisplayName(strategy)
  };
}

/**
 * A strategy's human name for the "withheld by …" line, falling back through the
 * manifest to the class name so the line never reads "withheld by undefined".
 * @param {any} strategy - Strategy instance.
 * @returns {string} Display name, or '' when nothing usable is available.
 */
export function strategyDisplayName(strategy) {
  if (!strategy) return '';
  const manifest = strategy.constructor?.MANIFEST;
  return String(manifest?.name || manifest?.id || strategy.constructor?.name || '');
}

/**
 * Split `mcp__<server>__<tool>` into its parts, mirroring how the MCP bridge
 * composes the name. Returns null for anything else, which is every built-in
 * tool.
 * @param {string} name - LLM-facing tool name.
 * @returns {{server: string, tool: string}|null} Parts, or null when not an MCP tool.
 */
export function parseMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * How two tool lists differ, by name.
 *
 * One surface holds the list a turn recorded, another holds the list the thread
 * would send now, and the interesting question on both is the same: has the set
 * moved since. Names are the comparable part — a schema edit is not a tool
 * appearing or disappearing.
 * @param {Array<Record<string, any>>} sent - The recorded list.
 * @param {Array<Record<string, any>>} live - The current list.
 * @returns {{added: string[], removed: string[]}} Names in `live` but not `sent`, and the reverse.
 */
export function diffToolNames(sent, live) {
  const sentNames = new Set(sent.map((t) => String(t?.name || '')));
  const liveNames = new Set(live.map((t) => String(t?.name || '')));
  return {
    added: [...liveNames].filter((n) => !sentNames.has(n)),
    removed: [...sentNames].filter((n) => !liveNames.has(n))
  };
}

/**
 * The counted half of the drift statement — "3 added, 1 gone" — shared by every
 * surface that makes it, so the two never come to word it differently. Each
 * surface supplies its own trailing clause, because "since" points forwards from
 * a recorded turn and backwards from the live list.
 * @param {{added: string[], removed: string[]}|null|undefined} drift - A {@link diffToolNames} result.
 * @returns {string} The summary, or '' when the lists match.
 */
export function formatToolDrift(drift) {
  const changes = [];
  if (drift?.added.length) changes.push(`${drift.added.length} added`);
  if (drift?.removed.length) changes.push(`${drift.removed.length} gone`);
  return changes.join(', ');
}

/**
 * The names behind a drift summary, for the tooltip that answers "which ones?".
 * @param {{added: string[], removed: string[]}|null|undefined} drift - A {@link diffToolNames} result.
 * @returns {string} Multi-line detail, or '' when the lists match.
 */
export function toolDriftDetail(drift) {
  return [
    drift?.added.length ? `Added: ${drift.added.join(', ')}` : '',
    drift?.removed.length ? `Gone: ${drift.removed.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * Bucket tools by origin: the built-ins together, then one group per MCP
 * server. Servers are ordered by name rather than by size — you come here
 * looking for a particular server, so a stable alphabetical position beats a
 * position that moves as tools are added. Within a group the most expensive
 * schema sorts first, because that is the one worth knowing about.
 * @param {Array<Record<string, any>>} tools - Tool definitions.
 * @returns {Array<{title: string, server: string|null, tools: Array<Record<string, any>>, tokens: number}>} Groups in display order.
 */
export function groupToolsByOrigin(tools) {
  /** @type {Map<string|null, Array<Record<string, any>>>} */
  const buckets = new Map();
  for (const tool of tools) {
    const parts = parseMcpToolName(String(tool?.name || ''));
    const key = parts ? parts.server : null;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(tool);
    else buckets.set(key, [tool]);
  }

  const servers = /** @type {string[]} */ ([...buckets.keys()].filter((k) => k !== null)).sort();
  /** @type {Array<string|null>} */
  const order = buckets.has(null) ? [null, ...servers] : servers;

  return order.map((key) => {
    const group = (buckets.get(key) || []).slice()
      .sort((a, b) => estimateValueTokens(b) - estimateValueTokens(a));
    return {
      title: key === null ? 'Juggler tools' : `MCP · ${key}`,
      server: key,
      tools: group,
      tokens: group.reduce((sum, t) => sum + estimateValueTokens(t), 0)
    };
  });
}
