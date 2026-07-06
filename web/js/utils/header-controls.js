//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Header controls: undo/redo buttons + project-path-display.
 * The buttons live once in .app-header and operate on the currently visible
 * conversation.
 * @module utils/header-controls
 */

import keyShortcutManager from '../services/key-shortcut-manager.js';

/**
 * @typedef {import('../model/session.js').default} Session
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/**
 * Wire up header controls (undo/redo + project path).
 * @param {Session} session
 */
export function setupHeaderControls(session) {
  const undoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-undo-button'));
  const redoBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('control-redo-button'));
  const pathDisplay = /** @type {HTMLElement|null} */ (document.getElementById('project-path-display'));
  const pathChip = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-path-chip'));
  const pathLabel = /** @type {HTMLElement|null} */ (pathDisplay?.querySelector('.ppd-path') ?? null);
  const newWindowBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('project-new-window-button'));

  /** @type {Conversation|null} */
  let currentConversation = null;
  /** @type {((event: any) => void) | null} */
  let metadataObserver = null;

  // The conversation's LLM loop is running whenever the worker's authoritative
  // processingState.status is anything other than 'idle' (it holds the claim
  // for the whole busy span — LLM call, tool execution, approval waits). Undo/
  // redo mutate the same Yjs doc the worker is actively writing, so we lock them
  // out for the duration. Reading the doc metadata (not the local llmState
  // projection) means viewers that didn't initiate the turn lock out too.
  const isBusy = () => {
    const status = currentConversation?.processingState?.status;
    return !!status && status !== 'idle';
  };

  const updateButtons = () => {
    const busy = isBusy();
    const canUndo = !busy && !!currentConversation?.canUndo();
    const canRedo = !busy && !!currentConversation?.canRedo();
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  };

  const bindToVisible = () => {
    const visible = session.getVisibleConversation();
    if (visible === currentConversation) {
      updateButtons();
      return;
    }
    // Detach old observer
    if (metadataObserver && currentConversation) {
      currentConversation.unobserveMetadata(metadataObserver);
      metadataObserver = null;
    }
    currentConversation = visible;
    if (currentConversation) {
      metadataObserver = (event) => {
        if (event.keysChanged?.has?.('undoState') || event.keysChanged?.has?.('processingState')) {
          updateButtons();
        }
      };
      currentConversation.observeMetadata(metadataObserver);
    }
    updateButtons();
  };

  const updateProjectPath = (/** @type {string} */ projectPath) => {
    if (!pathDisplay || !pathLabel) return;
    if (!projectPath) {
      pathLabel.textContent = 'Set project folder';
      if (pathChip) pathChip.title = 'Click to set the project folder';
      pathDisplay.classList.add('is-empty');
    } else {
      pathLabel.textContent = projectPath;
      if (pathChip) pathChip.title = `Current project: ${projectPath} — click to change`;
      pathDisplay.classList.remove('is-empty');
    }
  };

  if (undoBtn) {
    undoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.undo();
        updateButtons();
      }
    });
  }
  if (redoBtn) {
    redoBtn.addEventListener('click', async () => {
      if (currentConversation) {
        await currentConversation.redo();
        updateButtons();
      }
    });
  }
  // The chip is a real button opted out of the header drag region (CSS
  // --wails-draggable: no-drag), so a plain click reliably opens the picker —
  // no pointer-drag disambiguation needed.
  if (pathChip) {
    pathChip.addEventListener('click', async () => {
      const { openProjectPicker } = await import('../components/project-picker.js');
      openProjectPicker(session.projectPath || '', session);
    });
  }

  // Inline "open new window" button. Spawns a fresh juggler window in
  // no-project mode (the user then picks a folder). Only a native desktop
  // window has a host able to do this; in a remote browser tab apiService
  // .newWindow() is a no-op and the button is hidden by CSS anyway.
  if (newWindowBtn) {
    newWindowBtn.addEventListener('click', async () => {
      try {
        const { default: apiService } = await import('../services/api.js');
        await apiService.newWindow();
      } catch (err) {
        const { extractUserMessage } = await import('../../sdk/lib/error-utils.js');
        await window.showAlert(extractUserMessage(err), 'New window');
      }
    });
  }

  // Native menu (File ▸ Open…) bridges to the picker via this event, since the
  // Go side can't import the JS module directly. Same entry point as the
  // header path-display click above.
  window.addEventListener('juggler:open-project', async () => {
    const { openProjectPicker } = await import('../components/project-picker.js');
    openProjectPicker(session.projectPath || '', session);
  });

  // Keyboard shortcuts (undo / redo) — bindings and platform handling live in the
  // KeyShortcutManager; here we only supply the behaviour. Each returns truthy
  // only when it actually acts, so the manager preventDefaults exactly then (and
  // a no-op — busy, or nothing to undo — falls through untouched). The manager's
  // own input-field guard keeps ⌘Z out of the composer, which has native undo.
  keyShortcutManager.register('undo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canUndo()) return false;
    void currentConversation.undo().then(updateButtons);
    return true;
  });
  keyShortcutManager.register('redo', () => {
    if (!currentConversation || isBusy() || !currentConversation.canRedo()) return false;
    void currentConversation.redo().then(updateButtons);
    return true;
  });

  // Subscribe to session events to keep buttons + path display fresh
  session.subscribe(/** @param {{type: string}} event */ (event) => {
    switch (event.type) {
      case 'session:loaded':
        updateProjectPath(session.projectPath || '');
        bindToVisible();
        break;
      case 'conversation:changed':
      case 'conversation:switched':
      case 'conversation:created':
      case 'conversation:deleted':
      case 'contextItems:changed':
        bindToVisible();
        break;
    }
  });

  // Initial state
  updateProjectPath(session.projectPath || '');
  bindToVisible();
}
