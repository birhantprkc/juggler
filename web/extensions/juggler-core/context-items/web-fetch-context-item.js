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
 * @property {string} [prompt] - What to extract from the page (optional; when set, the call delegates to a sub-agent)
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
    version: '2.0.0',
    description: 'Fetch and process web content',
    author: 'Juggler Team',
    requiresApproval: false,
    // With a `prompt`, buildSubthreadSpec fetches the page here and delegates to
    // a sub-agent with the page text already inlined in its seed — the child
    // answers from that text (never re-fetching) and only its answer returns, so
    // the page never enters the caller's context. Without a `prompt`,
    // buildSubthreadSpec returns null and the ordinary execute() runs, returning
    // the raw content.
    delegatesToSubthread: true
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
          description: 'What to extract from the page. When provided, a sub-agent reads the page and returns just the answer. Omit to return the raw page content.'
        }
      },
      required: ['url']
    };

    const description = 'Fetch a URL and process its content. With `prompt`, a sub-agent reads the page in its own context and returns just the answer (the page never enters this conversation); without it, returns the page content converted to markdown. Includes a 15-minute cache.';

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
    // prompt is optional: with it, the call delegates to a sub-agent
    // (buildSubthreadSpec); without it, execute() returns raw content.
    if (params.prompt !== undefined && params.prompt !== null && typeof params.prompt !== 'string') {
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
   * Fetch the raw page once, here on the engine side. Isolated as its own method
   * so buildSubthreadSpec and onSubthreadError share it and tests can stub the
   * network.
   * @param {string} url - The URL to fetch
   * @returns {Promise<WebFetchResult>} Raw fetch result
   */
  async fetchRaw(url) {
    return /** @type {WebFetchResult} */ (await webFetch({ url }, this.signal));
  }

  /**
   * Delegate to a sub-agent only when there's something to extract. Critically,
   * we fetch the page HERE and inline its full text into the child's seed prompt,
   * so the child answers from content it was handed and never calls WebFetch
   * itself — inlining, not re-fetching, is what stops the recursive delegation
   * cascade. Without a prompt (nothing to extract), or if the fetch fails / has
   * no usable content, return null so the ordinary execute() runs and yields the
   * raw content (or surfaces the fetch error) to the caller.
   * @override
   * @param {Record<string, unknown>} toolInput - Validated tool input
   * @returns {Promise<import('juggler/context-item').SubthreadSpec | null>} Spec or null
   */
  async buildSubthreadSpec(toolInput) {
    const url = String(toolInput.url || '');
    const prompt = toolInput.prompt ? String(toolInput.prompt) : '';
    if (!prompt) return null;

    let page;
    try {
      page = await this.fetchRaw(url);
    } catch {
      // Fetch failed on the engine side: don't delegate — let execute() run and
      // surface the fetch error to the caller the ordinary way.
      return null;
    }

    // A redirect isn't content to reason over, and an empty body means there's
    // nothing to inline — either way, fall back to execute() rather than seeding
    // a child with nothing.
    if (!page || page.redirect || !page.content) return null;

    return {
      goal: `Read ${url}`,
      prompt:
        'You have been given the full text of a web page below. Using ONLY that text, ' +
        'answer the request. Do NOT fetch anything — the page content is already here.\n\n' +
        `# Request\n${prompt}\n\n` +
        `# Page: ${url}\n${page.content}`,
      resultSpec: 'the answer in markdown, quoting the page where relevant, or "not found in page" if the content does not answer the request'
    };
  }

  /**
   * If the sub-agent errored or ended without a result, degrade to returning
   * the raw fetched content rather than failing the call.
   * @override
   * @param {Error} error - Why the child ended open
   * @param {Record<string, unknown>} toolInput - The original validated input
   * @returns {Promise<import('juggler/context-item').SubthreadErrorFallback | null>} Raw-content fallback, or null to accept the default error
   */
  async onSubthreadError(error, toolInput) {
    try {
      const raw = await this.fetchRaw(String(toolInput.url || ''));
      const content = raw && raw.content ? raw.content : '';
      return { result: `(extraction failed: ${error.message}); raw content follows:\n\n${content}` };
    } catch {
      return null;
    }
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
