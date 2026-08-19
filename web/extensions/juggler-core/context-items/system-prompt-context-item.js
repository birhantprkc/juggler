//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { createElement } from 'juggler/ui';
import { createTextBlock } from 'juggler/item-utils';
import { presentPopup } from 'juggler/ui';
import { systemPromptRegistry, getDefaultIdentityText } from '../../../sdk/lib/system-prompt-registry.js';
import {
  ensureUserPresetsLoaded,
  getDefaultPresetId,
  setDefaultPreset,
  saveUserPreset,
  deleteUserPreset,
  updateUserPreset
} from '../../../js/services/system-prompt-presets.js';

/** @typedef {import('../../../sdk/lib/system-prompt-registry.js').SystemPromptPreset} SystemPromptPreset */

// ============================================================================
// Styles
// ============================================================================

const SYSTEM_PROMPT_STYLES = `
.system-prompt-ci-expanded {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.system-prompt-preset-btn {
  margin-top: 0.5rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  background-color: var(--accent-color, #6366f1);
  color: white;
  border: none;
  border-radius: 0.25rem;
  cursor: pointer;
  transition: background-color 150ms ease;
  align-self: flex-start;
}
.system-prompt-preset-btn:hover {
  background-color: var(--accent-color-hover, #4f46e5);
}
.system-prompt-textarea {
  width: 100%;
  padding: 1rem;
  font-size: 0.8rem;
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 0.25rem;
  color: var(--text-primary);
  resize: vertical;
  min-height: 6rem;
  line-height: 1.5;
}
.system-prompt-textarea:focus {
  outline: none;
  border-color: var(--text-tertiary);
  background: var(--bg-raised);
}
.system-prompt-textarea::placeholder {
  color: var(--text-tertiary);
  opacity: 0.8;
}
.system-prompt-preview-sections {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.system-prompt-section {
  border-radius: 0.75rem;
  overflow: hidden;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}
.system-prompt-section-header {
  display: flex;
  align-items: center;
  padding: 0.375rem 0.625rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
}
.system-prompt-section-body {
  padding: 0.625rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.system-prompt-section-body .ci-text-block {
  opacity: 0.85;
}
/* Tools section: a plain list, because its job is to be scanned for a name that
   should be there and isn't. */
.system-prompt-tools {
  display: flex;
  flex-direction: column;
  /* Rows shrink to their text rather than stretching to the column. A row's
     tooltip is its description, and a full-width row would hang that tooltip
     off to the right of a short name, nowhere near the word it describes. */
  align-items: flex-start;
  gap: 0.1rem;
}
.system-prompt-tools > * {
  max-width: 100%;
}
.system-prompt-tools-count {
  color: var(--text-tertiary);
  margin-bottom: 0.35rem;
}
.system-prompt-tools-group {
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--text-tertiary);
}
.system-prompt-tools-group:first-child {
  margin-top: 0;
}
.system-prompt-tool {
  padding: 0 0 0 0.75rem;
  border: none;
  background: none;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.system-prompt-tool:hover,
.system-prompt-tool:focus-visible {
  color: var(--text-primary);
  text-decoration: underline;
}
.system-prompt-tool-withheld {
  color: var(--text-tertiary);
  text-decoration: line-through;
}
.system-prompt-tool-withheld:hover,
.system-prompt-tool-withheld:focus-visible {
  color: var(--text-secondary);
  text-decoration: line-through underline;
}
.system-prompt-tools-silent {
  margin-top: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--warning, var(--text-tertiary));
}
.system-prompt-tools-drift {
  margin-bottom: 0.35rem;
  color: var(--warning, var(--text-tertiary));
}
/* Preset browser + manage-presets dropdowns -------------------------------
   Self-contained rows (no shared .menu-item dependency) so the layout reads
   like a tidy macOS menu: a leading check/icon column keeps every label on one
   vertical line, the name flexes, and trailing controls sit flush right. */
.system-prompt-preset-dropdown,
.system-prompt-manage-dropdown {
  min-width: 16rem;
  max-width: 22rem;
}
.system-prompt-preset-dropdown menu,
.system-prompt-manage-dropdown menu {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}
.sp-preset-category {
  padding: 0.5rem 0.625rem 0.25rem;
  padding-left: calc(0.625rem + 1.125rem + 0.5rem);
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}
.sp-preset-category:first-child {
  padding-top: 0.125rem;
}
.sp-preset-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.625rem;
  border-radius: var(--radius-popup-item);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 120ms ease;
}
.sp-preset-row:hover {
  background: var(--bg-raised);
}
.sp-preset-row.sp-preset-static {
  cursor: default;
}
.sp-preset-row-icon {
  flex-shrink: 0;
  width: 1.125rem;
  height: 1.125rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-color, #6366f1);
}
.sp-preset-row-icon svg {
  width: 1rem;
  height: 1rem;
  fill: currentColor;
}
.sp-preset-row.sp-preset-action .sp-preset-row-icon {
  color: var(--text-tertiary);
}
.sp-preset-row-name {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-preset-row.is-selected .sp-preset-row-name {
  font-weight: 600;
}
.sp-preset-default-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--accent-color, #6366f1);
  white-space: nowrap;
}
.sp-preset-setdefault-btn,
.sp-preset-delete-btn {
  font-size: 0.6875rem;
  padding: 0.15rem 0.55rem;
  border: 0.0625rem solid var(--border-color);
  border-radius: 999px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 120ms ease, color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.sp-preset-row:hover .sp-preset-setdefault-btn,
.sp-preset-row:focus-within .sp-preset-setdefault-btn,
.sp-preset-row:hover .sp-preset-delete-btn,
.sp-preset-row:focus-within .sp-preset-delete-btn {
  opacity: 1;
}
.sp-preset-setdefault-btn:hover {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
  background: var(--bg-secondary);
}
.sp-preset-delete-btn {
  border-color: transparent;
}
.sp-preset-delete-btn:hover {
  color: var(--danger-color, #ef4444);
  border-color: var(--danger-color, #ef4444);
}
.sp-preset-separator {
  height: 0.0625rem;
  background: var(--border-divider, var(--border-color));
  margin: 0.375rem 0.25rem;
}
.sp-preset-empty {
  padding: 0.4rem 0.625rem;
  padding-left: calc(0.625rem + 1.125rem + 0.5rem);
  color: var(--text-tertiary);
  font-size: 0.8125rem;
  font-style: italic;
}
`;

// Inline icons for the dropdown (Material Symbols paths, currentColor fill).
/**
 * @param {string} path - SVG path data
 * @returns {string} SVG markup
 */
const SP_ICON = (path) => `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${path}"/></svg>`;
const SP_ICON_CHECK = SP_ICON('M382-240 154-468l57-56 171 171 372-372 57 56-429 429Z');
const SP_ICON_PLUS = SP_ICON('M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z');
const SP_ICON_GEAR = SP_ICON('m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z');

if (typeof document !== 'undefined' && !document.getElementById('system-prompt-styles')) {
  const style = document.createElement('style');
  style.id = 'system-prompt-styles';
  style.textContent = SYSTEM_PROMPT_STYLES;
  document.head.appendChild(style);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the auto-appended environment block. Pure: the caller supplies the
 * date so the block is a function of durable conversation state, not the live
 * clock (a conversation resumed across midnight must rebuild identical bytes).
 * @param {string} projectPath - Project working directory
 * @param {string} platform - Platform (darwin/linux/windows)
 * @param {string} today - Date as `YYYY-MM-DD`, pinned to conversation start
 * @returns {string} Environment XML block
 */
function buildEnvBlock(projectPath, platform, today) {
  return `<env>
Working directory: ${projectPath || 'unknown'}
Platform: ${platform || 'unknown'}
Today's date: ${today}
</env>`;
}

// ============================================================================
// SystemPromptContextItem
// ============================================================================

/**
 * SystemPromptContextItem - Editable system prompt with presets
 *
 * Allows users to customize the base identity sent to the LLM.
 * The properties panel shows the editable identity text and a sectioned
 * preview of the full assembled system prompt (identity + env + rules + strategy).
 * @class
 * @augments ContextItem
 */
class SystemPromptContextItem extends ContextItem {
  /**
   * Context item manifest
   * @static
   * @type {import('juggler/context-item').ContextItemManifest}
   */
  static MANIFEST = {
    id: 'system-prompt',
    name: 'System Prompt',
    version: '1.0.0',
    description: 'Base system instructions for the LLM',
    author: 'Juggler Team',
    idPrefix: 'SYSTEM',
    preventUserDeletion: true,
    contextPosition: 'system'
  };

  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'system' };
  }

  /** @returns {import('juggler/context-item').ResultStatusMessage} Status UI config */
  getStatusUI() {
    return { typeName: 'System Prompt', summary: this.getTitle() };
  }

  /**
   * @param {import('juggler/context-item').ItemContext} context - Item context
   */
  constructor(context) {
    super(context);

    // presentPopup release for the open preset-browser dropdown (single teardown).
    /** @type {(() => void)|null} @private */
    this._dropdownRelease = null;

    /** @type {ReturnType<typeof setTimeout>|null} @private */
    this._persistTimer = null;

    // Apply defaults on the instance so buildPrompt/getTitle/UI always have values,
    // even when the Yjs store has empty data (e.g. brand new conversation).
    if (this.data.selectedPresetId === undefined) {
      this.data.selectedPresetId = 'default';
    }
    if (this.data.isModified === undefined) {
      this.data.isModified = false;
    }
  }

  /**
   * Resolve the effective prompt body. The stored text in the doc is the source
   * of truth — selecting a preset copies its body into `data.text`, so the build
   * never needs the preset registry (which would be absent in the engine for
   * user presets). Empty stored text (a fresh placeholder) falls back to the
   * built-in `default` preset content, which is registered everywhere.
   * @returns {string} Prompt body text
   */
  _getEffectiveText() {
    if (this.data.text) return this.data.text;
    return getDefaultIdentityText();
  }

  /**
   * Persist current data to Yjs via the messageThread API.
   * Debounced for textarea input; called immediately for preset selection.
   * @private
   * @param {boolean} [immediate] - Skip debounce
   */
  _persistData(immediate) {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    const doWrite = () => {
      if (this.messageThread) {
        this.messageThread.updateContextItem(this.id, { data: { ...this.data } });
      }
    };

    if (immediate) {
      doWrite();
    } else {
      this._persistTimer = setTimeout(doWrite, 300);
    }
  }

  /**
   * Get item title
   * @returns {string} Item title
   */
  getTitle() {
    if (this.data.selectedPresetId && !this.data.isModified) {
      const preset = systemPromptRegistry.getPreset(this.data.selectedPresetId);
      if (preset && preset.id !== 'default') {
        return `System Prompt (${preset.name})`;
      }
    }
    if (this.data.isModified) {
      return 'System Prompt (Custom)';
    }
    return 'System Prompt';
  }

  /**
   * Create properties panel view
   *
   * Shows an editable textarea for the identity text, a preset selector,
   * and a sectioned read-only preview of the full assembled system prompt.
   * @returns {HTMLElement} Properties panel element
   */
  createPropertiesPanelElement() {
    const container = createElement('div', 'system-prompt-ci-expanded');

    // All sections rendered as panels
    const sections = this._buildPreviewSections(container);
    container.appendChild(sections);

    return container;
  }

  /**
   * In-place update hook the properties panel calls (via its `_liveUpdater`)
   * for same-item changes, instead of rebuilding the panel. Rebuilding would
   * recreate the identity textarea from scratch, discarding a manual drag-resize
   * height plus the user's focus and caret — visible when the first edit flips
   * `isModified` and shifts the title scalar the panel diffs on.
   *
   * The editable textarea already reflects the user's own keystrokes, so while
   * it holds focus we leave it entirely untouched. When the change came from
   * elsewhere (preset apply, undo) and the field is not being edited, we sync its
   * value from the effective text. Returning true tells the panel the update is
   * handled and no rebuild is needed.
   * @param {HTMLElement} content - The context-item body element holding the panel
   * @returns {boolean} True — the update was handled in place
   */
  updatePropertiesPanel(content) {
    const textArea = /** @type {HTMLTextAreaElement|null} */ (
      content.querySelector('.system-prompt-textarea')
    );
    if (textArea && document.activeElement !== textArea) {
      const effective = this._getEffectiveText();
      if (textArea.value !== effective) textArea.value = effective;
    }
    return true;
  }

  /**
   * Build the sectioned preview showing all system prompt layers.
   * The Identity section is editable (preset button + textarea);
   * all other sections are read-only.
   * @private
   * @param {HTMLElement} container - Root properties panel container (for preset dropdown)
   * @returns {HTMLElement} Preview sections container
   */
  _buildPreviewSections(container) {
    const wrapper = createElement('div', 'system-prompt-preview-sections');

    // Section 1: Identity (editable — preset button + textarea)
    this._addIdentitySection(wrapper, container);

    // Section 2: Environment (strip <env> tags for display). Pin the date to
    // the conversation's creation timestamp so the preview matches the bytes
    // that get hashed (a live clock here would diverge from buildPrompt).
    const today = (this.conversation?.created || new Date().toISOString()).split('T')[0] || '';
    const envBlock = buildEnvBlock(this.session?.projectPath || '', this.session?.platform || '', today);
    const envDisplay = envBlock.replace(/^<env>\n?/, '').replace(/\n?<\/env>$/, '');
    this._addPreviewSection(wrapper, 'environment', 'Environment info', envDisplay);

    // Section 3: Rules (from other system-position context items)
    const rulesContent = this._gatherRulesContent();
    if (rulesContent) {
      this._addPreviewSection(wrapper, 'rules', 'Rules', rulesContent);
    }

    // Section 4: Extension guidance — the enabled extensions' aggregated
    // system-prompt contributions (tone, tool-preference, query_code, etc.).
    // Aggregation is async; fill the section once it resolves, or drop it.
    // Strategies contribute no system-prompt text (they inject messages), so
    // there is no strategy section here.
    const extSection = this._addPreviewSection(wrapper, 'extensions', 'Extension guidance', 'Loading…');
    this._fillExtensionGuidance(extSection);

    // Section 5: Tools. The prompt is only half of what the model is handed —
    // the other half is the tool list, and it is the half with no other home in
    // the document. A tool that is missing here was never offered, whatever the
    // model later claims about it.
    const toolsSection = this._addPreviewSection(wrapper, 'tools', 'Tools', 'Loading…');
    this._fillToolInventory(toolsSection);

    return wrapper;
  }

  /**
   * Build the Identity section with preset button and editable textarea.
   * @private
   * @param {HTMLElement} parent - Sections wrapper
   * @param {HTMLElement} container - Root properties panel container (for preset dropdown)
   */
  _addIdentitySection(parent, container) {
    const section = createElement('div', 'system-prompt-section');
    section.dataset.sectionId = 'identity';

    const header = createElement('div', 'system-prompt-section-header');
    header.textContent = 'Identity';
    section.appendChild(header);

    const body = createElement('div', 'system-prompt-section-body');

    // Editable textarea
    const textArea = document.createElement('textarea');
    textArea.className = 'system-prompt-textarea';
    textArea.placeholder = 'Enter system prompt identity text...';
    textArea.rows = 6;
    textArea.value = this._getEffectiveText();
    textArea.setAttribute('autocorrect', 'off');
    textArea.setAttribute('autocapitalize', 'off');
    textArea.spellcheck = false;

    textArea.oninput = (e) => {
      const newText = /** @type {HTMLTextAreaElement} */(e.target).value;
      this.data.text = newText;

      if (this.data.selectedPresetId) {
        this.data.isModified = true;
      }

      this._persistData();
    };

    body.appendChild(textArea);

    // Preset selector button
    const presetBtn = document.createElement('button');
    presetBtn.textContent = 'Select a preset';
    presetBtn.className = 'system-prompt-preset-btn';
    presetBtn.onclick = (e) => { e.stopPropagation(); this._showPresetBrowser(presetBtn, container); };
    body.appendChild(presetBtn);
    section.appendChild(body);
    parent.appendChild(section);
  }

  /**
   * Gather content from other system-position context items (rules etc.)
   * @private
   * @returns {string} Combined rules content
   */
  _gatherRulesContent() {
    const items = this.messageThread?.contextItems || [];
    const parts = [];

    for (const item of items) {
      const ctor = /** @type {{MANIFEST?: {contextPosition?: string}}} */ (item.constructor);
      if (ctor.MANIFEST?.contextPosition === 'system' && item.type !== 'system-prompt') {
        const text = item.data?.text;
        if (text) {
          parts.push(text);
        }
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Add a preview section with a distinct title bar and content area.
   * @private
   * @param {HTMLElement} parent - Parent container
   * @param {string} sectionId - Section identifier for updates
   * @param {string} label - Section header label
   * @param {string} content - Section content (rendered as markdown)
   * @returns {HTMLElement} The created section element
   */
  _addPreviewSection(parent, sectionId, label, content) {
    const section = createElement('div', 'system-prompt-section');
    section.dataset.sectionId = sectionId;

    const header = createElement('div', 'system-prompt-section-header');
    header.textContent = label;
    section.appendChild(header);

    const body = createElement('div', 'system-prompt-section-body');
    const textBlock = createTextBlock(content);
    body.appendChild(textBlock);
    section.appendChild(body);

    parent.appendChild(section);
    return section;
  }

  /**
   * Asynchronously fill the "Extension guidance" preview section with the
   * aggregated enabled-extension contributions. Removes the section entirely if
   * there is no contribution (so the panel doesn't show an empty box).
   * @private
   * @param {HTMLElement} section - The section element to fill or remove
   * @returns {Promise<void>}
   */
  async _fillExtensionGuidance(section) {
    try {
      const { buildExtensionSystemPromptContributions } = await import('../../../js/services/extensions.js');
      const text = await buildExtensionSystemPromptContributions();
      const body = section.querySelector('.system-prompt-section-body');
      if (!body) return;
      if (!text || !text.trim()) {
        section.remove();
        return;
      }
      body.replaceChildren(createTextBlock(text));
    } catch {
      section.remove();
    }
  }

  /**
   * Fill the Tools section with the tools this thread offers the model.
   *
   * The list comes from `buildToolInventory`, the same call the turn path uses
   * to decide what to send, so this cannot show one set while another is sent.
   * Three things are surfaced that nothing else in the UI says out loud: which
   * MCP server each tool came from, which tools the thread's strategy is holding
   * back (a withheld tool looks exactly like a missing one from the outside),
   * and any MCP server that is configured but not currently serving.
   * @private
   * @param {HTMLElement} section - The section element to fill or remove
   * @returns {Promise<void>}
   */
  async _fillToolInventory(section) {
    const body = section.querySelector('.system-prompt-section-body');
    if (!body) return;
    try {
      const { buildToolInventory, groupToolsByOrigin, parseMcpToolName } =
        await import('../../../js/services/thread-tool-inventory.js');
      const inventory = await buildToolInventory(this.messageThread);
      const servers = await this._loadMcpServerStatus();
      const drift = await this._toolDriftSinceLastTurn(inventory.offered);

      body.replaceChildren();
      body.appendChild(this._buildToolInventoryView(
        inventory, groupToolsByOrigin(inventory.offered), servers, parseMcpToolName, drift
      ));
    } catch (err) {
      // Never leave "Loading…" sitting there: a panel that can't answer should
      // say so, since silence here reads as "no tools".
      body.replaceChildren(createTextBlock(
        `Couldn't read the tool list.\n\n${err instanceof Error ? err.message : String(err)}`
      ));
    }
  }

  /**
   * MCP server status, keyed by name. Best-effort: a server list we can't fetch
   * simply means no status annotations, not a broken section.
   * @private
   * @returns {Promise<Map<string, {status?: string, error?: string, toolCount?: number}>>} Status by server name
   */
  async _loadMcpServerStatus() {
    /** @type {Map<string, {status?: string, error?: string, toolCount?: number}>} */
    const byName = new Map();
    try {
      const { mcpListServers } = await import('juggler/ops');
      const res = await mcpListServers();
      for (const s of (res?.servers || [])) byName.set(String(s.name), s);
    } catch {
      // No MCP ops available (or none configured) — leave the map empty.
    }
    return byName;
  }

  /**
   * How this thread's live tool list differs from the one the last turn actually
   * sent.
   *
   * This panel renders in the viewer while turns are built in the engine worker,
   * and each holds its own MCP snapshot — so the list shown here is a
   * reconstruction, and a reconstruction that can silently disagree with what
   * was sent is worse than no panel at all. Comparing against the recorded blob
   * turns that risk into a visible statement. A difference is usually not a bug:
   * a server that finished connecting after the last turn genuinely does have
   * tools the model has not been offered yet, which is exactly the state that
   * makes a model insist a tool doesn't exist.
   * @private
   * @param {Array<any>} offered - Tools currently on offer for this thread
   * @returns {Promise<{added: string[], removed: string[]}|null>} The difference, or null when there is nothing to compare against
   */
  async _toolDriftSinceLastTurn(offered) {
    try {
      const { findLastAssistantTxnId } = await import('../../../js/utils/transaction-anchor.js');
      const txnId = findLastAssistantTxnId(this.messageThread?.items);
      const convId = this.messageThread?.conversation?.id;
      if (!txnId || !convId) return null;

      const { default: workerManager } = await import('../../../js/services/worker-manager.js');
      const blob = /** @type {any} */ (await workerManager.getTransaction(convId, txnId));
      const sent = blob?.input?.tools;
      if (!Array.isArray(sent)) return null;

      const sentNames = new Set(sent.map((/** @type {any} */ t) => String(t?.name || '')));
      const liveNames = new Set(offered.map((t) => String(t?.name || '')));
      return {
        added: [...liveNames].filter((n) => !sentNames.has(n)),
        removed: [...sentNames].filter((n) => !liveNames.has(n))
      };
    } catch {
      // No blob, no worker, no comparison — the list still stands on its own.
      return null;
    }
  }

  /**
   * Render the inventory: a count line, one group per origin, then the withheld
   * group and any silent MCP servers.
   * @private
   * @param {{offered: Array<any>, withheld: Array<any>, strategyName: string}} inventory - What is offered and what isn't
   * @param {Array<{title: string, server: string|null, tools: Array<any>, tokens: number}>} groups - Offered tools, grouped
   * @param {Map<string, {status?: string, error?: string, toolCount?: number}>} servers - MCP status by server name
   * @param {(name: string) => {server: string, tool: string}|null} parseMcp - MCP name splitter
   * @param {{added: string[], removed: string[]}|null} drift - Difference from the last turn's recorded tool list
   * @returns {HTMLElement} The section body content
   */
  _buildToolInventoryView(inventory, groups, servers, parseMcp, drift) {
    const wrap = createElement('div', 'system-prompt-tools');

    const count = createElement('div', 'system-prompt-tools-count');
    count.textContent = inventory.offered.length === 1
      ? '1 tool available to the model'
      : `${inventory.offered.length} tools available to the model`;
    wrap.appendChild(count);

    const changes = [];
    if (drift?.added.length) changes.push(`${drift.added.length} added`);
    if (drift?.removed.length) changes.push(`${drift.removed.length} gone`);
    if (changes.length) {
      const line = createElement('div', 'system-prompt-tools-drift');
      line.textContent = `${changes.join(', ')} since the last turn — the model has not been offered this list yet.`;
      line.title = [
        drift?.added.length ? `Added: ${drift.added.join(', ')}` : '',
        drift?.removed.length ? `Gone: ${drift.removed.join(', ')}` : ''
      ].filter(Boolean).join('\n');
      wrap.appendChild(line);
    }

    for (const group of groups) {
      const heading = createElement('div', 'system-prompt-tools-group');
      heading.textContent = group.title;
      if (group.server) {
        const status = servers.get(group.server)?.status;
        if (status && status !== 'running') heading.textContent += ` — ${status}`;
      }
      wrap.appendChild(heading);

      for (const tool of group.tools) {
        const parts = group.server ? parseMcp(String(tool?.name || '')) : null;
        wrap.appendChild(this._buildToolRow(
          String(tool?.name || ''),
          parts ? parts.tool : String(tool?.name || ''),
          String(tool?.description || ''),
          group.server
        ));
      }
    }

    // Configured MCP servers that contributed nothing. Without this the section
    // is simply missing a group, which looks identical to never having set the
    // server up at all.
    for (const [name, status] of servers) {
      if (groups.some((g) => g.server === name)) continue;
      const row = createElement('div', 'system-prompt-tools-silent');
      const detail = status?.error ? String(status.error).split('\n')[0] : '';
      row.textContent = `MCP · ${name} — ${status?.status || 'not running'}${detail ? `: ${detail}` : ''}`;
      wrap.appendChild(row);
    }

    if (inventory.withheld.length) {
      const heading = createElement('div', 'system-prompt-tools-group');
      heading.textContent = inventory.strategyName
        ? `Withheld by ${inventory.strategyName}`
        : 'Withheld';
      wrap.appendChild(heading);
      for (const tool of inventory.withheld) {
        const name = String(tool?.name || '');
        const row = this._buildToolRow(name, name, String(tool?.description || ''), parseMcp(name)?.server ?? null);
        row.classList.add('system-prompt-tool-withheld');
        wrap.appendChild(row);
      }
    }

    return wrap;
  }

  /**
   * One tool row, which doubles as a link to wherever that tool is configured:
   * an MCP tool leads to its server's settings (where its per-tool checkbox
   * lives), anything else to the extension that defines it. Reading a tool's
   * name is usually the moment you want to go and do something about it.
   * @private
   * @param {string} toolName - The LLM-facing tool name
   * @param {string} label - What to show (MCP tools drop the server prefix their heading already carries)
   * @param {string} description - Tooltip text
   * @param {string|null} server - Owning MCP server, or null for a built-in
   * @returns {HTMLElement} The row element
   */
  _buildToolRow(toolName, label, description, server) {
    const row = createElement('button', 'system-prompt-tool');
    /** @type {HTMLButtonElement} */ (row).type = 'button';
    row.textContent = label;
    row.title = description
      ? `${description}\n\n${server ? `Configure "${server}"` : 'Show where this tool is defined'}`
      : (server ? `Configure "${server}"` : 'Show where this tool is defined');
    row.addEventListener('click', () => { void this._openToolDefinition(toolName, server); });
    return row;
  }

  /**
   * Send the user to where a tool is configured.
   *
   * MCP tools all share one context-item id, so the extensions catalog would
   * land every one of them on the MCP bridge itself — true, and no help at all
   * when the question is "why isn't my server's tool here". Those go to the
   * server's own settings instead; everything else goes to the extension that
   * defines it, reusing the catalog deep-link the item badges already use.
   * @private
   * @param {string} toolName - The LLM-facing tool name
   * @param {string|null} server - Owning MCP server, or null for a built-in
   * @returns {Promise<void>}
   */
  async _openToolDefinition(toolName, server) {
    const openSettings = /** @type {any} */ (globalThis).openSettings;
    if (typeof openSettings !== 'function') return;

    if (server) {
      openSettings('mcp', { mcpServer: server });
      return;
    }

    try {
      const { default: contextItemRegistry } =
        await import('../../../js/registries/context-item-registry.js');
      const ItemClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolName));
      const id = ItemClass?.MANIFEST?.id;
      if (id) {
        openSettings('extensions', { capability: { itemType: 'context-item', id } });
        return;
      }
    } catch {
      // Fall through: the Extensions tab on its own is still a useful landing.
    }
    openSettings('extensions');
  }

  /**
   * Close the open preset dropdown, if any.
   * @private
   */
  _closeDropdown() {
    if (this._dropdownRelease) {
      this._dropdownRelease();
      this._dropdownRelease = null;
    }
  }

  /**
   * Show the preset browser dropdown: built-in and user presets grouped by
   * category, each with a default indicator / "Set as default" action, plus
   * footer actions to save the current prompt as a preset and to manage user
   * presets.
   * @private
   * @param {HTMLElement} buttonElement - Trigger button
   * @param {HTMLElement} container - Properties panel container
   */
  async _showPresetBrowser(buttonElement, container) {
    // Toggle: a second click closes the open dropdown.
    if (this._dropdownRelease) {
      this._closeDropdown();
      return;
    }

    // Pull in the user's saved presets + default id before rendering.
    await ensureUserPresetsLoaded();

    const dropdown = document.createElement('nav');
    dropdown.className = 'dropdown-menu system-prompt-preset-dropdown show';
    this._renderPresetMenu(dropdown, container);

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape), the reposition observer, and the
    // anchored-vs-sheet decision.
    this._dropdownRelease = presentPopup({
      surface: dropdown,
      anchor: buttonElement,
      id: 'system-prompt-preset-dropdown',
      onClose: () => this._closeDropdown(),
      insideSelectors: ['.system-prompt-preset-dropdown', '.system-prompt-preset-btn'],
    });
  }

  /**
   * Render (or re-render in place) the preset dropdown's menu contents. Called
   * on open and after a default change so the indicator updates without closing.
   * @private
   * @param {HTMLElement} dropdown - The dropdown surface element
   * @param {HTMLElement} container - Properties panel container
   */
  _renderPresetMenu(dropdown, container) {
    const menu = document.createElement('menu');
    const defaultId = getDefaultPresetId();
    const selectedId = this.data.selectedPresetId;

    for (const category of systemPromptRegistry.getCategories()) {
      const presets = systemPromptRegistry.getPresetsByCategory(category);
      if (presets.length === 0) continue;

      menu.appendChild(this._buildCategoryHeader(category));

      for (const preset of presets) {
        menu.appendChild(this._buildPresetMenuItem(preset, defaultId, selectedId, dropdown, container));
      }
    }

    // Footer actions.
    menu.appendChild(createElement('li', 'sp-preset-separator'));

    menu.appendChild(this._buildActionItem(SP_ICON_PLUS, 'Save current text as preset…', () => {
      this._saveCurrentAsPreset(dropdown, container);
    }));
    menu.appendChild(this._buildActionItem(SP_ICON_GEAR, 'Manage presets…', () => {
      this._closeDropdown();
      this._showManagePresets(container);
    }));

    dropdown.replaceChildren(menu);
  }

  /**
   * Build an uppercase section label row (capitalized; CSS upper-cases it).
   * @private
   * @param {string} label - Category label
   * @returns {HTMLElement} The header row
   */
  _buildCategoryHeader(label) {
    return createElement('li', 'sp-preset-category', label.charAt(0).toUpperCase() + label.slice(1));
  }

  /**
   * Build one preset row: a leading check column marks the preset currently
   * applied to this conversation; the name flexes; the trailing slot shows a
   * "default" badge (for the new-conversation default) or a hover-revealed
   * "Set default" button.
   * @private
   * @param {import('./system-prompt-context-item.js').SystemPromptPreset} preset
   * @param {string} defaultId - The current default preset id
   * @param {string} selectedId - The preset applied to this conversation
   * @param {HTMLElement} dropdown - The dropdown surface (for in-place refresh)
   * @param {HTMLElement} container - Properties panel container
   * @returns {HTMLElement} The menu row
   */
  _buildPresetMenuItem(preset, defaultId, selectedId, dropdown, container) {
    const isSelected = preset.id === selectedId;
    const item = createElement('li', 'sp-preset-row' + (isSelected ? ' is-selected' : ''));

    const icon = createElement('span', 'sp-preset-row-icon');
    if (isSelected) icon.innerHTML = SP_ICON_CHECK;
    item.appendChild(icon);

    item.appendChild(createElement('span', 'sp-preset-row-name', preset.name));

    if (preset.id === defaultId) {
      item.appendChild(createElement('span', 'sp-preset-default-badge', 'default'));
    } else {
      const setBtn = document.createElement('button');
      setBtn.className = 'sp-preset-setdefault-btn';
      setBtn.textContent = 'Set default';
      setBtn.title = `Make "${preset.name}" the default for new conversations`;
      setBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await setDefaultPreset(preset.id);
          this._renderPresetMenu(dropdown, container);
        } catch (err) {
          console.error('[SystemPrompt] set default failed:', err);
        }
      });
      item.appendChild(setBtn);
    }

    item.addEventListener('click', () => this._applyPreset(preset, container));
    return item;
  }

  /**
   * Build a footer action row: leading icon (aligned to the preset rows' check
   * column) + label.
   * @private
   * @param {string} iconSvg - Inline SVG markup for the leading icon
   * @param {string} label - Row label
   * @param {() => void} onClick - Click handler
   * @returns {HTMLElement} The menu row
   */
  _buildActionItem(iconSvg, label, onClick) {
    const item = createElement('li', 'sp-preset-row sp-preset-action');

    const icon = createElement('span', 'sp-preset-row-icon');
    icon.innerHTML = iconSvg;
    item.appendChild(icon);

    item.appendChild(createElement('span', 'sp-preset-row-name', label));

    item.addEventListener('click', onClick);
    return item;
  }

  /**
   * Apply a preset: copy its full body into the doc as the prompt text (so the
   * build is independent of the registry), record the source id, and close.
   * @private
   * @param {import('./system-prompt-context-item.js').SystemPromptPreset} preset
   * @param {HTMLElement} container - Properties panel container
   */
  _applyPreset(preset, container) {
    this.data.text = preset.content;
    this.data.selectedPresetId = preset.id;
    this.data.isModified = false;
    this._persistData(true);

    const textArea = container.querySelector('.system-prompt-textarea');
    if (textArea) {
      /** @type {HTMLTextAreaElement} */(textArea).value = this._getEffectiveText();
    }
    this._closeDropdown();
  }

  /**
   * Prompt for a name and save the current prompt body as a new user preset,
   * then select it.
   * @private
   * @param {HTMLElement} dropdown - The dropdown surface
   * @param {HTMLElement} container - Properties panel container
   * @returns {Promise<void>}
   */
  async _saveCurrentAsPreset(dropdown, container) {
    const content = this._getEffectiveText();
    if (!content.trim()) return;

    // When the editor is already on a user preset, offer to update it in place
    // instead of always creating a new one.
    const currentId = this.data.selectedPresetId;
    if (currentId && currentId.startsWith('user-')) {
      const existing = systemPromptRegistry.getPreset(currentId);
      if (existing) {
        const showChoice = /** @type {any} */ (window).showChoice;
        if (showChoice) {
          const choice = await showChoice(
            `"${existing.name}" is already a preset.`,
            ['Update', 'Save as new\u2026', 'Cancel'],
            'Save preset',
            false
          );
          if (choice === 'Update') {
            try {
              await updateUserPreset(existing.id, existing.name, content);
              this.data.selectedPresetId = existing.id;
              this.data.isModified = false;
              this._persistData(true);
              this._renderPresetMenu(dropdown, container);
            } catch (err) {
              console.error('[SystemPrompt] update preset failed:', err);
              const showConfirm = /** @type {any} */ (window).showConfirm;
              const msg = err instanceof Error ? err.message : String(err);
              if (showConfirm) await showConfirm(msg, 'Could not update preset', { confirmText: 'OK' });
            }
            return;
          }
          if (choice === 'Cancel' || choice === null) return;
          // 'Save as new…' falls through to the name-prompt path below.
        }
      }
    }

    const showPrompt = /** @type {any} */ (window).showPrompt;
    const name = showPrompt
      ? await showPrompt('Name this preset:', '', 'Save system prompt preset')
      : null;
    if (!name || !name.trim()) return;
    try {
      const preset = await saveUserPreset(name.trim(), content);
      this.data.selectedPresetId = preset.id;
      this.data.isModified = false;
      this._persistData(true);
      this._renderPresetMenu(dropdown, container);
    } catch (err) {
      console.error('[SystemPrompt] save preset failed:', err);
      const showConfirm = /** @type {any} */ (window).showConfirm;
      const msg = err instanceof Error ? err.message : String(err);
      if (showConfirm) await showConfirm(msg, 'Could not save preset', { confirmText: 'OK' });
    }
  }

  /**
   * Show the manage-presets popup: lists user presets with delete (built-ins
   * are not user-deletable, so they are not listed here).
   * @private
   * @param {HTMLElement} container - Properties panel container
   */
  _showManagePresets(container) {
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu system-prompt-manage-dropdown show';

    const render = () => {
      const menu = document.createElement('menu');
      menu.appendChild(this._buildCategoryHeader('Your presets'));

      const userPresets = systemPromptRegistry.getPresetsByCategory('user');
      if (userPresets.length === 0) {
        menu.appendChild(createElement('li', 'sp-preset-empty', 'No saved presets yet.'));
      }

      for (const preset of userPresets) {
        const item = createElement('li', 'sp-preset-row sp-preset-static');

        // Empty leading slot keeps names aligned with the preset-browser rows.
        item.appendChild(createElement('span', 'sp-preset-row-icon'));
        item.appendChild(createElement('span', 'sp-preset-row-name', preset.name));

        const editBtn = document.createElement('button');
        editBtn.className = 'sp-preset-edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Load the preset content into the editor so the user can tweak it,
          // then close this dialog.
          this.data.text = preset.content;
          this.data.selectedPresetId = preset.id;
          this.data.isModified = false;
          this._persistData(true);
          const textArea = container.querySelector('.system-prompt-textarea');
          if (textArea) {
            /** @type {HTMLTextAreaElement} */(textArea).value = this._getEffectiveText();
          }
          this._closeDropdown();
        });
        item.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'sp-preset-delete-btn';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const showConfirm = /** @type {any} */ (window).showConfirm;
          const ok = showConfirm
            ? await showConfirm(`Delete preset "${preset.name}"? This cannot be undone.`, 'Delete preset', { confirmText: 'Delete', cancelText: 'Cancel', danger: true })
            : true;
          if (!ok) return;
          try {
            await deleteUserPreset(preset.id);
            render();
          } catch (err) {
            console.error('[SystemPrompt] delete preset failed:', err);
          }
        });
        item.appendChild(delBtn);
        menu.appendChild(item);
      }

      surface.replaceChildren(menu);
    };

    render();

    this._closeDropdown();
    const presetBtn = /** @type {HTMLElement|null} */ (container.querySelector('.system-prompt-preset-btn'));
    this._dropdownRelease = presentPopup({
      surface,
      anchor: presetBtn || container,
      id: 'system-prompt-manage-dropdown',
      onClose: () => this._closeDropdown(),
      insideSelectors: ['.system-prompt-manage-dropdown', '.system-prompt-preset-btn'],
    });
  }

  /**
   * Create context text for LLM
   *
   * System prompt context item should not be included as a context item.
   * The system prompt is built separately by the context builder.
   * @param {object} _contextParams - Runtime execution context (unused)
   * @param {number} [_contextParams.budgetHint] - Optional token budget hint for truncation
   * @param {import('juggler/context-item').ModelConfig|null} [_contextParams.modelConfig] - Model configuration
   * @param {import('../../../sdk/lib/formatting-helpers.js').FormattingHelpers} _contextParams.helpers - Formatting utilities
   * @returns {string} Empty string (not included as context item)
   */
  createContextText(_contextParams) {
    return '';
  }

  /**
   * Build the identity and environment block of the system prompt.
   *
   * Called by context builder as the base of the system prompt.
   * Behavioral guidance is appended by context-builder from the active strategy.
   * Tool definitions are provided via native function calling API.
   * @returns {string} Identity and environment block
   */
  buildPrompt() {
    const identityText = this._getEffectiveText();
    const today = (this.conversation?.created || new Date().toISOString()).split('T')[0] || '';
    const projectPath = this.session?.projectPath || '';
    if (!projectPath) {
      // Field diagnostic: an empty working directory makes the env block read
      // "Working directory: unknown", which invites the model to invent an
      // absolute path. The session should be loaded (projectPath set) before
      // any prompt is built; log if that invariant is ever violated.
      console.warn('[SystemPrompt] building env block with empty projectPath — "Working directory: unknown"');
    }
    const envBlock = buildEnvBlock(projectPath, this.session?.platform || '', today);
    return identityText + '\n\n' + envBlock;
  }
}

export default SystemPromptContextItem;
