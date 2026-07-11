//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { webSearch } from 'juggler/ops';

/**
 * @typedef {object} WebSearchParams
 * @property {string} query - The search query
 * @property {string[]} [allowed_domains] - Only include results from these domains
 * @property {string[]} [blocked_domains] - Exclude results from these domains
 */

/**
 * @typedef {object} WebSearchResultItem
 * @property {string} title - Result title
 * @property {string} url - Result URL
 * @property {string} description - Result description/snippet
 */

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
 * Backend acts as CORS proxy, all logic (parsing, filtering) in frontend.
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
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
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
   * Parse DuckDuckGo HTML response.
   *
   * The engine runs inside a Web Worker, which has no `document`/`DOMParser`,
   * so the markup is split into per-result blocks and scraped with bounded
   * regexes. Each hit is wrapped in an element carrying a standalone `result`
   * class (e.g. `<div class="result results_links ...">`); within a block the
   * link comes from `.result__a`, the title from `.result__title` (falling back
   * to the link text), and the snippet from `.result__snippet`.
   *
   * Returns an empty array when the markup contains no result blocks. Callers
   * distinguish a genuine empty result set from a blocked/captcha page via
   * {@link WebSearchContextItem#looksLikeNoResults} rather than treating every
   * empty parse as an error.
   * @param {string} content - Raw HTML response
   * @returns {WebSearchResultItem[]} Parsed results (possibly empty)
   */
  parseDuckDuckGoResponse(content) {
    /** @type {WebSearchResultItem[]} */
    const results = [];

    for (const block of this.splitResultBlocks(content)) {
      const url = this.extractAttr(block, 'result__a', 'href');
      if (url === null) {
        continue;
      }

      const titleHtml = this.extractElementHtml(block, 'result__title');
      const title = this.htmlToText(
        titleHtml !== null ? titleHtml : (this.extractElementHtml(block, 'result__a') || '')
      );

      const snippetHtml = this.extractElementHtml(block, 'result__snippet');
      const description = snippetHtml !== null ? this.htmlToText(snippetHtml) : '';

      results.push({ title, url, description });
    }

    return results;
  }

  /**
   * Detect DuckDuckGo's genuine "no results" page — a valid results page that
   * simply had no hits — as opposed to a rate-limit/captcha challenge page.
   * DuckDuckGo marks the former with a `no-results` container; a response with
   * zero result blocks and no such marker is treated as blocked and is worth
   * retrying.
   * @param {string} content - Raw HTML response
   * @returns {boolean} True if the page is a genuine empty result set
   */
  looksLikeNoResults(content) {
    return /\bclass\s*=\s*"[^"]*\bno-results\b[^"]*"/i.test(content);
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
   * Slice HTML into per-result blocks at each element whose class list contains
   * a standalone `result` class. Each block runs to the next block start (or end
   * of input), so the title/link/snippet scrapers stay scoped to one result.
   * @param {string} content - Raw HTML response
   * @returns {string[]} Per-result HTML fragments
   */
  splitResultBlocks(content) {
    const blockStart = /<(?:div|tr|li|article)\b[^>]*\bclass\s*=\s*"[^"]*\bresult\b[^"]*"[^>]*>/gi;
    /** @type {number[]} */
    const starts = [];
    let m;
    while ((m = blockStart.exec(content)) !== null) {
      starts.push(m.index);
    }

    return starts.map((start, i) =>
      content.slice(start, i + 1 < starts.length ? starts[i + 1] : content.length)
    );
  }

  /**
   * Read an attribute off the first tag in `html` carrying `className`.
   * @param {string} html - HTML fragment
   * @param {string} className - Class to locate (e.g. `result__a`)
   * @param {string} attr - Attribute name (e.g. `href`)
   * @returns {string|null} Decoded attribute value, or null if absent
   */
  extractAttr(html, className, attr) {
    const open = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
    const tag = open.exec(html);
    if (!tag) {
      return null;
    }
    const a = new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, 'i').exec(tag[0]);
    return a ? this.decodeEntities(/** @type {string} */ (a[1])) : null; // bounded: mandatory capture group
  }

  /**
   * Return the inner HTML of the first element in `html` carrying `className`,
   * up to that element's first matching close tag.
   * @param {string} html - HTML fragment
   * @param {string} className - Class to locate
   * @returns {string|null} Inner HTML, or null if no such element
   */
  extractElementHtml(html, className) {
    const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
    const tag = open.exec(html);
    if (!tag) {
      return null;
    }
    const rest = html.slice(tag.index + tag[0].length);
    const close = new RegExp(`</${tag[1]}\\s*>`, 'i').exec(rest);
    return close ? rest.slice(0, close.index) : rest;
  }

  /**
   * Strip tags and decode entities from an HTML fragment — the worker-safe
   * equivalent of reading `Element.textContent.trim()`.
   * @param {string} html - HTML fragment
   * @returns {string} Plain text
   */
  htmlToText(html) {
    return this.decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  }

  /**
   * Decode the HTML entities DuckDuckGo emits (named + numeric). `&amp;` is
   * decoded last so an encoded entity like `&amp;lt;` survives as `&lt;`.
   * @param {string} s - Text possibly containing entities
   * @returns {string} Decoded text
   */
  decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /**
   * Check if host matches domain pattern (ported from Go)
   * @param {string} host - Hostname to check
   * @param {string} pattern - Domain pattern
   * @returns {boolean} True if matches
   */
  matchesDomain(host, pattern) {
    if (host === pattern) {
      return true;
    }
    return host.endsWith('.' + pattern);
  }

  /**
   * Apply domain filters to results
   * @param {WebSearchResultItem[]} results - Search results
   * @param {string[]} [allowedDomains] - Allowed domains
   * @param {string[]} [blockedDomains] - Blocked domains
   * @returns {WebSearchResultItem[]} Filtered results
   */
  filterResults(results, allowedDomains, blockedDomains) {
    return results.filter(result => {
      try {
        const resultUrl = new URL(result.url);
        const host = resultUrl.hostname.toLowerCase();

        // Check blocked domains
        if (blockedDomains && blockedDomains.length > 0) {
          for (const domain of blockedDomains) {
            if (this.matchesDomain(host, domain.toLowerCase())) {
              return false;
            }
          }
        }

        // Check allowed domains
        if (allowedDomains && allowedDomains.length > 0) {
          let allowed = false;
          for (const domain of allowedDomains) {
            if (this.matchesDomain(host, domain.toLowerCase())) {
              allowed = true;
              break;
            }
          }
          if (!allowed) return false;
        }

        return true;
      } catch {
        // Invalid URL, filter out
        return false;
      }
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

      results = this.parseDuckDuckGoResponse(response.content);
      if (results.length > 0 || this.looksLikeNoResults(response.content)) {
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

    const filtered = this.filterResults(results, allowedDomains, blockedDomains);

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
      return {
        summary: outcome.error || `Search failed for "${query}"`,
        details: '',
        success: false,
        icon: '✗'
      };
    }

    const result = /** @type {WebSearchResult} */ (outcome.result);
    const results = result.results || [];

    if (results.length === 0) {
      return {
        summary: `No results found for "${query}"`,
        details: '',
        success: true,
        icon: '○'
      };
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

    return {
      summary: lines.join('\n'),
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

    const query = String(toolInput?.query || 'unknown');
    const displayQuery = query.length > 40 ? query.substring(0, 40) + '...' : query;

    let summary;
    /** @type {import('juggler/context-item').ResultStatus|undefined} */
    let status;
    if (actionStatus.pending) {
      summary = `Searching for "${displayQuery}"...`;
      status = 'running';
    } else if (actionStatus.success) {
      const result = /** @type {WebSearchResult} */ (actionStatus.result);
      const count = result.count || result.results?.length || 0;
      const provider = result.provider || 'search';
      summary = `Found ${count} result${count === 1 ? '' : 's'} for "${displayQuery}" (${provider})`;
      status = 'success';
    } else {
      ({ summary, status } = this.resolveTerminalStatus(actionStatus));
    }

    return { typeName: 'Web Search', summary, status };
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
