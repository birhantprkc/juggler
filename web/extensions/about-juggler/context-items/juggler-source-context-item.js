//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { resolveAssetUrl } from '../../../js/utils/asset-url.js';

/**
 * Normalise a caller-supplied path to a served, root-relative asset URL, or
 * return null if it is not an allowed extension-authoring source path.
 *
 * The running app serves its bundled web assets same-origin under a fixed set of
 * prefixes; only sdk/ (the extension SDK base classes) and extensions/ (the
 * built-in example extensions, e.g. the `@juggler/core` extension) are exposed
 * here — those are the canonical authoring reference. A leading "web/" is
 * accepted because that is how the files are named in the repo; it maps onto the
 * same served path. Any
 * parent-directory escape or out-of-scope prefix is rejected.
 * @param {string} raw - Caller path, e.g. 'sdk/context-item.js' or
 *   'web/extensions/juggler-core/context-items/read-file-context-item.js'
 * @returns {string|null} A root-relative URL ('/sdk/...' or '/extensions/...'),
 *   or null when the path is not permitted.
 */
function toAssetURL(raw) {
  let p = String(raw || '').trim().replace(/^\/+/, '');
  p = p.replace(/^web\//, '');
  if (p.includes('..') || p.includes('\0')) {
    return null;
  }
  if (!/^(sdk|extensions)\//.test(p)) {
    return null;
  }
  return '/' + p;
}

/**
 * @typedef {object} JugglerSourceParams
 * @property {string} path - Repo-relative path under sdk/ or extensions/.
 */

/**
 * @typedef {object} JugglerSourceResult
 * @property {string} path - The normalised path that was read.
 * @property {string} url - The served URL it resolved to.
 * @property {number} bytes - Length of the returned source in characters.
 * @property {string} content - The file's source text.
 */

/**
 * JugglerSourceContextItem — read the source of Juggler's own extension SDK base
 * classes and built-in example extensions, so the model can write or debug a
 * Juggler extension without the repo checked out.
 *
 * The About-Juggler manual (the AboutJuggler tool) points at these files for the
 * exact API; this tool fetches them from the running app. It executes
 * same-origin with the server, so a fetch() of the app-served asset paths works
 * offline and with no repo — unlike the WebFetch tool, which only reaches
 * external https URLs. Those assets are mounted under the cache-busting
 * "/v<staticVersion>" prefix and only there, so the request goes through
 * resolveAssetUrl(); the unprefixed path is what the caller asked for and stays
 * the reported path. Reads are restricted to the sdk/ and extensions/ trees so
 * this stays a documentation-reading tool, not an arbitrary same-origin fetch.
 * @class
 * @augments ContextItem
 */
class JugglerSourceContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'juggler-source',
    name: 'Read Juggler Source',
    version: '1.0.0',
    description: 'Read Juggler SDK base classes and example-extension source',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for the ReadJugglerSource action.
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo-relative path under sdk/ or extensions/ — e.g. '
            + '"sdk/context-item.js", "sdk/command-type.js", or '
            + '"extensions/juggler-core/context-items/read-file-context-item.js". '
            + 'A leading "web/" is accepted.'
        }
      },
      required: ['path']
    };

    const description = 'Read the actual source of Juggler\'s extension SDK base '
      + 'classes and built-in example extensions, to write or debug a Juggler '
      + 'extension without the repo checked out. Give a path under sdk/ (the base '
      + 'classes: context-item.js, strategy-type.js, command-type.js — each opens '
      + 'with a quickstart and full method reference) or extensions/ (working '
      + 'examples under extensions/juggler-core/). Returns the file\'s source text. '
      + 'Use this when the AboutJuggler manual points you at a file and you need '
      + 'its exact API. For anything else about Juggler, call AboutJuggler instead.';

    return [
      {
        name: 'ReadJugglerSource',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Validate parameters: path must be a non-empty string in the allowed trees.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {JugglerSourceParams} */ (toolInput);
    if (typeof params.path !== 'string' || params.path.trim() === '') {
      return { valid: false, error: 'Parameter "path" must be a non-empty string' };
    }
    if (!toAssetURL(params.path)) {
      return {
        valid: false,
        error: 'path must be under sdk/ or extensions/ (e.g. sdk/context-item.js)'
      };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * Execute — fetch the requested source file from the running app, same-origin.
   * Returns raw data; the framework wraps it as outcome.result.
   * @param {Record<string, unknown>} params - Prepared params
   * @returns {Promise<JugglerSourceResult>} The source text (and where it came from)
   */
  async execute(params) {
    const p = /** @type {JugglerSourceParams} */ (params);
    const url = toAssetURL(p.path);
    if (!url) {
      throw new Error('path must be under sdk/ or extensions/');
    }
    const doFetch = typeof fetch === 'function'
      ? fetch
      : (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
    if (typeof doFetch !== 'function') {
      throw new Error('No fetch available to read Juggler source in this context');
    }
    const res = await doFetch(resolveAssetUrl(url));
    if (!res.ok) {
      throw new Error('Could not read ' + url + ' (HTTP ' + res.status + ')');
    }
    const content = await res.text();
    return { path: url.slice(1), url, bytes: content.length, content };
  }

  /**
   * Format the outcome for the LLM tool_result and display. The source text is
   * the tool_result content.
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return this.failureSummary(outcome.error || 'Failed to read Juggler source');
    }
    const result = /** @type {JugglerSourceResult} */ (outcome.result);
    return this.successSummary(result.content || '');
  }

  /**
   * Status UI: a small lozenge naming the file that was read.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const path = toolInput && typeof toolInput.path === 'string' ? toolInput.path : '';

    return this.buildStatusUI(actionStatus, {
      typeName: 'Juggler Source',
      pending: 'Reading Juggler source\u2026',
      success: path || 'Juggler source',
      failurePrefix: 'Failed'
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Source';
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Syntax-highlight language for the result body
   */
  static resultSectionLanguage(_toolName) {
    return 'javascript';
  }
}

export default JugglerSourceContextItem;
