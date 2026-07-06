//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { webFetch } from 'juggler/ops';
import { smartTruncate } from 'juggler/ui';

/**
 * @typedef {object} WebFetchParams
 * @property {string} url - The URL to fetch content from
 * @property {string} prompt - What to extract from the page
 */

/**
 * @typedef {object} WebFetchResult
 * @property {string} url - The URL that was fetched
 * @property {string} content - The extracted content (HTML converted to markdown)
 * @property {string} prompt - The prompt that was used
 * @property {boolean} cached - Whether the result was from cache
 * @property {boolean} [truncated] - Whether content was truncated
 * @property {boolean} [redirect] - Whether a redirect was detected
 * @property {string} [redirect_url] - The redirect URL if redirect is true
 * @property {string} [error] - Error message if redirect or failure
 */

/**
 * WebFetchContextItem - Fetch and process web content
 *
 * Fetches content from a URL and converts HTML to markdown for analysis.
 * Includes a 15-minute cache to avoid repeated fetches.
 * @class
 * @augments ContextItem
 */
class WebFetchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'web-fetch',
    name: 'Web Fetch',
    version: '1.0.0',
    description: 'Fetch and process web content',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /**
   * Get tool definitions for WebFetch action
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    const inputSchema = {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'The URL to fetch content from'
        },
        prompt: {
          type: 'string',
          description: 'The prompt describing what information to extract from the page'
        }
      },
      required: ['url', 'prompt']
    };

    const description = 'Fetches content from a URL and processes it. Takes a URL and a prompt, fetches the content, converts HTML to markdown, and returns the result. Includes a 15-minute cache.';

    return [
      {
        name: 'WebFetch',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {WebFetchParams} */ (toolInput);

    if (!params.url) {
      return { valid: false, error: 'Missing required parameter: url' };
    }
    if (typeof params.url !== 'string') {
      return { valid: false, error: 'Parameter "url" must be a string' };
    }
    if (!params.prompt) {
      return { valid: false, error: 'Missing required parameter: prompt' };
    }
    if (typeof params.prompt !== 'string') {
      return { valid: false, error: 'Parameter "prompt" must be a string' };
    }

    // Basic URL validation
    try {
      new URL(params.url);
    } catch {
      return { valid: false, error: 'Parameter "url" must be a valid URL' };
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Execute the web fetch
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<WebFetchResult>} Fetch result
   */
  async execute(params) {
    const fetchParams = /** @type {WebFetchParams} */ (params);

    const result = await webFetch(
      { url: fetchParams.url, prompt: fetchParams.prompt },
      this.signal
    );

    return /** @type {WebFetchResult} */ (result);
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{url?: string}} */ (prepared?.params || {});
    const url = prepParams.url || 'unknown';

    if (!outcome.success) {
      return {
        summary: outcome.error || `Failed to fetch ${url}`,
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {WebFetchResult} */ (outcome.result);

    // Handle redirect case
    if (result.redirect) {
      return {
        summary: `Redirect detected: ${result.redirect_url}\n${result.error || ''}`,
        details: '',
        success: true,
        icon: '→'
      };
    }

    // Build summary for LLM
    let summary = result.content || '';
    if (result.truncated) {
      summary += '\n\n(Content was truncated due to size limits)';
    }
    if (result.cached) {
      summary += '\n\n(From cache)';
    }

    // Apply smart truncation
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: truncatedSummary, truncated: wasTruncated } = smartTruncate(summary, { maxChars: budget });
    if (wasTruncated) {
      summary = truncatedSummary + `\n\n(Output truncated from ${summary.length} to ${truncatedSummary.length} chars)`;
    }

    return {
      summary,
      details: '',
      success: true,
      icon: '✓'
    };
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) {
      return null;
    }

    const url = String(toolInput?.url || 'unknown');
    // Truncate URL for display
    const displayUrl = url.length > 60 ? url.substring(0, 60) + '...' : url;

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `Fetching ${displayUrl}...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {WebFetchResult} */ (actionStatus.result);

      if (result.redirect) {
        summary = `Redirect to: ${result.redirect_url}`;
        status = 'success';
      } else {
        const cacheStr = result.cached ? ' (cached)' : '';
        const truncStr = result.truncated ? ' (truncated)' : '';
        summary = `${displayUrl}${cacheStr}${truncStr}`;
        status = 'success';
      }
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus, 'Failed'));
    }

    return { typeName: 'Web Fetch', summary, status };
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Content';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    const url = input.url !== null && input.url !== undefined ? String(input.url) : '';
    helpers.addSubsection(wrapper, 'URL', url, 'properties-panel-code');
    if (input.prompt) {
      const p = input.prompt !== null && input.prompt !== undefined ? String(input.prompt) : '';
      helpers.addSubsection(wrapper, 'Prompt', p, 'properties-panel-code');
    }
  }
}

export default WebFetchContextItem;
