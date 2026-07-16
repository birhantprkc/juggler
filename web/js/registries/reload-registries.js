//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from './context-item-registry.js';
import strategyRegistry from './strategy-registry.js';
import commandRegistry from './command-registry.js';
import { resetExtensionsCache } from '../services/extensions.js';
import { resetUserCommandsCache } from '../services/user-commands.js';
import { resetSkillsCache } from '../services/skills.js';
import { markRegistriesReady } from './registry-ready.js';

/**
 * Event dispatched on `document` after the capability registries have been torn
 * down and rebuilt from the current extension catalog + config. UI that caches
 * registry contents (the strategy selector's menu, etc.) listens for this and
 * reloads from the registries — it is the single signal that the set of enabled
 * strategies / context items / commands may have changed.
 * @type {string}
 */
export const REGISTRIES_RELOADED = 'registries-reloaded';

/** @type {Promise<void>|null} */
let reloadInFlight = null;
let reloadRequested = false;

/**
 * @returns {import('../model/session.js').default[]} Locally reachable app/engine sessions
 */
function getLiveSessions() {
  const sessions = [];
  const appSession = /** @type {any} */ (globalThis).jugglerApp?._connectionManager?.getSession?.();
  const engineSession = /** @type {any} */ (globalThis).engineApp?._connectionManager?.getSession?.();
  if (appSession) sessions.push(appSession);
  if (engineSession && engineSession !== appSession) sessions.push(engineSession);
  return sessions;
}

/**
 * @param {import('../model/conversation.js').default} conv
 * @returns {boolean} True while the conversation's worker status is non-idle
 */
function isConversationBusy(conv) {
  const status = conv.processingState?.status;
  return !!status && status !== 'idle' && status !== 'error' && status !== 'validation-error';
}

/**
 * @returns {boolean} True when any local session has a busy conversation
 */
function anyLocalConversationBusy() {
  for (const session of getLiveSessions()) {
    for (const conv of session.conversations?.values?.() || []) {
      if (isConversationBusy(conv)) return true;
    }
  }
  return false;
}

/** @returns {Promise<void>} */
async function waitForLocalQuiescence() {
  while (anyLocalConversationBusy()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Initialize the three capability registries in dependency order (strategies
 * first — they gate the whole flow), then flip the registries-ready gate.
 *
 * The single shared boot/rebuild sequence: first-boot (app.js / engine-app.js)
 * and hot-reload (rebuildRegistriesNow) both call it, so the order and the ready
 * signal never drift. markRegistriesReady() runs even when an init throws, so a
 * broken plugin can't permanently hang the system-prompt gate; it is idempotent
 * after the first call, so the gate stays resolved across reloads.
 * @returns {Promise<void>}
 */
export async function initAllRegistries() {
  try {
    await strategyRegistry.init();
    await contextItemRegistry.init();
    await commandRegistry.init();
  } finally {
    markRegistriesReady();
  }
}

/** @returns {Promise<void>} */
async function rebuildRegistriesNow() {
  resetExtensionsCache();
  resetUserCommandsCache();
  resetSkillsCache();
  strategyRegistry.reset();
  contextItemRegistry.reset();
  commandRegistry.reset();
  // reset/re-init is deferred to local quiescence, so no turn assembles a
  // prompt against a half-reset registry set.
  await initAllRegistries();
  // UI listens for this DOM event to refresh; the engine worker has no document
  // and reloads its registries directly, so the dispatch is viewer-only.
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));
  }
}

/**
 * Tear down and rebuild all three capability registries from the current
 * extension catalog and plugin config, then announce the change.
 *
 * This is the one path shared by plugin hot reload (a changed/added extension on
 * disk) and the Extensions catalog's enable/disable toggles, so both apply live
 * and both notify dependent UI. The cached `/api/extensions` catalog is dropped
 * first so a freshly linked extension or edited manifest is re-fetched.
 *
 * Registry maps are immutable for the duration of any locally observed turn: if
 * a reload arrives while a conversation is busy, the reset/re-init is deferred
 * until the worker metadata reaches idle. Multiple reload requests coalesce into
 * one rebuild after the quiescent boundary.
 * @returns {Promise<void>}
 */
export async function reloadRegistries() {
  reloadRequested = true;
  if (reloadInFlight) return reloadInFlight;

  reloadInFlight = (async () => {
    while (reloadRequested) {
      reloadRequested = false;
      await waitForLocalQuiescence();
      await rebuildRegistriesNow();
    }
  })();

  try {
    await reloadInFlight;
  } finally {
    reloadInFlight = null;
  }
}
