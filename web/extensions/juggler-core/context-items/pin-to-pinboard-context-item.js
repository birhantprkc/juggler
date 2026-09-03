//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { pinToPinboard } from 'juggler/pinboard';
import { normalizeFilePinParameters } from '../lib/file-pin-config.js';

/**
 * Type-specific adapters from the tool's public parameters to persisted pin
 * config, for a type that needs bespoke normalization or identity. Anything
 * not listed here still works, via GENERIC_ADAPTER below — this is an
 * optimization for `file`, not a gate on what the tool accepts.
 */
const PIN_TYPES = Object.freeze({
  file: {
    description: '`file`: `path` is required; `isDirectory` is optional.',
    schema: {
      type: 'object',
      description: 'For `file`: `path` is required; `isDirectory` is optional.',
      properties: {
        path: { type: 'string', description: 'File or directory path, absolute or relative to the project.' },
        isDirectory: { type: 'boolean', description: 'Whether the path names a directory. A trailing slash also implies this.' },
      },
      required: ['path'],
    },
    normalize: normalizeFilePinParameters,
    toConfig: (/** @type {Record<string, any>} */ parameters) => ({
      ...parameters,
      agentRequested: true,
    }),
    identity: (/** @type {Record<string, any>} */ parameters) => parameters.path,
  },
});

/**
 * Fallback for any pinboard item type not listed in PIN_TYPES — including
 * every type an extension installs on its own. `parameters` is forwarded
 * unexamined as the pin's config; that type's own `normalizeConfig` (called
 * when the pin is mounted, see `pinboard-item-type.js`) is what validates and
 * shapes it, so this tool never needs to know a type's config shape.
 */
const GENERIC_ADAPTER = {
  normalize: (/** @type {Record<string, any>} */ parameters) => (
    parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : null
  ),
  toConfig: (/** @type {Record<string, any>} */ parameters) => ({
    ...parameters,
    agentRequested: true,
  }),
  identity: (/** @type {Record<string, any>} */ parameters) => JSON.stringify(parameters),
};

/**
 * @param {string} type - Requested pin type.
 * @returns {typeof PIN_TYPES.file|typeof GENERIC_ADAPTER|null} The adapter to use, or null for no type.
 */
function adapterFor(type) {
  return PIN_TYPES[/** @type {keyof typeof PIN_TYPES} */ (type)] || (type ? GENERIC_ADAPTER : null);
}

/**
 * Mint the stable id for an agent-requested pin. A repeated call with the same
 * normalized request is the same id, so the server's idempotent add cannot stack
 * copies if a response was lost or the model asks twice.
 * @param {string} type - Public request type.
 * @param {string} identity - Type-owned stable identity.
 * @returns {Promise<string>} A pinboard-safe id.
 */
async function pinIdFor(type, identity) {
  const bytes = new TextEncoder().encode(`${type}\n${identity}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `agent_${hex}`;
}

/** The `pin_to_pinboard` tool: a one-way request to show something to the user. */
class PinToPinboardContextItem extends ContextItem {
  static MANIFEST = {
    id: 'pin-to-pinboard',
    name: 'Pin to Pinboard',
    version: '1.0.0',
    description: 'Show something on the user’s pinboard',
    author: 'Juggler',
    requiresApproval: false,
  };

  static getBadgeOptions() {
    return { color: 'meta', icon: 'icon-document' };
  }

  static getTypeName() {
    return 'Pin to Pinboard';
  }

  /**
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definition.
   */
  static getToolDefinitions() {
    return [{
      name: 'pin_to_pinboard',
      category: 'write',
      description: `Attach something to the user’s Pinboard and bring it into view. Parameters depend on the requested type. This is a one-way display action: you cannot list or read the user’s existing pins. Built in: ${Object.values(PIN_TYPES).map((adapter) => adapter.description).join(' ')} Any other pinboard item type the user has installed as an extension is also accepted — use its id as \`type\` and give it whatever parameters that type expects; it validates its own config. Repeating the same request reveals the existing pin instead of adding another.`,
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Which kind of Pinboard item to add: `file`, or the id of any other pinboard item type the user has installed.',
          },
          parameters: {
            type: 'object',
            description: `Parameters for the requested type. ${PIN_TYPES.file.schema.description} For any other type, pass whatever parameters that type's pin expects.`,
          },
        },
        required: ['type', 'parameters'],
      },
    }];
  }

  /**
   * Validate and normalize one type-specific request.
   * @param {Record<string, unknown>} toolInput - Raw model parameters.
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result.
   */
  async validate(toolInput) {
    const type = typeof toolInput?.type === 'string' ? toolInput.type.trim() : '';
    const adapter = adapterFor(type);
    if (!adapter) {
      return { valid: false, error: `Unsupported pin type: ${type || '<missing>'}` };
    }
    const parameters = adapter.normalize(
      /** @type {Record<string, any>} */ (toolInput.parameters),
    );
    if (!parameters) {
      return { valid: false, error: `${type} parameters are invalid` };
    }
    return { valid: true, params: { type, parameters } };
  }

  /**
   * Add the pin to the shared main board and ask eligible viewers to reveal it.
   * @param {{type: string, parameters: Record<string, any>}} params - Validated request.
   * @returns {Promise<Record<string, unknown>>} Added pin descriptor.
   */
  async execute(params) {
    const adapter = adapterFor(params.type);
    const parameters = adapter?.normalize(params.parameters);
    if (!adapter || !parameters) throw new Error(`Unsupported pin type: ${params.type}`);

    const config = adapter.toConfig(parameters);
    const pin = await pinIdFor(params.type, adapter.identity(parameters));
    const from = this.conversation?.id || '';
    if (!from) throw new Error('No conversation available to attribute the Pinboard request');
    const data = await pinToPinboard({
      id: pin,
      type: params.type,
      config,
      from,
      signal: this.signal,
    });
    const kept = Array.isArray(data?.pins)
      ? data.pins.find((candidate) => candidate?.id === pin)
      : null;
    if (!kept || kept.type !== params.type || JSON.stringify(kept.config) !== JSON.stringify(config)) {
      throw new Error('The pinboard did not keep the requested pin');
    }
    return { pin, type: params.type, parameters };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Tool outcome.
   * @returns {import('juggler/context-item').ItemSummary} Model-facing summary.
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Could not pin that');
    }
    const result = /** @type {{type?: string, parameters?: Record<string, any>}} */ (outcome.result) || {};
    const label = result.type === 'file' ? result.parameters?.path : result.type;
    return this.successSummary(`Pinned ${label || 'the item'} and asked the user’s Pinboard to show it.`);
  }

  /**
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Execution state.
   * @returns {import('juggler/context-item').ResultStatusMessage} Status row.
   */
  getStatusUI(actionStatus) {
    const typeName = 'pinned';
    if (!actionStatus || actionStatus.pending) {
      return { typeName, summary: actionStatus ? 'Pinning…' : 'Pin to Pinboard', status: actionStatus ? 'running' : undefined };
    }
    if (actionStatus.success) {
      const result = /** @type {{type?: string, parameters?: Record<string, any>}} */ (actionStatus.result || {});
      const summary = result.type === 'file' ? result.parameters?.path : result.type;
      return { typeName, summary: summary || 'item', status: 'success' };
    }
    const terminal = this.resolveTerminalStatus(actionStatus, 'Could not pin that');
    return { typeName, summary: terminal.summary, status: terminal.status };
  }

  /**
   * Properties panel for a `pin_to_pinboard` action. Show the pin type and one
   * labeled row per argument the type was given, rather than the raw tool-call
   * JSON. Owns its whole display, so the generic Result section is suppressed.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean}} Suppress the generic result dump
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers, toolAction } = ctx;
    const raw = toolAction && toolAction.get ? toolAction.get('result') : null;
    const result = raw && raw.toJSON ? raw.toJSON() : (raw || {});
    const data = (result.fullResult && result.fullResult.result) || {};

    const type = String(data.type || input.type || '').trim();
    helpers.addSubsection(wrapper, 'Type', type || 'unknown', 'properties-panel-code');

    // Prefer the normalized parameters the pin was actually created with.
    const parameters = (data.parameters && typeof data.parameters === 'object' ? data.parameters : input.parameters) || {};
    const entries = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? Object.entries(parameters)
      : [];
    if (!entries.length) {
      helpers.addSubsection(wrapper, 'Parameters', 'None.', 'properties-panel-text');
    }
    for (const [name, value] of entries) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      if (value !== null && typeof value === 'object') {
        helpers.addSubsection(wrapper, label, JSON.stringify(value, null, 2), 'properties-panel-code', { language: 'json' });
      } else {
        helpers.addSubsection(wrapper, label, String(value), 'properties-panel-code');
      }
    }

    return { skipResultSection: true };
  }
}

export default PinToPinboardContextItem;
