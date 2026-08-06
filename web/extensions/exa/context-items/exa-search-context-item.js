//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { extensionConfigResolve, httpRequest } from 'juggler/ops';

const EXTENSION_ID = '@juggler/exa';
const SEARCH_URL = 'https://api.exa.ai/search';
const SEARCH_TYPES = new Set(['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning']);

/**
 * @typedef {object} ExaSearchParams
 * @property {string} query - Search query
 * @property {number} [numResults] - Number of results, from 1 to 100
 * @property {'instant'|'fast'|'auto'|'deep-lite'|'deep'|'deep-reasoning'} [type] - Search mode
 * @property {string[]} [include_domains] - Domains to include
 * @property {string[]} [exclude_domains] - Domains to exclude
 * @property {boolean} [text] - Include extracted page text
 */

/**
 * @typedef {object} ExaSearchResultItem
 * @property {string} title - Result title
 * @property {string} url - Result URL
 * @property {string} [id] - Exa result id
 * @property {string} [text] - Extracted page text
 * @property {string} [publishedDate] - Publication date
 * @property {string} [author] - Author
 * @property {number} [score] - Relevance score
 */

/**
 * @typedef {object} ExaSearchResult
 * @property {string} query - Search query
 * @property {ExaSearchResultItem[]} results - Ranked search results
 * @property {number} count - Number of returned results
 * @property {string} provider - Search provider
 * @property {string} [requestId] - Exa request id
 */

/** Search the web with Exa. */
class ExaSearchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'exa-search',
    name: 'Exa Search',
    version: '0.1.0',
    description: 'Search the web with Exa',
    author: 'Juggler Team',
    requiresApproval: false
  };

  /** @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions */
  static getToolDefinitions() {
    return [{
      name: 'exa_search',
      category: 'read',
      description: 'Search the web with Exa and return ranked results with optional extracted page text.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'The search query'
          },
          numResults: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 10,
            description: 'Number of results to return (default 10)'
          },
          type: {
            type: 'string',
            enum: ['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'],
            default: 'auto',
            description: 'Search mode (default auto)'
          },
          include_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only include results from these domains or domain paths'
          },
          exclude_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude results from these domains or domain paths'
          },
          text: {
            type: 'boolean',
            default: true,
            description: 'Include extracted page text in results (default true)'
          }
        },
        required: ['query']
      }
    }];
  }

  /**
   * @param {Record<string, unknown>} toolInput - Raw parameters from the model
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {ExaSearchParams} */ (toolInput);
    if (typeof params.query !== 'string' || params.query.trim() === '') {
      return { valid: false, error: 'Parameter "query" must be a non-empty string' };
    }
    if (params.numResults !== undefined &&
        (!Number.isInteger(params.numResults) || params.numResults < 1 || params.numResults > 100)) {
      return { valid: false, error: 'Parameter "numResults" must be an integer from 1 to 100' };
    }
    if (params.type !== undefined && !SEARCH_TYPES.has(params.type)) {
      return { valid: false, error: 'Parameter "type" must be one of: instant, fast, auto, deep-lite, deep, deep-reasoning' };
    }
    for (const key of /** @type {const} */ (['include_domains', 'exclude_domains'])) {
      const domains = params[key];
      if (domains !== undefined &&
          (!Array.isArray(domains) || domains.some(domain => typeof domain !== 'string' || domain.trim() === ''))) {
        return { valid: false, error: `Parameter "${key}" must be an array of non-empty strings` };
      }
    }
    if (params.text !== undefined && typeof params.text !== 'boolean') {
      return { valid: false, error: 'Parameter "text" must be a boolean' };
    }
    return { valid: true, params: { ...toolInput, query: params.query.trim() } };
  }

  /**
   * @param {Record<string, unknown>} params - Validated tool parameters
   * @returns {Promise<ExaSearchResult>} Search result
   */
  async execute(params) {
    const searchParams = /** @type {ExaSearchParams} */ (params);
    const config = /** @type {{api_key?: string}} */ (
      await extensionConfigResolve({ extId: EXTENSION_ID }, this.signal)
    );
    const apiKey = typeof config.api_key === 'string' ? config.api_key.trim() : '';
    if (!apiKey) {
      throw new Error('Exa API key is not configured. Set it in Settings → Extensions → Exa Search.');
    }

    /** @type {Record<string, unknown>} */
    const body = {
      query: searchParams.query,
      numResults: searchParams.numResults ?? 10,
      type: searchParams.type ?? 'auto',
      contents: { text: searchParams.text ?? true }
    };
    if (searchParams.include_domains?.length) body.includeDomains = searchParams.include_domains;
    if (searchParams.exclude_domains?.length) body.excludeDomains = searchParams.exclude_domains;

    const response = await httpRequest({
      method: 'POST',
      url: SEARCH_URL,
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    }, this.signal);

    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch {
      if (response.status < 200 || response.status >= 300) {
        const message = response.body.trim() || response.statusText || 'Unknown error';
        throw new Error(`Exa request failed (HTTP ${response.status}): ${message}`);
      }
      throw new Error(`Exa returned invalid JSON (HTTP ${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
      const message = payload?.error?.message || payload?.error || payload?.message || response.statusText;
      throw new Error(`Exa request failed (HTTP ${response.status}): ${String(message || 'Unknown error')}`);
    }
    if (!Array.isArray(payload?.results)) {
      throw new Error('Exa response is missing a results array');
    }

    return {
      query: searchParams.query,
      results: payload.results,
      count: payload.results.length,
      provider: 'Exa',
      ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {})
    };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const query = String(outcome.prepared?.params?.query || 'unknown');
    if (!outcome.success) {
      return { summary: outcome.error || `Exa search failed for "${query}"`, details: '', success: false, icon: '✗' };
    }

    const result = /** @type {ExaSearchResult} */ (outcome.result);
    if (!result.results?.length) {
      return { summary: `No Exa results found for "${query}"`, details: '', success: true, icon: '○' };
    }

    const lines = [`Exa search results for "${query}":\n`];
    for (const item of result.results) {
      lines.push(`- [${item.title || item.url}](${item.url})`);
      const metadata = [item.author, item.publishedDate].filter(Boolean).join(' — ');
      if (metadata) lines.push(`  ${metadata}`);
      if (item.text) lines.push(`  ${item.text}`);
      lines.push('');
    }
    return { summary: lines.join('\n'), details: '', success: true, icon: '✓' };
  }

  /**
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action status
   * @param {Record<string, unknown>} toolInput - Original tool input
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message
   */
  getStatusUI(actionStatus, toolInput) {
    if (!actionStatus) return null;
    const query = String(toolInput?.query || 'unknown');
    const displayQuery = query.length > 40 ? query.substring(0, 40) + '...' : query;
    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `Searching Exa for "${displayQuery}"...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {ExaSearchResult} */ (actionStatus.result);
      const count = result.count ?? result.results?.length ?? 0;
      summary = `Found ${count} Exa result${count === 1 ? '' : 's'} for "${displayQuery}"`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus));
    }
    return { typeName: 'Exa Search', summary, status };
  }

  /** @returns {string} Result section label */
  static getResultSectionLabel() {
    return 'Results';
  }

  /**
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   */
  renderToolActionDetails(wrapper, ctx) {
    const query = ctx.input.query !== null && ctx.input.query !== undefined ? String(ctx.input.query) : '';
    ctx.helpers.addSubsection(wrapper, 'Query', query, 'properties-panel-code');
  }
}

export default ExaSearchContextItem;
