//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { formatFileSize } from 'juggler/item-utils';
import { smartTruncate, createElement, renderMarkdown, decorateCodeBlocks } from 'juggler/ui';
import { getAvailableSkills, fetchSkillBody } from '../../../js/services/skills.js';

/**
 * Agent Skills — progressive-disclosure instruction sets the model loads on
 * demand.
 *
 * SEMANTICS (this is the whole feature):
 *  - METADATA level: when ≥1 skill is available this item auto-instantiates at
 *    the `system` position and contributes a compact list — one `name:
 *    description` line per skill — to the cached system prefix. That ~100
 *    tokens/skill is always visible, so the model knows what it can reach for.
 *  - INSTRUCTION level: the model activates a skill with the `skill` tool, which
 *    loads that one SKILL.md body into the transcript (a visible tool call — the
 *    user sees exactly what entered context, mirroring memory's visibility).
 *  - RESOURCE level: files under the skill (scripts/, references/) are read and
 *    executed only through the ordinary read/execute tools under normal
 *    approval. This item adds no new execution or file-access path.
 *
 * The list block is byte-stable across turns (the skills service caches the
 * catalog and only a registry reload drops it), so it rides the prompt cache
 * like memory. The `skill` tool is a `meta`, auto-approved, read-only tool, so
 * it works even under the read-only strategy.
 * @class
 * @augments ContextItem
 */
class SkillContextItem extends ContextItem {
  /** @type {import('juggler/context-item').ContextItemManifest} */
  static MANIFEST = {
    id: 'skill',
    name: 'Skills',
    version: '1.0.0',
    description: 'Progressive-disclosure Agent Skills the assistant can load on demand',
    author: 'Juggler Team',
    idPrefix: 'SKILL',
    requiresApproval: false,
    userAddable: false,
    autoInstantiate: true,
    syntheticToolName: 'skill',
    contextPosition: /** @type {const} */ ('system')
  };

  /** Max skills given a description line in the system-prompt block; overflow is listed by name only. */
  static MAX_LISTED = 50;

  /** Max characters of a skill description shown in the system-prompt block. */
  static DESC_MAX = 200;

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'read', icon: 'icon-book' };
  }

  /**
   * The single `skill` tool: load one skill's instructions by name. The name
   * must be one from the Skills list in the system prompt.
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Tool definitions
   */
  static getToolDefinitions() {
    return [
      {
        name: 'skill',
        category: 'meta', // injects instruction text only — no project-source mutation
        description:
          'Load an Agent Skill: a specialized instruction set for a specific kind of task. ' +
          'The available skills (name + when to use each) are listed under "## Skills" in the ' +
          'system prompt. Call this with a skill\'s name BEFORE attempting a task that skill ' +
          'covers, so its instructions are in context first. Loading a skill only adds text; any ' +
          'scripts or reference files it mentions are read/run with the normal tools under your ' +
          'usual approval rules.',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The exact name of the skill to load (from the Skills list in the system prompt).'
            }
          },
          required: ['name']
        }
      }
    ];
  }

  /**
   * Singleton: one skills item per thread. Reuse the existing instance so the
   * per-thread "already loaded" set persists across `skill` calls.
   * @param {Record<string, any>} _newParams - Parameters for the new request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @returns {import('juggler/context-item').MergeOrReplaceResult|null} Merge result or null to create
   */
  static mergeOrReplace(_newParams, existingItems) {
    if (existingItems.length > 0) {
      return { action: 'reuse', item: /** @type {ContextItem} */ (existingItems[0]) }; // bounded: length>0
    }
    return null;
  }

  /**
   * Auto-instantiate only when at least one activatable skill exists, so empty
   * setups gain no item and no system-prompt block (mirrors memory gating on
   * file existence). The `skill` tool itself is always registered from the
   * static definition; this only governs the standing list contribution.
   * @returns {Promise<boolean>} True when ≥1 skill is available
   */
  static async shouldAutoInstantiate() {
    try {
      const skills = await getAvailableSkills();
      return skills.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * No-op: seeding/auto-instantiating the Skills item needs no parameters — the
   * standing "## Skills" list is built by createContextText() from the skills
   * catalog, so the auto-instantiate path just needs the item to exist. The real
   * `skill` tool loads a body through execute(), not this path. Without this
   * override the base onToolCall() throws and the seed is injected as an error
   * context-item message. Mirrors MemoryContextItem.onToolCall.
   * @param {string} _toolName - Tool name (unused)
   * @param {Record<string, any>} _params - Tool parameters (unused)
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, _params) {}

  /** @returns {string} Item title */
  getTitle() {
    return 'Skills';
  }

  /**
   * The activatable skills for this thread. A seam over the skills service so
   * tests can inject a fixture list without a backend.
   * @returns {Promise<import('../../../js/services/skills.js').SkillMeta[]>} Available skills
   * @protected
   */
  async _listSkills() {
    return getAvailableSkills();
  }

  /**
   * Load one skill's SKILL.md body + file listing. A seam over the skills
   * service so tests can inject a fixture body without a backend.
   * @param {'user'|'project'} scope - Provenance scope
   * @param {'juggler'|'agents'} source - Provenance root
   * @param {string} name - Skill name
   * @returns {Promise<import('../../../js/services/skills.js').SkillDetail>} Skill detail
   * @protected
   */
  async _loadBody(scope, source, name) {
    return fetchSkillBody(scope, source, name);
  }

  /**
   * Per-thread set of skill names already loaded, so a repeat `skill` call
   * returns a short notice instead of re-injecting the whole body.
   * @returns {Set<string>} Loaded-name set
   * @private
   */
  _loadedSet() {
    if (!this.__loaded) {
      this.__loaded = new Set();
    }
    return this.__loaded;
  }

  /**
   * Validate tool parameters.
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const name = toolInput.name;
    if (typeof name !== 'string' || name.trim() === '') {
      return { valid: false, error: 'The "name" parameter is required — the exact name of the skill to load.' };
    }
    return { valid: true, params: { name: name.trim() } };
  }

  /**
   * Loading a skill only injects text — never gated behind approval, so it
   * works under the read-only strategy.
   * @override
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {boolean} Always true
   */
  isPermitted(_toolInput) {
    return true;
  }

  /**
   * Activate a skill: resolve its name to the winning (scope, source), load its
   * SKILL.md body, and record it as loaded. A second activation of the same
   * skill in a thread returns an "already loaded" marker rather than re-loading.
   * @param {Record<string, any>} params - Validated params ({name})
   * @returns {Promise<{name: string, scope?: string, source?: string, alreadyLoaded: boolean, body?: string, files?: any[]}>} Result
   */
  async execute(params) {
    const name = String(params.name || '').trim();
    const skill = (await this._listSkills()).find((s) => s.name === name) || null;
    if (!skill) {
      throw new Error(
        `No skill named "${name}" is available. Use an exact name from the "## Skills" list in the system prompt.`
      );
    }
    if (this._loadedSet().has(name)) {
      return { name, scope: skill.scope, source: skill.source, alreadyLoaded: true };
    }
    const detail = await this._loadBody(skill.scope, skill.source, name);
    this._loadedSet().add(name);
    return {
      name,
      scope: skill.scope,
      source: skill.source,
      alreadyLoaded: false,
      body: (detail && detail.body) || '',
      files: (detail && detail.files) || []
    };
  }

  /**
   * Format the outcome for the LLM tool_result. On a fresh load this is the
   * skill's whole instruction body plus a listing of its resource files; on a
   * repeat it is a one-line notice.
   * @override
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      return { summary: outcome.error || 'Failed to load skill', details: '', success: false, icon: '✗' };
    }
    const r = /** @type {{name: string, scope?: string, source?: string, alreadyLoaded?: boolean, body?: string, files?: any[]}} */ (
      outcome.result || {}
    );
    if (r.alreadyLoaded) {
      return {
        summary: `Skill "${r.name}" is already loaded in this conversation — its instructions are already in context.`,
        details: '',
        success: true,
        icon: '✓'
      };
    }
    const budget = /** @type {any} */ (this.conversation)?._truncationBudget || 30000;
    const { content: body } = smartTruncate(r.body || '', { maxChars: budget });
    return { summary: SkillContextItem._formatLoaded({ ...r, body }), details: '', success: true, icon: '✓' };
  }

  /**
   * Collapse a description to a single trimmed line, capped at DESC_MAX. Strips
   * newlines and runs of whitespace so a multi-line or fenced description can't
   * distort the system-prompt block (and can't inject prompt structure).
   * @param {string} text - Raw description
   * @returns {string} One-line, length-bounded description
   * @private
   */
  static _oneLine(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= SkillContextItem.DESC_MAX) {
      return s;
    }
    return s.slice(0, SkillContextItem.DESC_MAX - 1).trimEnd() + '…';
  }

  /**
   * Build the system-prompt "## Skills" block from the available skills. Pure
   * and deterministic (stable name order in, byte-stable text out) so it rides
   * the prompt cache. Empty input contributes nothing. The first MAX_LISTED
   * skills get a `name: description` line; any overflow is listed by name only,
   * so every available skill stays activatable by exact name.
   * @param {Array<{name: string, description?: string}>} skills - Activatable skills, name-sorted
   * @returns {string} The block, or '' when there are no skills
   */
  static _buildBlock(skills) {
    if (!Array.isArray(skills) || skills.length === 0) {
      return '';
    }
    const shown = skills.slice(0, SkillContextItem.MAX_LISTED);
    const lines = shown.map((s) => `- ${s.name}: ${SkillContextItem._oneLine(s.description || '')}`);
    let block =
      '## Skills\n' +
      'Specialized instruction sets you can load with the skill tool when a task matches one. ' +
      'Load a skill BEFORE attempting a task it covers.\n' +
      lines.join('\n');
    const overflow = skills.slice(SkillContextItem.MAX_LISTED);
    if (overflow.length > 0) {
      block += `\n- …and ${overflow.length} more, loadable by exact name: ${overflow.map((s) => s.name).join(', ')}`;
    }
    return block;
  }

  /**
   * Format a freshly-loaded skill as the tool_result text: a header naming the
   * skill and its origin, the instruction body, and a listing of resource files
   * the model can reach with the normal tools.
   * @param {{name: string, scope?: string, source?: string, body?: string, files?: Array<{path: string, size: number}>}} r - Load result
   * @returns {string} tool_result text
   * @private
   */
  static _formatLoaded(r) {
    const origin = r.scope && r.source ? ` (${r.scope}/${r.source})` : '';
    const parts = [`Skill: ${r.name}${origin}`, '', r.body || ''];
    // SKILL.md itself is what we just injected — list only the other resources.
    const files = (r.files || []).filter((f) => f && f.path && f.path !== 'SKILL.md');
    if (files.length > 0) {
      const list = files.map((f) => `- ${f.path} (${formatFileSize(f.size)})`).join('\n');
      parts.push(
        '',
        'Resources bundled with this skill — read a file with the read tool, or run a script with ' +
          'the execute tool (your normal approval rules apply):',
        list
      );
    }
    return parts.join('\n');
  }

  /**
   * Render the live "## Skills" block for the system prompt. Read through the
   * (cached) skills service so the list is byte-stable across turns and updates
   * only on a registry reload.
   * @override
   * @param {object} _contextParams - Runtime execution context (unused)
   * @returns {Promise<string>} Context text, or '' when there are no skills
   */
  async createContextText(_contextParams) {
    const skills = await this._listSkills();
    return SkillContextItem._buildBlock(skills);
  }

  /**
   * Properties panel: the user-facing view of exactly what this item
   * contributes — the standing "## Skills" list injected into the system prompt
   * every turn, one row per available skill, with the ones already loaded into
   * this conversation marked. Without this override the base renderer shows only
   * the item type ("skill"). Reads the catalog live and populates async.
   * @override
   * @returns {HTMLElement} Panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'skill-ci-expanded');
    // Fire-and-forget async populate (sync signature, mirrors memory/file-content).
    this._renderPanel(container);
    return container;
  }

  /**
   * Populate (or refresh) the standing Skills card from the live catalog: a
   * plain-language explanation of how skills work, one styled card per available
   * skill (reusing the settings Skills-page classes), and a "Manage skills"
   * button into the settings Skills tab.
   * @param {HTMLElement} container - Panel container to fill
   * @returns {Promise<void>}
   * @private
   */
  async _renderPanel(container) {
    let skills = /** @type {any[]} */ ([]);
    try {
      skills = await this._listSkills();
    } catch {
      skills = [];
    }
    container.textContent = '';

    container.appendChild(SkillContextItem._explainer());

    const heading = skills.length ? `Available skills (${skills.length})` : 'Available skills';
    container.appendChild(createElement('div', 'skill-panel-heading', heading));

    if (!Array.isArray(skills) || skills.length === 0) {
      container.appendChild(createElement('div', 'skills-empty', 'No skills available yet.'));
    } else {
      const loaded = this._loadedSet();
      const list = createElement('div', 'skills-manage-list');
      for (const skill of skills) {
        list.appendChild(SkillContextItem._skillCard(skill, loaded.has(skill.name)));
      }
      container.appendChild(list);
    }

    const actions = createElement('div', 'skill-panel-actions');
    actions.appendChild(SkillContextItem._manageSkillsButton());
    container.appendChild(actions);
  }

  /**
   * The "how skills work" explainer shown atop the standing Skills card: a lead
   * sentence plus the progressive-disclosure model in plain language, so the
   * user understands what this item contributes and that the assistant may load
   * a skill later in the conversation.
   * @returns {HTMLElement} Explainer block
   * @private
   */
  static _explainer() {
    const note = createElement('div', 'skill-panel-note');
    note.appendChild(
      createElement(
        'p',
        'skill-panel-lead',
        'Agent Skills are specialized instruction sets the assistant can pull in on demand \u2014 extra ' +
          'guidance for a particular kind of task, kept out of the way until it\u2019s needed.'
      )
    );
    const how = createElement('ul', 'skill-panel-how');
    how.appendChild(
      createElement(
        'li',
        '',
        'The skills below are listed (name + description) and injected into the system prompt every ' +
          'turn, so the assistant always knows what it can reach for.'
      )
    );
    how.appendChild(
      createElement(
        'li',
        '',
        'When a task matches one, the assistant loads it with the skill tool \u2014 that adds the ' +
          'skill\u2019s full instructions to the conversation as its own item, later in the chat.'
      )
    );
    how.appendChild(
      createElement(
        'li',
        '',
        'Loading a skill only adds text. Any scripts or files it bundles are read or run later through ' +
          'the normal tools, under your usual approval rules.'
      )
    );
    note.appendChild(how);
    return note;
  }

  /**
   * A "Manage skills" button that opens the Skills page of the settings panel.
   * Shared by the standing card and the per-load panel.
   * @returns {HTMLElement} Button element
   * @private
   */
  static _manageSkillsButton() {
    const btn = /** @type {HTMLButtonElement} */ (createElement('button', 'skills-btn skill-manage-btn', 'Manage skills'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const open = /** @type {any} */ (window).openSettings;
      if (typeof open === 'function') {
        open('skills');
      }
    });
    return btn;
  }

  /**
   * Build one skill card in the settings Skills-page style (name, scope/source
   * and scripts badges, description). Used for both the standing list and the
   * header of a load panel.
   * @param {{name: string, description?: string, scope?: string, source?: string, hasScripts?: boolean}} skill - Skill metadata
   * @param {boolean} [loaded] - Mark the card as already loaded this conversation
   * @returns {HTMLElement} Card element
   * @private
   */
  static _skillCard(skill, loaded = false) {
    const row = createElement('div', 'skills-manage-row skill-panel-card');
    const main = createElement('div', 'skills-manage-main');
    const head = createElement('div', 'skills-card-head');
    head.appendChild(createElement('span', 'skills-card-name', skill.name || '(unnamed)'));
    if (skill.scope && skill.source) {
      head.appendChild(createElement('span', 'skills-scope-badge', `${skill.scope}-${skill.source}`));
    }
    if (skill.hasScripts) {
      const b = createElement('span', 'skills-badge scripts', 'scripts');
      b.title = 'Bundles scripts that can be run through the normal tools';
      head.appendChild(b);
    }
    if (loaded) {
      const b = createElement('span', 'skills-badge loaded', 'loaded');
      b.title = 'Already loaded into this conversation';
      head.appendChild(b);
    }
    main.appendChild(head);
    const desc = SkillContextItem._oneLine(skill.description || '');
    main.appendChild(createElement('div', 'skills-card-desc', desc || 'No description.'));
    row.appendChild(main);
    return row;
  }

  /**
   * A small uppercase section label (reuses the settings Skills-page style).
   * @param {string} text - Label text
   * @returns {HTMLElement} Title element
   * @private
   */
  static _sectionTitle(text) {
    return createElement('div', 'skills-section-title skill-panel-section-title', text);
  }

  /**
   * Properties panel for a `skill` load event. Instead of dumping the raw tool
   * input JSON, pretty-print the loaded skill in the settings Skills-page style:
   * a header card (name, origin, scripts), its bundled files, the SKILL.md
   * instructions rendered as markdown, and a "Manage skills" button. Populated
   * async from the skills service; the generic Result section is suppressed.
   * @override
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {{skipResultSection: boolean}} Suppress the generic result dump
   */
  renderToolActionDetails(wrapper, ctx) {
    const name = String((ctx && ctx.input && ctx.input.name) || '').trim();
    const host = createElement('div', 'skill-load-panel');
    wrapper.appendChild(host);
    // Fire-and-forget async populate (sync signature, mirrors createPropertiesPanelElement).
    this._renderLoadPanel(host, name, ctx);
    return { skipResultSection: true };
  }

  /**
   * Populate a `skill` load panel from the live skills service: header card,
   * bundled-file listing, and the SKILL.md instructions as markdown. Falls back
   * to the raw injected tool_result text if the body can\u2019t be re-fetched, and
   * always ends with a "Manage skills" button.
   * @param {HTMLElement} host - Container to fill
   * @param {string} name - Loaded skill name (from tool input)
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx - Render context
   * @returns {Promise<void>}
   * @private
   */
  async _renderLoadPanel(host, name, ctx) {
    let skill = null;
    try {
      skill = (await this._listSkills()).find((s) => s.name === name) || null;
    } catch {
      skill = null;
    }

    host.textContent = '';
    host.appendChild(SkillContextItem._skillCard(skill || { name: name || '(unknown skill)' }, false));

    // "already loaded" is a one-line notice from getSummary — surface it, and
    // skip the (absent) body in that case.
    const raw = ctx && ctx.toolAction && ctx.toolAction.get ? ctx.toolAction.get('result') : null;
    const result = raw && raw.toJSON ? raw.toJSON() : (raw || {});
    const content = (result && (result.content || result.output)) || '';
    const alreadyLoaded =
      typeof content === 'string' && /already loaded/i.test(content) && content.indexOf('\n') === -1;
    if (alreadyLoaded) {
      host.appendChild(
        createElement(
          'div',
          'skill-load-note',
          'These instructions were already loaded earlier in this conversation, so they weren\u2019t added again.'
        )
      );
    }

    let body = '';
    let files = /** @type {any[]} */ ([]);
    if (skill && !alreadyLoaded) {
      try {
        const detail = await this._loadBody(skill.scope, skill.source, skill.name);
        body = (detail && detail.body) || '';
        files = (detail && detail.files) || [];
      } catch {
        body = '';
        files = [];
      }
    }

    // SKILL.md itself is the body we render below — list only the other resources.
    const resources = (files || []).filter((f) => f && f.path && f.path !== 'SKILL.md');
    if (resources.length > 0) {
      host.appendChild(SkillContextItem._sectionTitle(`Files (${resources.length})`));
      const list = createElement('div', 'skills-files-list');
      for (const f of resources) {
        const fileEl = createElement('div', 'skills-file');
        fileEl.appendChild(createElement('span', 'skills-file-path', f.path));
        fileEl.appendChild(createElement('span', 'skills-file-size', formatFileSize(f.size)));
        list.appendChild(fileEl);
      }
      host.appendChild(list);
    }

    if (body) {
      const { content: capped } = smartTruncate(body, { maxChars: 20000 });
      host.appendChild(SkillContextItem._sectionTitle('Instructions'));
      const md = createElement('div', 'skill-load-body markdown');
      md.innerHTML = renderMarkdown(capped, { escapeXml: true });
      decorateCodeBlocks(md);
      host.appendChild(md);
    } else if (!alreadyLoaded && content) {
      // Couldn't re-fetch the body — show the raw injected text as-is.
      host.appendChild(SkillContextItem._sectionTitle('Instructions'));
      host.appendChild(createElement('pre', 'skill-load-raw', content));
    }

    const actions = createElement('div', 'skill-panel-actions');
    actions.appendChild(SkillContextItem._manageSkillsButton());
    host.appendChild(actions);
  }

  /**
   * Status UI. With no actionStatus this is the standing skills card; with one
   * it is a `skill` load event.
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} [actionStatus] - Execution status
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus) {
    if (!actionStatus) {
      return { typeName: 'Skills', summary: 'Loadable instruction sets — listed for the assistant' };
    }
    if (actionStatus.pending) {
      return { typeName: 'Skill', summary: 'Loading…', status: /** @type {const} */ ('running') };
    }
    if (actionStatus.success) {
      const r = /** @type {{name?: string, alreadyLoaded?: boolean}} */ (actionStatus.result || {});
      const suffix = r.alreadyLoaded ? ' (already loaded)' : '';
      return { typeName: 'Skill', summary: `${r.name || 'skill'}${suffix}`, status: /** @type {const} */ ('success') };
    }
    if (actionStatus.error) {
      return { typeName: 'Skill', summary: actionStatus.error, status: /** @type {const} */ ('error') };
    }
    return { typeName: 'Skill', summary: 'Skill' };
  }
}

export default SkillContextItem;
