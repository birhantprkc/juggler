//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Attention manager — alerts the user (chime + visual flash) when a conversation
 * needs them while they're not looking at it.
 *
 * Triggers (false→true edges, per conversation):
 *  - a tool-action enters **awaiting-approval** anywhere in the thread tree
 *    (this also covers AskUserQuestion, which is an approval under the hood), or
 *  - a worker **turn completes** and the conversation comes to rest (idle).
 *
 * Every alert is gated on the user *not already looking* at that conversation:
 * we suppress it only when this window is focused/visible AND the conversation
 * is the one on screen. So the thread you're actively watching never beeps; a
 * backgrounded window, or an off-screen tab, does.
 *
 * Two layers of visual signal:
 *  - The conversation's **tab always flashes** and keeps a standing highlight —
 *    this is not a preference; it fires on every alert in every mode.
 *  - An optional **out-of-app signal** (the `notify` pref) on top: a dock-icon
 *    bounce in the desktop app, or a leading ● on this browser tab's title in a
 *    browser. This is the configurable part — the one the toggle governs.
 *
 * A standing alert clears when you view the conversation, or auto-dismisses after
 * {@link alertTimeoutMs} so it never lingers when you don't return to it.
 *
 * Preference model mirrors {@link module:utils/theme-manager}: a per-window
 * choice in localStorage, so different windows can have different needs (one
 * babysitting a long autonomous run wants alerts; one you're typing in doesn't).
 * Sound and the out-of-app notification are independent toggles. The header bell
 * is the on/off for notification sounds — the same `sound` pref the settings
 * checkbox drives.
 * @module utils/attention-manager
 */

import { hasPendingApprovalInTree } from '../model/thread-navigation.js';
import { playChime, unlockAudio, rearmAudio, CHIME_DEFAULTS, chimePatterns, chimeSounds } from './chime-synth.js';
import { windowControlURL } from '../../sdk/lib/window-control.js';

const PREFS_KEY = 'juggler-attention';
/** Fired on window whenever prefs change, so the bell + settings stay in sync. */
export const ATTENTION_PREFS_EVENT = 'juggler:attention-prefs-changed';

/** @typedef {import('./chime-synth.js').ChimeParams} ChimeParams */
/**
 * @typedef {object} AttentionPrefs
 * @property {boolean} sound - Play the chime on alert (the header bell's toggle).
 * @property {boolean} notify - Raise an out-of-app attention signal on alert: a
 *   dock-icon bounce in the desktop app, or a ● on this browser tab's title in a
 *   browser. Independent of the in-app conversation-tab flash, which is always on.
 * @property {ChimeParams} chime - Abstract chime voice parameters.
 */

/**
 * Defaults: notify on (unobtrusive, no permission), sound off (enabling it is
 * the gesture that unlocks audio).
 * @type {AttentionPrefs}
 */
const DEFAULT_PREFS = {
  sound: false,
  notify: true,
  chime: { ...CHIME_DEFAULTS },
};

/**
 * Read the current per-window prefs, merged over defaults so a partial or older
 * stored blob still yields a complete object.
 * @returns {AttentionPrefs} The merged, complete prefs object.
 */
export function getAttentionPrefs() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  // Validate each chime field against its live schema, so a stale value from an
  // older build (the pre-menu `pitch`/`length`/numeric-`pattern` knobs, or a
  // removed pattern/sound id) is dropped for the default rather than riding
  // through into prefs and desyncing the settings popups.
  const storedChime = /** @type {Record<string, unknown>} */ (/** @type {any} */ (stored).chime || {});
  const validPatterns = new Set(chimePatterns().map((p) => p.id));
  const validSounds = new Set(chimeSounds().map((s) => s.id));
  const vol = storedChime.volume;
  const chime = /** @type {ChimeParams} */ ({
    pattern: validPatterns.has(/** @type {any} */ (storedChime.pattern)) ? storedChime.pattern : DEFAULT_PREFS.chime.pattern,
    sound: validSounds.has(/** @type {any} */ (storedChime.sound)) ? storedChime.sound : DEFAULT_PREFS.chime.sound,
    volume: typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : DEFAULT_PREFS.chime.volume,
  });
  return { ...DEFAULT_PREFS, ...stored, chime };
}

/**
 * Persist a partial update and notify listeners.
 * @param {Partial<AttentionPrefs>} patch
 * @returns {AttentionPrefs} The merged, saved prefs.
 * @private
 */
function savePrefs(patch) {
  const next = { ...getAttentionPrefs(), ...patch };
  if (patch.chime) next.chime = { ...getAttentionPrefs().chime, ...patch.chime };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(ATTENTION_PREFS_EVENT, { detail: next }));
  return next;
}

/** @returns {boolean} Whether notification sounds are enabled. */
export function isSoundEnabled() {
  return getAttentionPrefs().sound;
}

/**
 * Toggle notification sounds — the single on/off for audible alerts, shared by
 * the header bell and the settings checkbox. The click that calls this is a user
 * gesture, so we use it to unlock audio for the session.
 * @returns {boolean} The new sound-enabled state.
 */
export function toggleSound() {
  const next = !isSoundEnabled();
  // Turning on: unlock audio within this gesture — autoplay policy requires a user
  // gesture to start playback for the session.
  if (next) unlockAudio();
  savePrefs({ sound: next });
  return next;
}

/**
 * Set notification sounds absolutely (the settings checkbox; the header bell uses
 * {@link toggleSound}).
 * @param {boolean} on
 * @returns {void}
 */
export function setSoundEnabled(on) {
  if (on) unlockAudio();
  savePrefs({ sound: !!on });
}

/** @returns {boolean} Whether the out-of-app attention signal is enabled. */
export function isNotifyEnabled() {
  return getAttentionPrefs().notify;
}

/**
 * Toggle the out-of-app attention signal (dock-icon bounce / browser-tab title
 * badge). Does NOT touch the in-app conversation-tab flash, which always fires;
 * it only re-syncs the browser-tab title badge to the new setting.
 * @param {boolean} on
 * @returns {void}
 */
export function setNotifyEnabled(on) {
  savePrefs({ notify: !!on });
  syncBrowserTitleBadge();
}

/**
 * Update one chime parameter: `pattern`/`sound` (a menu id, string) or `volume`
 * (0..1, number).
 * @param {keyof ChimeParams} name
 * @param {string|number} value
 * @returns {void}
 */
export function setChimeParam(name, value) {
  savePrefs({ chime: { ...getAttentionPrefs().chime, [name]: value } });
}

/**
 * Reset every chime parameter back to {@link CHIME_DEFAULTS} in one save. The
 * resulting {@link ATTENTION_PREFS_EVENT} re-syncs the settings rotaries.
 * @returns {void}
 */
export function resetChimeParams() {
  savePrefs({ chime: { ...CHIME_DEFAULTS } });
}

/**
 * Play the current chime once, regardless of mute/sound prefs — for the settings
 * "preview" button. Doubles as the audio-unlock gesture.
 * @returns {void}
 */
export function previewChime() {
  unlockAudio();
  const chime = getAttentionPrefs().chime;
  playChime(chime);
}

// ── Alert surfaces ──────────────────────────────────────────────────────────

/**
 * Conversations currently showing an unviewed visual alert.
 * @type {Set<string>}
 */
const flagged = new Set();
/**
 * The document title before we started flashing it.
 * @type {string|null}
 */
let savedTitle = null;
/**
 * Per-conversation auto-dismiss timers. A standing alert clears itself after
 * {@link alertTimeoutMs} so it never lingers when the user doesn't come back to
 * it; viewing the conversation cancels its timer early.
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const dismissTimers = new Map();
/**
 * How long a standing alert survives before auto-dismissing (ms). Overridable
 * via the test seam.
 * @type {number}
 */
let alertTimeoutMs = 20000;

/**
 * Whether this page is a plain browser tab rather than a native desktop-app
 * window. Only a browser tab surfaces `document.title` (in the tab strip); a
 * desktop window's title bar is the native OS title, set via the title endpoint,
 * so there's nothing here to badge.
 * @returns {boolean} True when running as a plain browser tab.
 * @private
 */
function isBrowserTab() {
  return typeof document !== 'undefined'
    && document.documentElement.dataset.windowMode !== '1';
}

/**
 * The browser-tab title badge (a leading ● on the title) — the browser's flavour
 * of the out-of-app attention signal. Shown only when the `notify` pref is on AND
 * some conversation is flagged. No-op outside a browser tab (a desktop window
 * shows no document title — there the signal is the dock bounce instead).
 * @private
 */
function syncBrowserTitleBadge() {
  if (!isBrowserTab()) return;
  const show = getAttentionPrefs().notify && flagged.size > 0;
  if (show) {
    if (savedTitle === null) savedTitle = document.title;
    document.title = `\u25CF ${savedTitle}`; // ● prefix
  } else if (savedTitle !== null) {
    document.title = savedTitle;
    savedTitle = null;
  }
}

/**
 * Raise the out-of-app attention signal for a desktop window: bounce the app's
 * dock/taskbar icon via the native host's loopback `attention` endpoint. No-op in
 * a browser (no native host — windowControlURL returns null), where the standing
 * tab-title badge from {@link syncBrowserTitleBadge} carries the signal instead.
 * Best-effort and one-way.
 * @private
 */
function requestDockBounce() {
  const url = windowControlURL('attention');
  if (url) fetch(url, { method: 'POST' }).catch(() => { /* one-way; nothing to recover */ });
}

/**
 * Flash a conversation's tab: a brief one-shot animation plus a standing
 * highlight on its sidebar tab, auto-dismissing after {@link alertTimeoutMs}.
 * This is the in-app signal and is ALWAYS applied on alert — never gated on a
 * preference (the out-of-app dock/title signal is the configurable part). Also
 * re-syncs the browser-tab title badge, which honours the `notify` pref.
 * @param {string} convId
 * @private
 */
function flashConversation(convId) {
  flagged.add(convId);
  const tab = document.querySelector(`.conversation-tab[data-conversation-id="${CSS.escape(convId)}"]`);
  if (tab) {
    tab.classList.add('needs-attention');
    // Restart the one-shot flash animation if it's already present.
    tab.classList.remove('attention-flash');
    void (/** @type {HTMLElement} */ (tab)).offsetWidth; // reflow
    tab.classList.add('attention-flash');
    // Drop the flash class once the blinks finish so the tab falls back to its
    // underlying state (the awaiting pulse, or idle) — the standing
    // `needs-attention` marker persists until the alert is viewed or times out.
    tab.addEventListener('animationend', () => tab.classList.remove('attention-flash'), { once: true });
  }
  // (Re)arm the auto-dismiss countdown; a fresh alert restarts the clock.
  const existing = dismissTimers.get(convId);
  if (existing) clearTimeout(existing);
  dismissTimers.set(convId, setTimeout(() => clearFlash(convId), alertTimeoutMs));
  syncBrowserTitleBadge();
}

/**
 * Clear the visual alert for one conversation (it's been viewed or timed out),
 * cancelling its pending auto-dismiss timer.
 * @param {string} convId
 * @private
 */
function clearFlash(convId) {
  const timer = dismissTimers.get(convId);
  if (timer) {
    clearTimeout(timer);
    dismissTimers.delete(convId);
  }
  if (!flagged.delete(convId)) return;
  const tab = document.querySelector(`.conversation-tab[data-conversation-id="${CSS.escape(convId)}"]`);
  if (tab) tab.classList.remove('needs-attention', 'attention-flash');
  syncBrowserTitleBadge();
}

/**
 * Clear every standing tab flash (e.g. on re-init).
 * @private
 */
function clearAllFlash() {
  for (const id of [...flagged]) clearFlash(id);
}

/**
 * The conversation ids currently showing an unviewed visual alert. Read seam for
 * the "jump to conversation needing attention" command.
 * @returns {string[]} Flagged conversation ids.
 */
export function getFlaggedConversationIds() {
  return [...flagged];
}

// ── Edge detection + gating ─────────────────────────────────────────────────

/** @type {import('../model/session.js').default|null} */
let session = null;
/**
 * Per-conversation previous awaiting state.
 * @type {Map<string, boolean>}
 */
const prevAwaiting = new Map();
/**
 * Per-conversation previous completed-turn count.
 * @type {Map<string, number>}
 */
const prevTurns = new Map();
/**
 * Test seam: overrides the focus check when set.
 * @type {boolean|null}
 */
let focusOverride = null;

/**
 * Whether the user is currently looking at `convId` in this window: the window
 * is focused and visible AND that conversation is the one on screen. When true,
 * an alert for that conversation is suppressed (and any standing flash cleared).
 * @param {string} convId
 * @returns {boolean} True when the user is actively viewing this conversation.
 * @private
 */
function isLookingAt(convId) {
  const focused = focusOverride !== null
    ? focusOverride
    : (!document.hidden && document.hasFocus());
  return focused && session?.visibleConversationId === convId;
}

/**
 * Fire the configured alert surfaces for a conversation that just needed
 * attention while unwatched.
 * @param {string} convId
 * @private
 */
function alert(convId) {
  const prefs = getAttentionPrefs();
  if (prefs.sound) playChime(prefs.chime);
  // In-app conversation-tab flash: always — never gated on a preference.
  flashConversation(convId);
  // Out-of-app signal (dock bounce on desktop; the browser-tab title badge is
  // handled reactively in syncBrowserTitleBadge): only when the user opted in.
  if (prefs.notify) requestDockBounce();
  __attention.alertCount++;
  __attention.lastAlert = { convId, t: __attention.alertCount };
}

/**
 * React to a status change for one conversation: detect the awaiting / turn-done
 * edges and either alert or (if the user is looking) clear any standing flash.
 * @param {string} convId
 * @private
 */
function onStatus(convId) {
  const conv = session?.conversations.get(convId);
  if (!conv) return;

  const llm = /** @type {any} */ (conv)._llmState;
  const root = /** @type {any} */ (conv).rootMessageThread;
  const awaiting = !!root && hasPendingApprovalInTree(root.items);
  const turns = conv.completedTurns;
  const processing = !!llm && llm.isConversationProcessing(convId);

  const hadAwaiting = prevAwaiting.get(convId);
  const hadTurns = prevTurns.get(convId);

  // Seed baselines on first sight without alerting (avoids a beep on load).
  const seeded = hadTurns !== undefined;
  prevAwaiting.set(convId, awaiting);
  prevTurns.set(convId, turns);

  // If the user is looking at this conversation, it's not "needing attention" —
  // keep baselines current and clear any leftover flash.
  if (isLookingAt(convId)) {
    clearFlash(convId);
    return;
  }
  if (!seeded) return;

  const awaitingEdge = awaiting && !hadAwaiting;
  // "Came to rest": a turn completed and the conversation is now idle.
  const turnEdge = turns > /** @type {number} */ (hadTurns) && !processing;

  if (awaitingEdge || turnEdge) alert(convId);
}

/**
 * Clear flags for whichever conversation the user is now looking at. Wired to
 * focus/visibility/switch so viewing a flagged conversation dismisses its alert.
 * @private
 */
function reconcileVisible() {
  const id = session?.visibleConversationId;
  if (id && isLookingAt(id)) clearFlash(id);
}

/**
 * Passive audio re-arm on a return-to-app edge (window focus, tab becoming
 * visible). A long-idle session's AudioContext can be parked by the OS while
 * backgrounded, and the resume() attempted at park time is rejected on a hidden
 * tab — so this edge is the moment it can finally succeed. Only when sound is
 * enabled (with it off there's no warmed device to keep), and only on becoming
 * visible (visibilitychange also fires on hide). See
 * {@link module:utils/chime-synth.rearmAudio}.
 * @private
 */
function rearmAudioOnReturn() {
  if (document.hidden) return;
  if (isSoundEnabled()) rearmAudio();
}

/**
 * Wire the attention manager to a session. Idempotent per session: subscribes to
 * LLM status changes (the one event that fires on every edge we care about) and
 * to focus/visibility so viewing a flagged conversation dismisses it.
 * @param {import('../model/session.js').default} sess
 * @returns {void}
 */
export function initAttention(sess) {
  session = sess;
  prevAwaiting.clear();
  prevTurns.clear();
  clearAllFlash();

  /**
   * Wire the (shared) LLMState observer; conversations may arrive later.
   * @type {(() => void)|null}
   */
  let unsub = null;
  const wire = () => {
    if (unsub) return;
    const anyConv = sess.conversations.values().next().value;
    const llm = /** @type {any} */ (anyConv)?._llmState;
    if (llm?.addStatusObserver) {
      unsub = llm.addStatusObserver((/** @type {string} */ id) => onStatus(id));
    }
  };
  wire();

  sess.subscribe(/** @param {{type: string}} e */ (e) => {
    if (e.type === 'conversation:created') wire();
    if (e.type === 'conversation:switched') reconcileVisible();
  });

  window.addEventListener('focus', reconcileVisible);
  document.addEventListener('visibilitychange', reconcileVisible);
  // Re-arm audio on the same return-to-app edges, so a long-idle session whose
  // context the OS parked while backgrounded is warm again by the next chime with
  // no user gesture. Kept separate from reconcileVisible, which also runs on
  // conversation switch — not an audio-relevant edge.
  window.addEventListener('focus', rearmAudioOnReturn);
  document.addEventListener('visibilitychange', rearmAudioOnReturn);
}

/**
 * Test/debug seam. Not part of the supported API.
 * @type {{alertCount: number, lastAlert: any, setFocusedForTest: (v: boolean|null) => void, setAlertTimeoutForTest: (ms: number) => void, isFlagged: (convId: string) => boolean, flashForTest: (convId: string) => void}}
 */
export const __attention = {
  alertCount: 0,
  lastAlert: null,
  setFocusedForTest(v) { focusOverride = v; },
  setAlertTimeoutForTest(ms) { alertTimeoutMs = ms; },
  isFlagged(/** @type {string} */ convId) { return flagged.has(convId); },
  flashForTest(/** @type {string} */ convId) { flashConversation(convId); },
};
// @ts-ignore — expose for integration tests to assert alert firing.
if (typeof window !== 'undefined') window.__attention = __attention;
