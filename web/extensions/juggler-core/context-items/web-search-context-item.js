//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { webSearch } from 'juggler/ops';
import { parseDuckDuckGoResponse, looksLikeNoResults, filterResults } from './web-search/ddg-parser.js';

/**
 * @typedef {object} WebSearchParams
 * @property {string} query - The search query
 * @property {string[]} [allowed_domains] - Only include results from these domains
 * @property {string[]} [blocked_domains] - Exclude results from these domains
 */

/** @typedef {import('./web-search/ddg-parser.js').WebSearchResultItem} WebSearchResultItem */

/**
 * @typedef {object} WebSearchResult
 * @property {string} query - The search query
 * @property {WebSearchResultItem[]} results - Search results
 * @property {number} count - Number of results
 * @property {string} provider - Provider used (e.g., "DuckDuckGo")
 */

/**
 * WebSearchContextItem - Search the web
 *
 * Uses DuckDuckGo HTML endpoint. No API key required.
 * Backend acts as CORS proxy, all logic (parsing, filtering) in frontend — the
 * scraping and domain filtering themselves live in `web-search/ddg-parser.js`,
 * leaving this class the request, the retry ladder and the rendering.
 * @class
 * @augments ContextItem
 */
class WebSearchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'web-search',
    name: 'Web Search',
    version: '2.0.0',
    description: 'Search the web (no API key required)',
    author: 'Juggler Team',
    requiresApproval: false
  };

  // DuckDuckGo HTML endpoint URL
  static DDG_URL = 'https://html.duckduckgo.com/html/';

  // Retry policy for DuckDuckGo rate-limit / captcha responses. DuckDuckGo
  // throttles bursts of requests from one IP, so a blocked response is retried
  // a few times with exponential backoff + jitter before giving up.
  static MAX_RETRIES = 2;
  static RETRY_BASE_MS = 400;

  /**
   * Get tool definitions for WebSearch action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          description: 'The search query to use'
        },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include search results from these domains'
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude search results from these domains'
        }
      },
      required: ['query']
    };

    const description = 'Searches the web using DuckDuckGo (no API key required). Returns up to 10 results with titles, URLs, and descriptions. Supports domain filtering.';

    return [
      {
        name: 'WebSearch',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * Build DuckDuckGo search params (POST)
   * @param {string} query - Search query
   * @returns {object} Params for backend CORS proxy
   */
  buildDuckDuckGoParams(query) {
    return {
      url: WebSearchContextItem.DDG_URL,
      method: 'POST',
      form_data: {
        q: query,
        b: '',  // offset
        kl: ''  // region
      }
    };
  }

  /**
   * Abortable delay used for retry backoff. Rejects promptly if the search's
   * abort signal fires while waiting, so a cancelled search does not sit out
   * the backoff.
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>} Resolves after `ms`, rejects on abort
   */
  delay(ms) {
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      }, { once: true });
    });
  }

  /**
   * Search using DuckDuckGo.
   *
   * DuckDuckGo throttles bursts of requests from a single IP, returning a
   * captcha/challenge page instead of results. Such a response parses to zero
   * result blocks and carries no genuine "no results" marker; it is retried
   * with exponential backoff + jitter up to {@link WebSearchContextItem.MAX_RETRIES}
   * times before the captcha error is surfaced. A genuine empty result set
   * (the `no-results` marker is present) returns successfully with zero results.
   * @param {string} query - Search query
   * @param {string[]} [allowedDomains] - Allowed domains
   * @param {string[]} [blockedDomains] - Blocked domains
   * @returns {Promise<WebSearchResult>} Search result
   */
  async search(query, allowedDomains, blockedDomains) {
    const ddgParams = this.buildDuckDuckGoParams(query);
    const maxAttempts = WebSearchContextItem.MAX_RETRIES + 1;

    /** @type {WebSearchResultItem[]} */
    let results = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await webSearch(
        /** @type {import('../../../js/services/ops-api.js').WebSearchParams} */ (ddgParams),
        this.signal
      );

      results = parseDuckDuckGoResponse(response.content);
      if (results.length > 0 || looksLikeNoResults(response.content)) {
        break; // got hits, or a genuine empty result set — either way, done
      }

      // Zero result blocks and no "no results" marker: almost certainly a
      // rate-limit/captcha page. Retry with backoff unless attempts are spent.
      if (attempt === maxAttempts) {
        throw new Error('No results found - may be blocked or need captcha');
      }
      const backoff = WebSearchContextItem.RETRY_BASE_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * WebSearchContextItem.RETRY_BASE_MS);
      await this.delay(backoff + jitter);
    }

    const filtered = filterResults(results, allowedDomains, blockedDomains);

    return {
      query,
      results: filtered.slice(0, 10),
      count: filtered.length,
      provider: 'DuckDuckGo'
    };
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {WebSearchParams} */ (toolInput);

    if (!params.query) {
      return { valid: false, error: 'Missing required parameter: query' };
    }
    if (typeof params.query !== 'string') {
      return { valid: false, error: 'Parameter "query" must be a string' };
    }
    if (params.query.length < 2) {
      return { valid: false, error: 'Parameter "query" must be at least 2 characters' };
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Execute the web search
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<WebSearchResult>} Search result
   */
  async execute(params) {
    const searchParams = /** @type {WebSearchParams} */ (params);

    return await this.search(
      searchParams.query,
      searchParams.allowed_domains,
      searchParams.blocked_domains
    );
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{query?: string}} */ (prepared?.params || {});
    const query = prepParams.query || 'unknown';

    if (!outcome.success) {
      return this.failureSummary(outcome.error || `Search failed for "${query}"`);
    }

    const result = /** @type {WebSearchResult} */ (outcome.result);
    const results = result.results || [];

    if (results.length === 0) {
      return this.successSummary(`No results found for "${query}"`, { icon: '○' });
    }

    // Format results for LLM - include markdown links
    const lines = [`Search results for "${query}" (via ${result.provider}):\n`];
    for (const item of results) {
      lines.push(`- [${item.title}](${item.url})`);
      if (item.description) {
        lines.push(`  ${item.description}`);
      }
      lines.push('');
    }

    return this.successSummary(lines.join('\n'));
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const query = String(toolInput?.query || 'unknown');
    const displayQuery = query.length > 40 ? query.substring(0, 40) + '...' : query;

    return this.buildStatusUI(actionStatus, {
      typeName: 'Web Search',
      pending: `Searching for "${displayQuery}"...`,
      success: () => {
        const result = /** @type {WebSearchResult} */ (actionStatus?.result);
        const count = result.count || result.results?.length || 0;
        const provider = result.provider || 'search';
        return `Found ${count} result${count === 1 ? '' : 's'} for "${displayQuery}" (${provider})`;
      }
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return 'Results';
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    const q = input.query !== null && input.query !== undefined ? String(input.query) : '';
    helpers.addSubsection(wrapper, 'Query', q, 'properties-panel-code');
  }
}

export default WebSearchContextItem;
