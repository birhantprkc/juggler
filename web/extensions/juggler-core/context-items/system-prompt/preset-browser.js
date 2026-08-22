//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The system-prompt item's preset UI: the browser dropdown (built-in and user
 * presets grouped by category, each with a default indicator), the save-current
 * flow, and the manage-presets popup.
 *
 * Written as functions taking the context item as their first argument, in the
 * conversation-area-rendering.js / composer-attachments.js shape, because every
 * one of them reads or writes item state — `data.text`, `data.selectedPresetId`,
 * the `_dropdownRelease` handle — rather than being pure the way
 * web-search/ddg-parser.js was. The item keeps `_dropdownRelease` as its own
 * field: presentPopup hands back one release per surface, and both this module's
 * surfaces (browser and manage) share the slot so opening either closes the
 * other.
 *
 * Only showPresetBrowser is exported; the rest is reachable from it.
 */

import { createElement, presentPopup } from 'juggler/ui';
import { systemPromptRegistry } from '../../../../sdk/lib/system-prompt-registry.js';
import { extractErrorMessage } from '../../../../sdk/lib/error-utils.js';
import {
  ensureUserPresetsLoaded,
  getDefaultPresetId,
  setDefaultPreset,
  saveUserPreset,
  deleteUserPreset,
  updateUserPreset
} from '../../../../js/services/system-prompt-presets.js';

/** @typedef {import('../../../../sdk/lib/system-prompt-registry.js').SystemPromptPreset} SystemPromptPreset */

// Inline icons for the dropdown (Material Symbols paths, currentColor fill).
/**
 * @param {string} path - SVG path data
 * @returns {string} SVG markup
 */
const SP_ICON = (path) => `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${path}"/></svg>`;
const SP_ICON_CHECK = SP_ICON('M382-240 154-468l57-56 171 171 372-372 57 56-429 429Z');
const SP_ICON_PLUS = SP_ICON('M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z');
const SP_ICON_GEAR = SP_ICON('m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z');

/**
 * Close the open preset dropdown, if any.
 * @param {any} item - The SystemPromptContextItem
 */
function closeDropdown(item) {
  if (item._dropdownRelease) {
    item._dropdownRelease();
    item._dropdownRelease = null;
  }
}

/**
 * Show the preset browser dropdown: built-in and user presets grouped by
 * category, each with a default indicator / "Set as default" action, plus
 * footer actions to save the current prompt as a preset and to manage user
 * presets.
 * @param {any} item - The SystemPromptContextItem
 * @param {HTMLElement} buttonElement - Trigger button
 * @param {HTMLElement} container - Properties panel container
 */
export async function showPresetBrowser(item, buttonElement, container) {
  // Toggle: a second click closes the open dropdown.
  if (item._dropdownRelease) {
    closeDropdown(item);
    return;
  }

  // Pull in the user's saved presets + default id before rendering.
  await ensureUserPresetsLoaded();

  const dropdown = document.createElement('nav');
  dropdown.className = 'dropdown-menu system-prompt-preset-dropdown show';
  renderPresetMenu(item, dropdown, container);

  // presentPopup owns body-append, dismissal wiring (outside-click via
  // insideSelectors + Escape), the reposition observer, and the
  // anchored-vs-sheet decision.
  item._dropdownRelease = presentPopup({
    surface: dropdown,
    anchor: buttonElement,
    id: 'system-prompt-preset-dropdown',
    onClose: () => closeDropdown(item),
    insideSelectors: ['.system-prompt-preset-dropdown', '.system-prompt-preset-btn'],
  });
}

/**
 * Render (or re-render in place) the preset dropdown's menu contents. Called
 * on open and after a default change so the indicator updates without closing.
 * @param {any} item - The SystemPromptContextItem
 * @param {HTMLElement} dropdown - The dropdown surface element
 * @param {HTMLElement} container - Properties panel container
 */
function renderPresetMenu(item, dropdown, container) {
  const menu = document.createElement('menu');
  const defaultId = getDefaultPresetId();
  const selectedId = item.data.selectedPresetId;

  for (const category of systemPromptRegistry.getCategories()) {
    const presets = systemPromptRegistry.getPresetsByCategory(category);
    if (presets.length === 0) continue;

    menu.appendChild(buildCategoryHeader(category));

    for (const preset of presets) {
      menu.appendChild(buildPresetMenuItem(item, preset, defaultId, selectedId, dropdown, container));
    }
  }

  // Footer actions.
  menu.appendChild(createElement('li', 'sp-preset-separator'));

  menu.appendChild(buildActionItem(SP_ICON_PLUS, 'Save current text as preset…', () => {
    saveCurrentAsPreset(item, dropdown, container);
  }));
  menu.appendChild(buildActionItem(SP_ICON_GEAR, 'Manage presets…', () => {
    closeDropdown(item);
    showManagePresets(item, container);
  }));

  dropdown.replaceChildren(menu);
}

/**
 * Build an uppercase section label row (capitalized; CSS upper-cases it).
 * @param {string} label - Category label
 * @returns {HTMLElement} The header row
 */
function buildCategoryHeader(label) {
  return createElement('li', 'sp-preset-category', label.charAt(0).toUpperCase() + label.slice(1));
}

/**
 * Build one preset row: a leading check column marks the preset currently
 * applied to this conversation; the name flexes; the trailing slot shows a
 * "default" badge (for the new-conversation default) or a hover-revealed
 * "Set default" button.
 * @param {any} item - The SystemPromptContextItem
 * @param {SystemPromptPreset} preset - The preset this row represents
 * @param {string} defaultId - The current default preset id
 * @param {string} selectedId - The preset applied to this conversation
 * @param {HTMLElement} dropdown - The dropdown surface (for in-place refresh)
 * @param {HTMLElement} container - Properties panel container
 * @returns {HTMLElement} The menu row
 */
function buildPresetMenuItem(item, preset, defaultId, selectedId, dropdown, container) {
  const isSelected = preset.id === selectedId;
  const row = createElement('li', 'sp-preset-row' + (isSelected ? ' is-selected' : ''));

  const icon = createElement('span', 'sp-preset-row-icon');
  if (isSelected) icon.innerHTML = SP_ICON_CHECK;
  row.appendChild(icon);

  row.appendChild(createElement('span', 'sp-preset-row-name', preset.name));

  if (preset.id === defaultId) {
    row.appendChild(createElement('span', 'sp-preset-default-badge', 'default'));
  } else {
    const setBtn = document.createElement('button');
    setBtn.className = 'sp-preset-setdefault-btn';
    setBtn.textContent = 'Set default';
    setBtn.title = `Make "${preset.name}" the default for new conversations`;
    setBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await setDefaultPreset(preset.id);
        renderPresetMenu(item, dropdown, container);
      } catch (err) {
        console.error('[SystemPrompt] set default failed:', err);
      }
    });
    row.appendChild(setBtn);
  }

  row.addEventListener('click', () => applyPreset(item, preset, container));
  return row;
}

/**
 * Build a footer action row: leading icon (aligned to the preset rows' check
 * column) + label.
 * @param {string} iconSvg - Inline SVG markup for the leading icon
 * @param {string} label - Row label
 * @param {() => void} onClick - Click handler
 * @returns {HTMLElement} The menu row
 */
function buildActionItem(iconSvg, label, onClick) {
  const row = createElement('li', 'sp-preset-row sp-preset-action');

  const icon = createElement('span', 'sp-preset-row-icon');
  icon.innerHTML = iconSvg;
  row.appendChild(icon);

  row.appendChild(createElement('span', 'sp-preset-row-name', label));

  row.addEventListener('click', onClick);
  return row;
}

/**
 * Apply a preset: copy its full body into the doc as the prompt text (so the
 * build is independent of the registry), record the source id, and close.
 * @param {any} item - The SystemPromptContextItem
 * @param {SystemPromptPreset} preset - The preset to apply
 * @param {HTMLElement} container - Properties panel container
 */
function applyPreset(item, preset, container) {
  item.data.text = preset.content;
  item.data.selectedPresetId = preset.id;
  item.data.isModified = false;
  item._persistData(true);

  syncTextArea(item, container);
  closeDropdown(item);
}

/**
 * Push the effective prompt body back into the panel's textarea after a change
 * this module made to `data.text`. The textarea is not rebuilt on a same-item
 * update (updatePropertiesPanel syncs it in place), so a preset applied while
 * the panel is open has to write the field itself.
 * @param {any} item - The SystemPromptContextItem
 * @param {HTMLElement} container - Properties panel container
 */
function syncTextArea(item, container) {
  const textArea = container.querySelector('.system-prompt-textarea');
  if (textArea) {
    /** @type {HTMLTextAreaElement} */(textArea).value = item._getEffectiveText();
  }
}

/**
 * Prompt for a name and save the current prompt body as a new user preset,
 * then select it.
 * @param {any} item - The SystemPromptContextItem
 * @param {HTMLElement} dropdown - The dropdown surface
 * @param {HTMLElement} container - Properties panel container
 * @returns {Promise<void>}
 */
async function saveCurrentAsPreset(item, dropdown, container) {
  const content = item._getEffectiveText();
  if (!content.trim()) return;

  // When the editor is already on a user preset, offer to update it in place
  // instead of always creating a new one.
  const currentId = item.data.selectedPresetId;
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
            selectPreset(item, existing.id);
            renderPresetMenu(item, dropdown, container);
          } catch (err) {
            await reportPresetFailure(err, 'update', '[SystemPrompt] update preset failed:');
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
    selectPreset(item, preset.id);
    renderPresetMenu(item, dropdown, container);
  } catch (err) {
    await reportPresetFailure(err, 'save', '[SystemPrompt] save preset failed:');
  }
}

/**
 * Record a preset as the one this conversation is on, unmodified, and persist.
 * @param {any} item - The SystemPromptContextItem
 * @param {string} presetId - The preset now in the editor
 */
function selectPreset(item, presetId) {
  item.data.selectedPresetId = presetId;
  item.data.isModified = false;
  item._persistData(true);
}

/**
 * Surface a failed preset write. The provider's own message is what tells the
 * user whether the name collided or the disk is full, so it is shown rather
 * than summarised away.
 * @param {unknown} err - The thrown error
 * @param {string} verb - What was being attempted ("save", "update")
 * @param {string} logPrefix - Console prefix for the developer-facing log
 * @returns {Promise<void>}
 */
async function reportPresetFailure(err, verb, logPrefix) {
  console.error(logPrefix, err);
  const showConfirm = /** @type {any} */ (window).showConfirm;
  if (showConfirm) await showConfirm(extractErrorMessage(err), `Couldn't ${verb} preset`, { confirmText: 'OK' });
}

/**
 * Show the manage-presets popup: lists user presets with edit/delete (built-ins
 * are not user-deletable, so they are not listed here).
 * @param {any} item - The SystemPromptContextItem
 * @param {HTMLElement} container - Properties panel container
 */
function showManagePresets(item, container) {
  const surface = document.createElement('nav');
  surface.className = 'dropdown-menu system-prompt-manage-dropdown show';

  const render = () => {
    const menu = document.createElement('menu');
    menu.appendChild(buildCategoryHeader('Your presets'));

    const userPresets = systemPromptRegistry.getPresetsByCategory('user');
    if (userPresets.length === 0) {
      menu.appendChild(createElement('li', 'sp-preset-empty', 'No saved presets yet.'));
    }

    for (const preset of userPresets) {
      menu.appendChild(buildManageRow(item, preset, container, render));
    }

    surface.replaceChildren(menu);
  };

  render();

  closeDropdown(item);
  const presetBtn = /** @type {HTMLElement|null} */ (container.querySelector('.system-prompt-preset-btn'));
  item._dropdownRelease = presentPopup({
    surface,
    anchor: presetBtn || container,
    id: 'system-prompt-manage-dropdown',
    onClose: () => closeDropdown(item),
    insideSelectors: ['.system-prompt-manage-dropdown', '.system-prompt-preset-btn'],
  });
}

/**
 * Build one row of the manage-presets list: name plus Edit and Delete.
 * @param {any} item - The SystemPromptContextItem
 * @param {SystemPromptPreset} preset - The user preset this row represents
 * @param {HTMLElement} container - Properties panel container
 * @param {() => void} rerender - Re-render the list in place (after a delete)
 * @returns {HTMLElement} The list row
 */
function buildManageRow(item, preset, container, rerender) {
  const row = createElement('li', 'sp-preset-row sp-preset-static');

  // Empty leading slot keeps names aligned with the preset-browser rows.
  row.appendChild(createElement('span', 'sp-preset-row-icon'));
  row.appendChild(createElement('span', 'sp-preset-row-name', preset.name));

  const editBtn = document.createElement('button');
  editBtn.className = 'sp-preset-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Load the preset content into the editor so the user can tweak it,
    // then close this dialog.
    item.data.text = preset.content;
    selectPreset(item, preset.id);
    syncTextArea(item, container);
    closeDropdown(item);
  });
  row.appendChild(editBtn);

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
      rerender();
    } catch (err) {
      console.error('[SystemPrompt] delete preset failed:', err);
    }
  });
  row.appendChild(delBtn);

  return row;
}
