//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { pinToPinboard } from 'juggler/pinboard';
import { normalizeFilePinParameters } from '../lib/file-pin-config.js';

/**
 * Type-specific adapters from the tool's public parameters to persisted pin
 * config. The tool never accepts raw provider config: adding a pin kind means
 * adding its schema, validation and translation here.
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
    return { color: 'file', icon: 'icon-document' };
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
      description: `Attach something to the user’s Pinboard and bring it into view. Parameters depend on the requested type. This is a one-way display action: you cannot list or read the user’s existing pins. Currently supported: ${Object.values(PIN_TYPES).map((adapter) => adapter.description).join(' ')} Repeating the same request reveals the existing pin instead of adding another.`,
      input_schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: Object.keys(PIN_TYPES),
            description: 'What kind of Pinboard item to add. Currently: `file`.',
          },
          parameters: PIN_TYPES.file.schema,
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
    const adapter = PIN_TYPES[/** @type {keyof typeof PIN_TYPES} */ (type)];
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
    const adapter = PIN_TYPES[/** @type {keyof typeof PIN_TYPES} */ (params.type)];
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
}

export default PinToPinboardContextItem;
