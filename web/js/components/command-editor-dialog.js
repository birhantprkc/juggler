//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Command editor dialog — the editing surface for user-defined slash commands.
 *
 * Opened from the slash menu's "New command…" row, the `/commands` manager, or
 * a "Save as slash command" action. It writes a `.juggler/commands/*.md` file
 * via the backend (the same validation path `define_command` uses) and triggers
 * a registry hot-reload so the command appears in the menu immediately.
 * @module components/command-editor-dialog
 */

import { writeUserCommand, deleteUserCommand, fetchUserCommands, resetUserCommandsCache, USER_COMMAND_NAME_RE } from '../services/user-commands.js';
import { expandTemplate, resolveModelConfig } from '../plugins/user-command-factory.js';
import { reloadRegistries, REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import strategyRegistry from '../registries/strategy-registry.js';
import providersCache from '../services/providers-cache.js';
import { buildModelConfig } from '../model/model-config.js';
import { presentModal } from '../utils/modal-surface.js';
import { presentPopup } from '../utils/popup-surface.js';
import { closePopupById } from '../utils/popup-manager.js';
import { focusWhenShown } from '../utils/focus.js';
import { showConfirm } from './modal-dialog.js';
import './model-picker/model-chip.js';
import './model-picker/model-picker.js';

/**
 * Popup id for the editor's model picker, so a second press on the chip
 * dismisses the picker instead of stacking a second one over it.
 */
const MODEL_PICKER_POPUP_ID = 'command-editor-model-picker';

/**
 * Run modes, in the order the segmented control offers them.
 * @type {Record<string, string>}
 */
const RUN_MODES = {
  send: 'Send immediately',
  draft: 'Insert as draft',
  subthread: 'Run in a thread',
};

/**
 * What each run mode actually does, shown under the control for the selected
 * one. The three labels alone say what happens to the command, not what happens
 * to the conversation, which is the part worth knowing before choosing.
 * @type {Record<string, string>}
 */
const RUN_MODE_HINTS = {
  send: 'Expands the template and sends it as your next message.',
  draft: 'Puts the expanded template in the composer so you can edit it first.',
  subthread: 'Runs the prompt in a separate thread; the result lands back here.',
};

/** Save destinations, in the order the segmented control offers them. */
const SCOPES = {
  project: 'This project',
  user: 'All my projects',
};

/**
 * Set of built-in / extension command ids a user command may not shadow. User
 * commands are registered in the same registry, so they are filtered out —
 * a user command may collide with (overwrite) another user command, but never
 * a built-in.
 * @returns {Set<string>} Reserved command ids
 */
function builtinCommandIds() {
  const ids = new Set();
  for (const cmd of slashCommandHandler.getCommands()) {
    if (!cmd.userDefined) ids.add(cmd.name);
  }
  return ids;
}

/**
 * Apply a command write/delete to the live registries after the file is already
 * on disk. Resets the user-commands cache synchronously (so the very next
 * {@link fetchUserCommands} re-reads the change) and kicks the registry rebuild
 * off WITHOUT awaiting it.
 *
 * `reloadRegistries()` defers its rebuild to local quiescence — it never
 * resolves while a conversation is mid-turn, and can reject if a plugin's
 * init() throws. Awaiting it would leave the dialog stuck open and the manager
 * re-reading a stale cache, so the just-saved edit appears lost. The rebuild
 * still applies live once quiescent; the UI just doesn't block on it. Mirrors
 * skills-tab's `_afterMutation`.
 */
function refreshRegistries() {
  resetUserCommandsCache();
  reloadRegistries().catch((err) => {
    console.warn('[Commands] registry reload after mutation failed:', err);
  });
}

/**
 * @typedef {object} CommandEditorOptions
 * @property {string} [name] - Initial command name (pre-fills the name field)
 * @property {'user'|'project'} [scope] - Initial scope
 * @property {import('../services/user-commands.js').UserCommandDef|null} [def] - Existing definition when editing
 */

/**
 * Open the command editor dialog. Resolves when the dialog closes: with the
 * saved command name on save, `{deleted: name}` on delete, or null on cancel.
 * @param {CommandEditorOptions} [options]
 * @returns {Promise<string|{deleted: string}|null>} The saved name, `{deleted}`, or null on cancel
 */
export function openCommandEditor(options = {}) {
  const def = options.def || null;
  const editing = !!def;
  const fm = def?.frontmatter || {};

  return new Promise((resolve) => {
    const modal = presentModal({
      className: 'command-editor-overlay',
      dismissSelectors: ['.command-editor-backdrop', '#cmd-close'],
      onClose: (result) => {
        // The picker lives on document.body, so it outlives the dialog unless
        // it is taken down with it.
        closePopupById(MODEL_PICKER_POPUP_ID);
        resolve(result ?? null);
      },
    });
    const overlay = modal.root;
    const close = modal.close;

    // The three choices the dialog holds outside the DOM: the two segmented
    // controls and the model override, none of which is a form field. A file may
    // name a run mode this build does not offer, which falls back to send rather
    // than leaving the control with nothing selected.
    let run = RUN_MODES[fm.run || ''] ? /** @type {string} */ (fm.run) : 'send';
    let scope = def?.scope === 'user' || options.scope === 'user' ? 'user' : 'project';
    let modelConfig = seedModelConfig(fm);
    // Whether the user has touched the model, so a late provider list refines
    // the seed without overwriting a choice they have already made.
    let modelTouched = false;

    overlay.innerHTML = buildMarkup({
      editing,
      name: def?.name ?? options.name ?? '',
      scope,
      description: fm.description ?? '',
      argsHint: fm.argsHint ?? '',
      run,
      icon: fm.icon ?? '',
      goal: fm.goal ?? '',
      template: def?.body ?? '',
    });

    const $ = (/** @type {string} */ sel) => /** @type {any} */ (overlay.querySelector(sel));

    // Populate the strategy picker from the live registry.
    const strategySelect = $('#cmd-strategy');
    if (strategySelect) {
      for (const { id, manifest } of strategyManifests()) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = manifest?.name || id;
        if (id === fm.strategy) opt.selected = true;
        strategySelect.appendChild(opt);
      }
    }

    const nameInput = $('#cmd-name');
    const nameError = $('#cmd-name-error');
    const templateInput = $('#cmd-template');
    const previewArgs = $('#cmd-preview-args');
    const previewOut = $('#cmd-preview-out');
    const runHint = $('#cmd-run-hint');
    const subthreadFields = $('#cmd-subthread-fields');
    const modelChip = $('#cmd-model');
    const saveBtn = $('#cmd-save');
    const pathHint = $('#cmd-path-hint');

    const reserved = builtinCommandIds();

    // ── model override: the app's standard chip + picker ──────────────────────

    const syncChip = () => {
      modelChip.update({
        providers: providersCache.get(),
        config: modelConfig,
        placeholder: 'Inherit from parent',
        buttonTitle: 'Model for the thread',
      });
    };

    const setModelConfig = (/** @type {any} */ next) => {
      modelConfig = next;
      modelTouched = true;
      syncChip();
    };

    const openModelPicker = () => {
      // Second press on the chip dismisses rather than re-opening.
      if (closePopupById(MODEL_PICKER_POPUP_ID)) return;

      const picker = /** @type {any} */ (document.createElement('model-picker'));
      picker.providers = providersCache.get();
      picker.value = modelConfig;
      picker.noneLabel = 'Inherit from parent';
      picker.loading = !providersCache.hasReceived();

      /** @type {(() => void)|null} */
      let release = null;
      const closePicker = () => {
        if (release) {
          release();
          release = null;
        }
      };

      picker.addEventListener('change', (/** @type {Event} */ e) => {
        closePicker();
        setModelConfig(/** @type {CustomEvent} */ (e).detail);
      });
      picker.addEventListener('close', closePicker);

      release = presentPopup({
        surface: picker,
        anchor: modelChip.button || modelChip,
        id: MODEL_PICKER_POPUP_ID,
        onClose: closePicker,
        insideSelectors: ['model-chip', '.model-picker'],
      });
    };

    modelChip.addEventListener('chip-toggle', openModelPicker);
    // The pill promises its mini popover, so an open picker gets out of the way
    // first — same contract as the settings rows.
    modelChip.addEventListener('mini-requested', () => closePopupById(MODEL_PICKER_POPUP_ID));
    modelChip.addEventListener('change', (/** @type {Event} */ e) => {
      setModelConfig(/** @type {CustomEvent} */ (e).detail);
    });
    syncChip();

    // A dialog opened before the first provider push shows the stored reference
    // verbatim; once the list lands the label resolves, and a reference whose
    // provider had to be inferred is re-seeded — unless the user has since
    // chosen something, which their choice must survive.
    if (!providersCache.hasReceived()) {
      providersCache.waitForFirst().then(() => {
        if (!overlay.isConnected) return;
        if (!modelTouched && modelConfig && !modelConfig.provider) modelConfig = seedModelConfig(fm);
        syncChip();
      });
    }

    const validateName = () => {
      const v = nameInput.value.trim();
      let msg = '';
      if (!v) msg = '';
      else if (!USER_COMMAND_NAME_RE.test(v)) msg = 'Lowercase letters, digits, and hyphens; must start with a letter.';
      else if (reserved.has(v)) msg = `"/${v}" already exists as a built-in command.`;
      nameError.textContent = msg;
      const ok = !!v && !msg;
      saveBtn.disabled = !ok;
      return ok;
    };

    const updatePreview = () => {
      const args = previewArgs.value.trim() ? previewArgs.value.trim().split(/\s+/) : [];
      previewOut.textContent = expandTemplate(templateInput.value, args);
    };

    const updateRunUI = () => {
      subthreadFields.classList.toggle('hidden', run !== 'subthread');
      runHint.textContent = RUN_MODE_HINTS[run] || '';
    };

    const updatePathHint = () => {
      const dir = scope === 'user' ? '~/.juggler/commands' : '<project>/.juggler/commands';
      const nm = nameInput.value.trim() || 'name';
      pathHint.textContent = `${dir}/${nm}.md`;
    };

    nameInput.addEventListener('input', () => { validateName(); updatePathHint(); });
    templateInput.addEventListener('input', updatePreview);
    previewArgs.addEventListener('input', updatePreview);
    wireSegmented($('#cmd-run'), 'run', (value) => { run = value; updateRunUI(); });
    wireSegmented($('#cmd-scope'), 'scope', (value) => { scope = value; updatePathHint(); });

    if (editing) {
      const del = $('#cmd-delete');
      del.classList.remove('hidden');
      del.addEventListener('click', async () => {
        const ok = await showConfirm(
          `Delete the /${def?.name} command?`, 'Delete command', { danger: true, confirmText: 'Delete' });
        if (!ok) return;
        await deleteUserCommand(/** @type {any} */ (def?.scope), /** @type {any} */ (def?.name));
        refreshRegistries();
        close({ deleted: /** @type {string} */ (def?.name) });
      });
    }

    saveBtn.addEventListener('click', async () => {
      if (!validateName()) return;
      clearFieldErrors(overlay);
      const name = nameInput.value.trim();
      // Overrides belong to the thread, so a command that no longer opens one
      // writes none of them. The model ref is written whole: dropping a dial
      // here would leave a command running at settings the user never chose.
      const thread = run === 'subthread';
      const body = {
        description: $('#cmd-description').value.trim(),
        argsHint: $('#cmd-argshint').value.trim(),
        run,
        strategy: thread ? (strategySelect?.value || '') : '',
        provider: thread ? (modelConfig?.provider || '') : '',
        model: thread ? (modelConfig?.model || '') : '',
        thinking: thread ? (modelConfig?.thinking || '') : '',
        serviceTier: thread ? (modelConfig?.serviceTier || '') : '',
        icon: $('#cmd-icon').value.trim(),
        goal: thread ? $('#cmd-goal').value.trim() : '',
        template: templateInput.value,
      };
      saveBtn.disabled = true;
      const res = await writeUserCommand(/** @type {any} */ (scope), name, body);
      if (res.ok) {
        // If editing renamed/rescoped, remove the old file so we don't leave a dup.
        if (editing && def && (def.name !== name || def.scope !== scope)) {
          await deleteUserCommand(/** @type {any} */ (def.scope), def.name);
        }
        refreshRegistries();
        close(name);
        return;
      }
      saveBtn.disabled = false;
      if (res.status === 400 && res.data?.errors) {
        showFieldErrors(overlay, res.data.errors);
      } else {
        showFieldErrors(overlay, { template: res.data?.error || 'Could not save command.' });
      }
    });

    // Initial state.
    updateRunUI();
    updatePreview();
    updatePathHint();
    validateName();
    focusWhenShown(nameInput, { delay: 50 });
  });
}

/**
 * Open the `/commands` manager: a dialog listing the user's own commands grouped
 * by scope (This project / All projects), with edit / delete / new actions.
 * Broken definitions are shown with their error and an edit button rather than
 * hidden. Resolves when the manager closes.
 *
 * Built-in commands are not listed. Someone who opened the custom-command
 * manager is here to write one, and the built-ins are already documented where
 * every other loaded capability is — the Extensions settings, which the menus
 * offer their own button for.
 * @returns {Promise<void>}
 */
export function openCommandManager() {
  return new Promise((resolve) => {
    let stopLiveRefresh = () => {};
    const modal = presentModal({
      className: 'command-editor-overlay',
      dismissSelectors: ['.command-editor-backdrop', '#cmd-close'],
      onClose: () => { stopLiveRefresh(); resolve(); },
    });
    const overlay = modal.root;
    overlay.innerHTML = `
      <div class="command-editor-backdrop"></div>
      <div class="command-editor-panel" role="dialog" aria-modal="true" aria-label="Custom slash commands">
        <header class="command-editor-header">
          <h2>Custom slash commands</h2>
          <button id="cmd-close" class="close-button command-editor-close" title="Close" aria-label="Close"><span class="icon-close"></span></button>
        </header>
        <div class="command-editor-body" id="cmd-manager-body"></div>
        <footer class="command-editor-footer">
          <div class="command-editor-path"></div>
          <div class="command-editor-actions">
            <button id="cmd-manager-new" class="modal-button primary">New command…</button>
          </div>
        </footer>
      </div>`;

    const body = /** @type {HTMLElement} */ (overlay.querySelector('#cmd-manager-body'));

    // Only the most recent render writes the DOM. A live-refresh event can fire
    // while an earlier render is still awaiting its fetch; the sequence guard
    // stops that stale render from clobbering a newer list when it resumes.
    let renderSeq = 0;
    const render = async () => {
      const seq = ++renderSeq;
      const userCommands = await fetchUserCommands();
      if (seq !== renderSeq) return; // superseded by a newer render
      body.innerHTML = '';
      body.appendChild(userGroup('This project', userCommands.filter((d) => d.scope === 'project'), render));
      body.appendChild(userGroup('All projects', userCommands.filter((d) => d.scope === 'user'), render));
    };

    // Live-refresh across clients: any command file changing on disk — from this
    // client, another connected client, or an external edit — is broadcast by
    // the server as plugin-changed, driving reloadRegistries → REGISTRIES_RELOADED.
    // Re-render on that signal so an open manager tracks the change instead of
    // showing a stale list. The rebuild resets the user-commands cache before
    // dispatching, so render()'s fetch re-reads fresh from disk.
    const onRegistriesReloaded = () => { render(); };
    document.addEventListener(REGISTRIES_RELOADED, onRegistriesReloaded);
    stopLiveRefresh = () => document.removeEventListener(REGISTRIES_RELOADED, onRegistriesReloaded);

    overlay.querySelector('#cmd-manager-new')?.addEventListener('click', async () => {
      await openCommandEditor({});
      render();
    });

    render();
  });
}

/**
 * @param {string} title
 * @param {import('../services/user-commands.js').UserCommandDef[]} defs
 * @param {() => void} refresh
 * @returns {HTMLElement} Group element
 */
function userGroup(title, defs, refresh) {
  const group = document.createElement('div');
  group.className = 'command-manager-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (defs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'command-editor-hint';
    empty.textContent = 'None yet.';
    group.appendChild(empty);
    return group;
  }
  for (const def of defs) {
    const row = document.createElement('div');
    row.className = 'command-manager-row' + (def.error ? ' is-broken' : '');
    const code = document.createElement('code');
    code.textContent = '/' + def.name;
    row.appendChild(code);
    if (def.error) {
      const err = document.createElement('span');
      err.className = 'command-manager-error';
      err.textContent = def.error;
      row.appendChild(err);
    } else {
      const desc = document.createElement('span');
      desc.className = 'command-manager-desc';
      desc.textContent = def.frontmatter?.description || '';
      row.appendChild(desc);
    }
    const actions = document.createElement('div');
    actions.className = 'command-manager-actions';
    const edit = document.createElement('button');
    edit.className = 'modal-button secondary';
    edit.textContent = 'Edit';
    edit.addEventListener('click', async () => { await openCommandEditor({ def }); refresh(); });
    // Delete is the app's standard trashcan: an icon-only button, muted until
    // hovered, as every other per-row delete in the UI.
    const del = document.createElement('button');
    del.className = 'command-manager-delete';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete /${def.name}`);
    del.appendChild(Object.assign(document.createElement('span'), { className: 'icon-trashcan' }));
    del.addEventListener('click', async () => {
      const ok = await showConfirm(
        `Delete the /${def.name} command?`, 'Delete command', { danger: true, confirmText: 'Delete' });
      if (!ok) return;
      await deleteUserCommand(/** @type {any} */ (def.scope), def.name);
      refreshRegistries();
      refresh();
    });
    actions.append(edit, del);
    row.appendChild(actions);
    group.appendChild(row);
  }
  return group;
}

/**
 * @returns {Array<{id: string, manifest: any}>} Strategy manifests, or empty on error
 */
function strategyManifests() {
  try {
    return strategyRegistry.getAllManifests();
  } catch {
    return [];
  }
}

/**
 * Clear any inline field-error text in the dialog.
 * @param {HTMLElement} overlay
 */
function clearFieldErrors(overlay) {
  overlay.querySelectorAll('.command-editor-field-error').forEach((el) => { el.textContent = ''; });
}

/**
 * Render server-returned field errors inline beside their inputs.
 * @param {HTMLElement} overlay
 * @param {Record<string, string>} errors - field → message
 */
function showFieldErrors(overlay, errors) {
  for (const [field, message] of Object.entries(errors)) {
    const el = overlay.querySelector(`[data-error-for="${field}"]`);
    if (el) el.textContent = message;
  }
}

/**
 * The model config a command file describes, for the chip to show.
 *
 * Prefers the resolution the command will actually run with, and falls back to
 * the stored reference verbatim when nothing can be resolved — a dialog opened
 * before the first provider push must still show (and re-save) the model the
 * file names, rather than reporting it as inherited and quietly dropping it.
 * @param {import('../services/user-commands.js').UserCommandFrontmatter} fm
 * @returns {import('../model/model-config.js').ConcreteModelConfig|null} The config, or null for inherit
 */
function seedModelConfig(fm) {
  if (!fm.model) return null;
  return resolveModelConfig(fm)
    || buildModelConfig(fm.provider || '', fm.model, fm.thinking, fm.serviceTier);
}

/**
 * One segmented control: a radiogroup of buttons, the active one carrying the
 * selection. Values are ids from a fixed table, so they need no escaping.
 * @param {string} id - Element id
 * @param {string} ariaLabel - Group label
 * @param {string} attr - Data attribute holding each option's value
 * @param {Record<string, string>} options - value → label
 * @param {string} current - The selected value
 * @returns {string} HTML
 */
function segmentedHTML(id, ariaLabel, attr, options, current) {
  const segments = Object.entries(options).map(([value, label]) => {
    const active = value === current;
    return `<button type="button" class="command-editor-seg${active ? ' active' : ''}" role="radio"`
      + ` aria-checked="${active}" data-${attr}="${value}">${label}</button>`;
  }).join('');
  return `<div id="${id}" class="command-editor-segmented" role="radiogroup" aria-label="${ariaLabel}">${segments}</div>`;
}

/**
 * Wire a segmented control: a press moves the active state across the group and
 * reports the new value.
 * @param {HTMLElement} group - The radiogroup element
 * @param {string} attr - Data attribute holding each option's value
 * @param {(value: string) => void} onChange - Called with the newly selected value
 */
function wireSegmented(group, attr, onChange) {
  group.addEventListener('click', (e) => {
    const pressed = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.command-editor-seg'));
    if (!pressed || !group.contains(pressed)) return;
    group.querySelectorAll('.command-editor-seg').forEach((seg) => {
      const active = seg === pressed;
      seg.classList.toggle('active', active);
      seg.setAttribute('aria-checked', String(active));
    });
    onChange(pressed.dataset[attr] || '');
  });
}

/**
 * Build the dialog markup.
 * @param {{editing: boolean, name: string, scope: string, description: string, argsHint: string, run: string, icon: string, goal: string, template: string}} v
 * @returns {string} HTML
 */
function buildMarkup(v) {
  const esc = (/** @type {string} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `
    <div class="command-editor-backdrop"></div>
    <div class="command-editor-panel" role="dialog" aria-modal="true" aria-label="Command editor">
      <header class="command-editor-header">
        <h2>${v.editing ? 'Edit command' : 'New command'}</h2>
        <button id="cmd-close" class="close-button command-editor-close" title="Close" aria-label="Close"><span class="icon-close"></span></button>
      </header>
      <div class="command-editor-body">
        <div class="command-editor-row">
          <label class="command-editor-label command-editor-name-field">Name
            <div class="command-editor-name-row"><span class="command-editor-slash">/</span>
              <input id="cmd-name" type="text" class="command-editor-input" value="${esc(v.name)}"
                autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="review-pr" /></div>
          </label>
          <label class="command-editor-label">
            <span class="command-editor-label-text">Args hint <span class="command-editor-optional">(optional)</span></span>
            <input id="cmd-argshint" type="text" class="command-editor-input" value="${esc(v.argsHint)}" placeholder="&lt;pr-number&gt;" />
          </label>
        </div>
        <div id="cmd-name-error" class="command-editor-field-error" data-error-for="name"></div>

        <label class="command-editor-label">Description
          <input id="cmd-description" type="text" class="command-editor-input" value="${esc(v.description)}"
            placeholder="Shown in the slash menu" />
          <div class="command-editor-field-error" data-error-for="description"></div>
        </label>

        <label class="command-editor-label">Prompt template
          <textarea id="cmd-template" class="command-editor-textarea" rows="6"
            placeholder="Review PR $1. $ARGUMENTS">${esc(v.template)}</textarea>
          <div class="command-editor-field-error" data-error-for="template"></div>
          <div class="command-editor-hint">Placeholders: <code>$1</code>…<code>$9</code>, <code>$ARGUMENTS</code>, <code>$$</code> for a literal $.</div>
        </label>

        <div class="command-editor-preview">
          <div class="command-editor-preview-head">
            <span class="command-editor-preview-title">Preview</span>
            <input id="cmd-preview-args" type="text" class="command-editor-input command-editor-preview-args"
              placeholder="sample args" aria-label="Sample arguments for the preview" />
          </div>
          <pre id="cmd-preview-out" class="command-editor-preview-out"></pre>
        </div>

        <div class="command-editor-field">
          <div class="command-editor-label-text">When invoked</div>
          ${segmentedHTML('cmd-run', 'Run mode', 'run', RUN_MODES, v.run)}
          <div id="cmd-run-hint" class="command-editor-run-hint"></div>
        </div>

        <div id="cmd-subthread-fields" class="command-editor-subthread hidden">
          <div class="command-editor-hint">Applied to the thread only. Anything left inherited follows this conversation.</div>
          <label class="command-editor-label">Thread goal
            <input id="cmd-goal" type="text" class="command-editor-input" value="${esc(v.goal)}" placeholder="PR review" />
          </label>
          <label class="command-editor-label">Strategy
            <select id="cmd-strategy" class="command-editor-select"><option value="">Inherit from parent</option></select>
          </label>
          <div class="command-editor-label">
            <span class="command-editor-label-text">Model</span>
            <model-chip id="cmd-model"></model-chip>
          </div>
        </div>

        <input id="cmd-icon" type="hidden" value="${esc(v.icon)}" />
      </div>
      <footer class="command-editor-footer">
        <div class="command-editor-target">
          ${segmentedHTML('cmd-scope', 'Where to save', 'scope', SCOPES, v.scope === 'user' ? 'user' : 'project')}
          <div id="cmd-path-hint" class="command-editor-path"></div>
        </div>
        <div class="command-editor-actions">
          <button id="cmd-delete" class="modal-button danger hidden">Delete</button>
          <button id="cmd-save" class="modal-button primary">Save</button>
        </div>
      </footer>
    </div>
  `;
}
