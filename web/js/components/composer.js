//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import './permission-controls.js';


import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/constants.js';
import slashCommandHandler from '../services/slash-command-handler.js';
import { isAnyPopupOpen } from '../utils/popup-manager.js';
import { handleEscapeKey } from '../services/escape-behaviour.js';
import { presentPopup } from '../utils/popup-surface.js';
import { CompletionMenu } from './completion-menu.js';
import { fileMentionProvider, extractFileMentionsAsync } from './file-mention-provider.js';
import { slashCommandProvider } from './slash-command-provider.js';
import {
  createSkillMentionProvider,
  getThreadSkillSnapshot,
  extractSkillMentions,
  renderSkillMenuItem,
} from './skill-mention-provider.js';
import { THREAD_ARROW_SVG, IMAGE_ATTACH_SVG, SEND_ARROW_SVG, KEBAB_SVG, CLOCK_SVG } from '../utils/icons.js';
import { showNotice } from './modal-dialog.js';
import tooltipManager from '../services/tooltip-manager.js';
import { CONTEXT_CACHE_IMPACT_CHANGED } from '../services/context-cache-impact.js';
import apiService from '../services/api.js';
import { createImageThumb } from '../utils/image-lightbox.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { isDesktopWindow } from '../../sdk/lib/window-control.js';
import {
  makeToken,
  parseTokens,
  hasTokens,
  expandPasteTokens,
  nextId as nextPasteId,
  stripStrayDelimiters,
  PASTE_TOKEN_OPEN,
  PASTE_TOKEN_CLOSE
} from '../utils/paste-tokens.js';

/**
 * Composer component for sending messages
 */

/** Maximum height (px) the prompt textarea grows to before it starts scrolling. */
const MAX_TEXTAREA_HEIGHT_PX = 400;

/**
 * Hard cap on a single message's length (characters, ~25k tokens). A message
 * is stored inline in the Yjs doc and re-sent to the model every turn, so a
 * huge paste bloats the doc and the context. This ceiling is forgiving enough
 * to never block a legitimate paste (a stack trace, a source file, a JSON
 * blob); past it the send is rejected and the user is asked to attach a file
 * instead.
 */
const MAX_MESSAGE_CHARS = 100_000;

/**
 * Fallback per-image byte ceiling — a generous upload-safety limit used when
 * the send target's provider has no specific, documented image cap (see
 * {@link PROVIDER_MAX_IMAGE_BYTES}), or when the model is automatic and the
 * provider isn't known client-side.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Per-provider hard limit on a single image's byte size, keyed by the provider
 * `name` from the providers list. Each mirrors that vendor's documented API
 * ceiling. Enforced at drop/paste/pick time so an oversized image is rejected
 * locally instead of being uploaded, attached, and rejected by the provider at
 * send time — where, because the attachment is now part of the conversation
 * history, EVERY subsequent turn re-sends it and fails the same way ("image too
 * big") until the user rewinds past the message. This is purely a size gate;
 * model *capability* is still never gated client-side (an incapable model
 * rejects at send time). Providers absent here fall back to
 * {@link MAX_ATTACHMENT_BYTES}.
 * @type {Record<string, number>}
 */
const PROVIDER_MAX_IMAGE_BYTES = {
  anthropic: 5 * 1024 * 1024, // Claude API: 5 MB per image
  claudecode: 5 * 1024 * 1024, // Claude via Claude Code — same vision limit
  openai: 20 * 1024 * 1024, // OpenAI vision: 20 MB per image
  gemini: 20 * 1024 * 1024, // Gemini inline data: 20 MB request cap
};

/** Reject a send whose attachments sum past this aggregate (bytes). */
const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * Reject any single dropped TEXT file larger than this (bytes). Much smaller
 * than the image cap: a dropped text file is inlined into the prompt as context
 * (not sent as an opaque asset), so the binding constraint is the context
 * window, not bandwidth — ~512 KB is already ~130k tokens. Enforced on
 * `file.size` BEFORE the file is read, so a multi-GB drop is rejected without
 * ever being allocated or decoded.
 */
const MAX_TEXT_DROP_BYTES = 512 * 1024;

/** Reject a drop whose text files sum past this aggregate (bytes). */
const MAX_TEXT_DROP_TURN_BYTES = 1024 * 1024;

/**
 * A pasted-text payload at or above EITHER threshold is captured into an inline
 * placeholder token instead of flooding the textarea: ~2,500 characters (about
 * one screenful) or 40 lines. Below both, the paste lands as ordinary text
 * exactly as before. Tuned by feel — a modest snippet stays inline; a source
 * file or a long log collapses to a chip.
 */
const PASTE_CHIP_MIN_CHARS = 2_500;
/** Line-count companion to {@link PASTE_CHIP_MIN_CHARS}. */
const PASTE_CHIP_MIN_LINES = 40;

/**
 * Heuristic: does a just-decoded string look like binary rather than text?
 *
 * `FileReader.readAsText` will happily decode a PDF or image into mojibake, so
 * we sample the decoded string for the two tells of a mis-decoded binary: NUL
 * bytes (never present in real text) and a high ratio of U+FFFD replacement
 * characters (what invalid UTF-8 sequences collapse to). Only the head is
 * sampled — enough to catch binaries cheaply without walking a large file.
 * @param {string} str - Decoded file contents
 * @returns {boolean} True if the content appears to be binary
 */
function looksBinary(str) {
  if (!str) return false;
  const sample = str.length > 4096 ? str.slice(0, 4096) : str;
  let replacement = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;            // NUL — decisive
    if (code === 0xfffd) replacement++;     // U+FFFD replacement char
  }
  return replacement / sample.length > 0.1;
}

/**
 * Wails' injected runtime installs a `dragover`/`drop` handler on `<html>` that
 * force-sets `dropEffect = 'none'` for file drags whenever the window's
 * `enableFileDrop` flag is off — which Juggler deliberately leaves off so WebKit
 * delivers real `File` objects to the page rather than routing drops through the
 * native bridge (see `cmd/juggler-app/app_state.go`). Because `<html>` is above
 * the composer in the bubble path, that handler runs *after* the composer's
 * own `dragover` and cancels the drop after the fact: the `drop` event never
 * fires and the image is silently rejected.
 *
 * This override listens one level higher (on `document`, which bubbles after
 * `<html>`) so it runs last and re-asserts `dropEffect = 'copy'` for file drags
 * aimed at an `composer-box`, letting the drop land in the box's own `drop` handler.
 * Installed once for the whole document, regardless of how many composers mount.
 */
let fileDropOverrideInstalled = false;
/** Install the document-level `dragover` override (see block comment above). */
function installFileDropOverride() {
  if (fileDropOverrideInstalled) return;
  fileDropOverrideInstalled = true;
  document.addEventListener('dragover', (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!dt || !Array.from(dt.types || []).includes('Files')) return;
    if (!(e.target instanceof HTMLElement) || !e.target.closest('composer-box')) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
  });
}

/**
 * The preset delay chips offered in the scheduled-send picker, tuned to the
 * primary use case: firing a command when the next LLM-provider time slice
 * opens. Minutes only — the picker's steppers cover everything in between.
 * @type {Array<{label: string, minutes: number}>}
 */
const SCHEDULE_PRESETS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '3h', minutes: 180 },
  { label: '4h', minutes: 240 },
  { label: '5h', minutes: 300 },
];

/** Granularity (minutes) of the scheduled-send picker — no finer than this. */
const SCHEDULE_MINUTE_STEP = 5;
/** Upper bound (hours) on the scheduled-send picker's hours stepper. */
const SCHEDULE_MAX_HOURS = 12;

/**
 * Format a millisecond duration as a compact countdown for the armed clock
 * button: "2h", "1h5m", "45m", or "<1m" once under a minute.
 * @param {number} ms
 * @returns {string} The compact countdown string.
 */
function formatDelayShort(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * Format an epoch-ms instant as a 24-hour wall-clock "HH:MM" — the absolute
 * time the user is actually aligning to ("sends at 14:35").
 * @param {number} epochMs
 * @returns {string} The 24-hour "HH:MM" wall-clock time.
 */
function formatClockTime(epochMs) {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

class Composer extends HTMLElement {
  constructor() {
    super();
    /** @type {boolean} @private */
    this.disabled = false;

    /** @type {boolean} @private */
    this.confirmationPending = false;

    // History navigation state
    /** @type {import('../model/session.js').default|null} @private */
    this.session = null;           // Session reference for accessing messages
    /** @type {number} @private */
    this.historyIndex = -1;        // -1 = current draft, 0+ = index into history
    /** @type {import('../model/session.js').HistoryMessage} @private */
    this.currentDraft = { content: '', attachments: [] }; // Work-in-progress (text + staged images) saved when navigating
    /** @type {Record<number, import('../model/session.js').HistoryMessage>} @private */
    this._historyEdits = {};       // Per-level edits (text + staged images) preserved across navigation

    // Draft save debounce timer
    /** @type {number|null} @private */
    this._draftSaveTimeoutId = null;

    // Conversation reference for strategy selector
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;
    /** @type {((event: any) => void)|null} @private */
    this._conversationMetadataObserver = null;

    // Thread context - when set, messages are routed to this thread's nested items
    /** @type {string|null} */
    this.threadItemId = null;

    // Column-scoped message thread
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;

    // Logical key ("conversationId::threadItemId") of the thread whose draft was
    // last restored into the textarea. Restoring writes `textarea.value`, which
    // wipes the browser's native undo stack — so the restore must be STICKY on
    // this key, not on `_messageThread` object/field state: a re-bind to the
    // same logical thread (which happens on every doc-driven rebuild, and after
    // a transient loss of the binding) must be a no-op, never a re-restore.
    /** @type {string|null} @private */
    this._restoredThreadKey = null;

    // Staged image attachments for the next send (AssetRefs from uploadAsset).
    // Populated by the paste/drag/picker UI (added in a later step); forwarded
    // on the send-message event and cleared after each dispatch.
    /** @type {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number,_uploading?:boolean,_previewURL?:string}>} @private */
    this._pendingAttachments = [];

    // Staged dropped text files for the next send. Unlike image attachments
    // (which upload to the asset store and travel as AssetRefs), these carry
    // their content inline and become `dropped-file` context items at send
    // time. Kept in a separate array precisely because they are NOT AssetRefs
    // and must never leak into the `attachments` send field.
    /** @type {Array<{filename:string,content:string,bytes:number}>} @private */
    this._pendingTextFiles = [];

    // Paste-placeholder side table: token id → captured blob. APPEND-ONLY for
    // the draft's life (never pruned when a token vanishes from the text), which
    // is what makes native undo/redo of a token airtight — any resurrected token
    // character still resolves. GC'd only at draft boundaries (send / clear /
    // thread-switch restore). See utils/paste-tokens and _capturePaste.
    /** @type {Map<number, {content:string, bytes:number}>} @private */
    this._pasteBlobs = new Map();
    // Backdrop mirror that renders the styled token pills behind a
    // transparent-text textarea. Built lazily on the first token and torn down
    // when the last token goes, so a token-free composer is a plain textarea.
    /** @type {HTMLElement|null} @private */
    this._pasteMirror = null;
    /** @type {ResizeObserver|null} @private */
    this._pasteMirrorRO = null;
    /** @type {(() => void)|null} @private selectionchange listener while mirrored */
    this._pasteSelectionListener = null;
    /** @type {boolean} @private reentrancy guard while snapping the selection */
    this._snappingSelection = false;
    // Last reconciled textarea value — the revert base for the input-time token
    // reconciler. Any input that damages a token's interior is rolled back to
    // this, so a placeholder's contents can never be edited (only deleted whole).
    /** @type {string} @private */
    this._pasteLastValue = '';
    // Last known caret offset, used to snap a collapsed caret OUT of a token in
    // the direction of travel (word/line jump into a label → bounce past it).
    /** @type {number} @private */
    this._pasteLastCaret = 0;
    // True between compositionstart/end so the reconciler and caret-snapping keep
    // hands off an in-flight IME composition.
    /** @type {boolean} @private */
    this._pasteComposing = false;

    // Scheduled-send ("send after a delay") state. The armed target is an
    // epoch-ms wall-clock time persisted on the bound thread's draft (so it
    // survives a reload and stays bound to that thread). This box only arms,
    // cancels, and DISPLAYS the schedule — the actual firing is owned by
    // scheduledSendService, which polls every thread so a send goes out even
    // when this thread isn't the one on screen. See _syncScheduledSendFromDraft.
    /** @type {number|null} @private epoch-ms target for the pending send, or null */
    this._scheduledSendAt = null;
    /** @type {number|null} @private setInterval id that refreshes the countdown label */
    this._scheduledCountdownId = null;
    /** @type {(() => void)|null} @private presentPopup release for the open delay picker */
    this._schedulePickerCleanup = null;

    // Commands menu state
    /** @type {HTMLElement|null} @private */
    this._commandsMenu = null;
    /** @type {boolean} @private */
    this._commandsMenuOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open commands menu. */
    this._popupCleanup = null;

    // Touch-only "⋮" actions sheet state (commands / attach / new thread).
    /** @type {HTMLElement|null} @private */
    this._actionsSheet = null;
    /** @type {boolean} @private */
    this._actionsSheetOpen = false;
    /** @type {(() => void)|null} @private - presentPopup release for the open actions sheet. */
    this._actionsSheetCleanup = null;
    /** @type {HTMLElement|null} @private - strategy-selector while relocated into the open sheet. */
    this._relocatedStrategy = null;

    // Initialized in setupListeners after render
    /** @type {CompletionMenu|null} @private */
    this._completions = null;

    // Stored promise from the last file-mention executeContextItem call (used by tests)
    /** @type {Promise<any>|null} */
    this._lastMentionPromise = null;

    // Test-only override for the touch-composer decision (matchMedia is
    // undrivable from the headless harness). undefined = use matchMedia.
    /** @type {boolean|undefined} @private */
    this._touchComposerOverride = undefined;

    // Guards the once-only context-cache-impact listener on `this` (setupListeners
    // reruns on every render, but this listener rides child re-renders and must
    // not stack). See setupListeners.
    /** @type {boolean} @private */
    this._impactListenerBound = false;
    /** @type {boolean} @private */
    this._cacheImpactWarning = false;
    /** @type {number|null} @private */
    this._cacheMissFlashTimeoutId = null;
    /** @type {string|null} @private */
    this._activeCacheMissSignature = null;
    /** @type {string|null} @private */
    this._cacheMissReason = null;
  }

  connectedCallback() {
    this.render();
    if (document.activeElement === document.body && !document.querySelector('conversation-bar.tab-list-focused')) {
      this.querySelector('textarea')?.focus();
    }
  }

  disconnectedCallback() {
    // Tear down an open commands menu (surface, scrim, observer, dismissal).
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    // Tear down an open actions sheet likewise.
    if (this._actionsSheetCleanup) {
      this._actionsSheetCleanup();
      this._actionsSheetCleanup = null;
    }
    // Tear down an open delay picker.
    if (this._schedulePickerCleanup) {
      this._schedulePickerCleanup();
      this._schedulePickerCleanup = null;
    }
    if (this._conversationMetadataObserver && this._conversation) {
      this._conversation.unobserveMetadata(this._conversationMetadataObserver);
      this._conversationMetadataObserver = null;
    }
    if (this._cacheMissFlashTimeoutId !== null) {
      clearTimeout(this._cacheMissFlashTimeoutId);
      this._cacheMissFlashTimeoutId = null;
    }
    // Drop the countdown-refresh interval. The target stays persisted on the
    // thread's draft, so reconnecting (or rebinding) restores the countdown —
    // and scheduledSendService fires it whether or not this box is mounted.
    this._stopScheduledCountdown();
    // Tear down the token mirror — critically, this detaches the document-level
    // selectionchange listener so a removed box leaves no dangling handler.
    this._teardownPasteMirror();
    // Release any object URLs held by in-flight upload previews.
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
  }

  setupListeners() {
    const textarea = /** @type {HTMLTextAreaElement} */ (this.querySelector('textarea'));
    if (!textarea) return;

    // Slash-command completions take precedence at the very start of a message;
    // @-file mentions apply everywhere else. Both share the one caret-anchored
    // CompletionMenu, which activates the first provider whose trigger matches.
    this._completions = new CompletionMenu({
      textarea,
      getWrapper: () => this.querySelector('composer-box-wrapper'),
      onResize: () => this.autoResize(textarea),
      // An argument-less slash command runs on the Enter/click that accepts it,
      // so accepting it submits the composer directly instead of leaving the
      // user to press Enter a second time.
      onSubmit: () => this.sendMessage(),
      // `$name` skill mentions resolve against THIS thread's frozen snapshot,
      // evaluated lazily per fetch so a later thread swap is picked up.
      providers: [
        slashCommandProvider,
        fileMentionProvider,
        createSkillMentionProvider(() => getThreadSkillSnapshot(this._messageThread)),
      ],
    });

    // Re-run autoResize whenever the textarea's width changes (e.g. column
    // drag-resize reflowing multi-line text to a different line count).
    // Two guards keep this from emitting "ResizeObserver loop completed with
    // undelivered notifications": (1) act on width only, since autoResize
    // mutates height and reacting to that would feed back into the observer;
    // (2) defer the height write to the next frame so it lands outside the
    // observer's own delivery cycle rather than mutating layout mid-delivery.
    /** @type {number|null|undefined} */
    let lastWidth = null;
    let resizeScheduled = false;
    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === lastWidth) return;
      lastWidth = width;
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        this.autoResize(textarea);
      });
    });
    resizeObserver.observe(textarea);

    // Click on the empty wrapper area focuses the textarea. Skip clicks that
    // land on a control button (or anywhere in input-controls): those must not
    // programmatically focus the textarea, because on mobile that pops the
    // onscreen keyboard just from opening a popup. On desktop the caret already
    // stays in the textarea via the mousedown preventDefault below, so skipping
    // here changes nothing there — focus still "remains" on the composer.
    const wrapper = this.querySelector('composer-box-wrapper');
    if (wrapper) {
      wrapper.addEventListener('click', (e) => {
        const target = /** @type {Element|null} */ (e.target);
        if (target && target.closest('button, .input-ctrl-btn, input-controls')) return;
        textarea.focus();
      });
    }

    // Toggling a control button (commands, strategy, model, permissions) on a
    // DESKTOP must not pull keyboard focus off the textarea: the browser focuses
    // a <button> on mousedown, so suppressing that default keeps the caret in
    // the textarea (there is no focus to "restore" because it never left).
    //
    // On TOUCH we want the opposite: opening a popup should let the textarea
    // blur so the onscreen keyboard dismisses instead of being held up. So the
    // focus-retention is gated on the pointer type of this interaction —
    // preventDefault for a real mouse, leave the default (blur) for touch/pen.
    // pointerdown fires before the compat mousedown for both, so it records the
    // type in time. click still fires either way, so the buttons' own toggle
    // handlers are unaffected. Capture phase so it runs regardless of any inner
    // stopPropagation. The menu surfaces are detached to <body>, outside
    // input-controls, so their own focusable inputs (e.g. the permission path
    // editor) are untouched by this.
    const inputControls = this.querySelector('input-controls');
    if (inputControls) {
      let lastPointerType = 'mouse';
      inputControls.addEventListener('pointerdown', (e) => {
        lastPointerType = /** @type {PointerEvent} */ (e).pointerType || 'mouse';
      }, true);
      inputControls.addEventListener('mousedown', (e) => {
        const target = /** @type {Element|null} */ (e.target);
        if (lastPointerType === 'mouse' && target && target.closest('button, .input-ctrl-btn')) {
          e.preventDefault();
        }
      }, true);
    }

    // Commands menu button
    const commandsButton = this.querySelector('#commands-button');
    if (commandsButton) {
      commandsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleCommandsMenu();
      });
    }

    // Skill picker button: a mouse-first alternative to typing `$`, mirroring the
    // commands (`/`) button. It opens a menu of this thread's skills and inserts
    // NOTHING on open or dismissal — only SELECTING a skill splices `$name ` into
    // the composer, which then flows through the identical send-time activation
    // path. Hidden when this thread has no skills (visibility refreshed on bind).
    const skillButton = this.querySelector('#skill-button');
    if (skillButton) {
      skillButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleSkillMenu();
      });
    }
    this._refreshSkillButtonVisibility();

    // Image attachments: file-picker button, paste, and drag-and-drop. All
    // three funnel image files through _handleFiles, which validates size /
    // capability and uploads to the asset store.
    const attachBtn = this.querySelector('#attach-image-button');
    const fileInput = /** @type {HTMLInputElement|null} */ (this.querySelector('.attach-file-input'));
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.click();
      });
      fileInput.addEventListener('change', () => {
        if (fileInput.files) this._handleFiles(fileInput.files);
        // Reset so selecting the same file again re-fires change.
        fileInput.value = '';
      });
    }

    // Paste image data (screenshot, copied image) — upload it and suppress the
    // default paste of those image items (avoids also pasting a filename).
    textarea.addEventListener('paste', (e) => {
      /** @type {File[]} */
      const imageFiles = [];
      for (const item of Array.from(e.clipboardData?.items || [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        this._handleFiles(imageFiles);
        return;
      }
      // Large text paste → collapse into an inline placeholder token instead of
      // flooding the textarea. Runs after the image branch (images keep
      // priority) and only for a genuinely large payload; anything smaller falls
      // through to the browser's normal text paste, unchanged.
      let pastedText = '';
      try { pastedText = e.clipboardData?.getData('text/plain') || ''; } catch { /* restricted */ }
      if (pastedText && this._shouldCapturePaste(pastedText)) {
        e.preventDefault();
        this._capturePaste(pastedText);
        return;
      }
      // WebKit desktop (WebKitGTK/WKWebView, i.e. the Wails app) routinely leaves
      // the synchronous paste event without the image file, exposing it only
      // through the async Clipboard API. Fall back to that — but only in the
      // desktop window (no clipboard-read permission prompt there) and only for a
      // text-less paste, so ordinary text pastes never read the clipboard.
      if (!isDesktopWindow()) return;
      let hasText = false;
      try { hasText = !!e.clipboardData?.getData('text/plain'); } catch { /* restricted */ }
      if (!hasText) void this._pasteImagesFromAsyncClipboard();
    });

    // Drag-and-drop image files anywhere onto the composer. The listeners
    // live on the host element (`this`) so the whole component is a drop zone —
    // including the padding around the bubble — not just the inner bubble. The
    // drag-over highlight stays on the bubble (`wrapper`) for visual feedback.
    // The document-level override below re-enables the drop, which the Wails
    // runtime otherwise cancels (see installFileDropOverride).
    installFileDropOverride();
    this.addEventListener('dragover', (e) => {
      const dt = /** @type {DragEvent} */ (e).dataTransfer;
      if (!dt || !Array.from(dt.types || []).includes('Files')) return;
      e.preventDefault();
      wrapper?.classList.add('drag-over');
    });
    this.addEventListener('dragleave', (e) => {
      // Only clear when the pointer actually leaves the host, not when it
      // crosses between the host's children (which also fire dragleave).
      if (e.target === this) wrapper?.classList.remove('drag-over');
    });
    this.addEventListener('drop', (e) => {
      wrapper?.classList.remove('drag-over');
      const dt = /** @type {DragEvent} */ (e).dataTransfer;
      const files = dt?.files;
      if (!files || files.length === 0) return;
      // Images upload to the asset store (bytes); everything else is treated as
      // a text file and inlined as a context-item snapshot. Split so a mixed
      // drop routes each kind to the right handler.
      const arr = Array.from(files);
      const images = arr.filter((f) => f.type.startsWith('image/'));
      const texts = arr.filter((f) => !f.type.startsWith('image/'));
      if (images.length === 0 && texts.length === 0) return;
      e.preventDefault();
      if (images.length > 0) this._handleFiles(images);
      if (texts.length > 0) this._handleTextFiles(texts);
    });

    // Render any chips that survived a re-render.
    this._renderAttachmentChips();

    textarea.addEventListener('keydown', (e) => {
      // Completion menu (@ mentions / slash commands) owns navigation keys while
      // open — it consumes Arrow/Enter/Tab/Escape as needed and reports back.
      if (this._completions?.handleKeydown(e)) return;

      // Paste-placeholder atomicity: a token is many characters but acts like a
      // single object under Backspace/Delete/Arrow. Skipped while composing (IME
      // safety) and a fast no-op when the box holds no tokens.
      if (!e.isComposing && this._handleTokenKeydown(e, textarea)) return;

      // Enter to send (without Shift, Alt/Option, or Meta/Command). On a touch
      // composer Enter is the onscreen keyboard's return key, so a plain Enter
      // inserts a newline (handled by the branch below) and the Send button is
      // the send affordance instead.
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !this._isTouchComposer()) {
        e.preventDefault();
        this.sendMessage();
        return;
      }

      // Insert a newline: Alt+Enter / Cmd+Enter on any composer, plus a plain
      // (unmodified) Enter on a touch composer.
      if (e.key === 'Enter' && (e.altKey || e.metaKey || (this._isTouchComposer() && !e.shiftKey))) {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + '\n' + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        this.autoResize(textarea);
        // Direct value writes don't fire input; keep the token mirror and the
        // reconciler's known-good base in step so a later edit isn't misjudged.
        this._syncPasteMirror();
        this._pasteLastValue = textarea.value;
        this._pasteLastCaret = textarea.selectionStart;
        return;
      }

      // Escape to stop the turn or clear the input
      if (e.key === 'Escape') {
        // A popup/modal open over the input owns Escape — it dismisses
        // itself via its own handler / popup-manager. Don't let the key
        // leak through to cancel a running turn or clear the input.
        if (isAnyPopupOpen()) {
          return;
        }

        e.preventDefault();

        // What Escape MEANS on a running/idle conversation is the user's choice
        // (Settings ▸ Keyboard shortcuts ▸ Escape key), so the whole decision —
        // stop, pause, two-step, clear — lives in escape-behaviour.js and is
        // shared with the conversation-area Escape. All this box contributes is
        // the vantage: a sub-thread box (threadItemId set) interrupts that
        // thread without closing it; the root box (null) stops everything.
        handleEscapeKey(e, {
          focusedThreadId: this.threadItemId ?? null,
          getComposer: () => this,
        });
        return;
      }

      // ArrowUp/Down: navigate history, but only when cursor is stuck at
      // the top/bottom. Let the browser move the cursor first, then check
      // in a microtask whether it actually moved. Any modifier (Shift for
      // selection, Alt/Ctrl/Meta for word/line jumps) means the user is
      // navigating/selecting text, so leave the keypress alone.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
                && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) {
        return;
      }

      if (e.key === 'ArrowUp') {
        const prevStart = textarea.selectionStart;
        const prevEnd = textarea.selectionEnd;
        setTimeout(() => this._navigateHistoryUp(textarea, prevStart, prevEnd), 0);
        return;
      }

      if (e.key === 'ArrowDown') {
        const prevStart = textarea.selectionStart;
        const prevEnd = textarea.selectionEnd;
        setTimeout(() => this._navigateHistoryDown(textarea, prevStart, prevEnd), 0);
        return;
      }
    });

    textarea.addEventListener('input', () => {
      // Token reconciler: reject any edit that damaged a placeholder's interior
      // (revert to the last good value) and strip orphaned delimiters, BEFORE
      // anything else reads the value. Reachable only by paths that dodge the
      // caret/selection interceptors (autocorrect/spell replace, dictation,
      // drag-drop, exotic IME) — the caret can otherwise never rest in a token.
      this._reconcileTokens(textarea);
      this.autoResize(textarea);
      this._updateSendButtonState();
      // Debounced draft save for page reload restoration
      this._scheduleDraftSave(textarea.value);
      // @ file completions
      this._completions?.handleInput();
      // Rebuild/teardown the token mirror to match the current text.
      this._syncPasteMirror();
    });
    // Paste in WKWebView updates value after the input event fires, so
    // re-run detection on the next tick to read the final pasted value.
    textarea.addEventListener('paste', () => setTimeout(() => this._completions?.handleInput(), 0));

    // IME safety: caret-snapping and the token reconciler stand down while a
    // composition is in flight (they would fight the input method).
    textarea.addEventListener('compositionstart', () => { this._pasteComposing = true; });
    textarea.addEventListener('compositionend', () => {
      this._pasteComposing = false;
      this._reconcileTokens(textarea);
      this._syncPasteMirror();
    });

    // Click on a token pill expands it back to its full content (undoable). The
    // hit-test is against the mirror's rendered pill geometry, not the caret,
    // because a click that lands inside a token is snapped to a boundary before
    // this fires — so a caret-based test would never see the interior.
    textarea.addEventListener('click', (e) => {
      if (this._pasteBlobs.size === 0 || !this._pasteMirror) return;
      const hit = this._tokenAtPoint(e.clientX, e.clientY);
      if (hit) this._expandTokenWithFeedback(textarea, hit.token, hit.span);
    });

    // Show a pointer cursor while hovering a pill. The transparent textarea sits
    // above the (pointer-events:none) mirror, so its own cursor must be swapped;
    // only meaningful while a mirror exists.
    textarea.addEventListener('mousemove', (e) => {
      if (this._pasteBlobs.size === 0 || !this._pasteMirror) {
        if (textarea.style.cursor) textarea.style.cursor = '';
        return;
      }
      const want = this._tokenAtPoint(e.clientX, e.clientY) ? 'pointer' : '';
      if (textarea.style.cursor !== want) textarea.style.cursor = want;
    });

    // Copy/cut of a selection that contains any token writes the EXPANDED text
    // to the clipboard — the sentinel characters never leave the composer.
    textarea.addEventListener('copy', (e) => this._onClipboardCopyCut(e, textarea, false));
    textarea.addEventListener('cut', (e) => this._onClipboardCopyCut(e, textarea, true));

    // Keep the mirror's scroll aligned with the textarea's.
    textarea.addEventListener('scroll', () => {
      if (this._pasteMirror) this._pasteMirror.scrollTop = textarea.scrollTop;
    });

    // Losing focus dismisses the completion menu. It is non-modal with no
    // outside-click handling — typing in the textarea is what drives it — so
    // without this a click away from the textarea would strand an open menu
    // with no path to dismiss it. Menu items accept on pointerdown +
    // preventDefault, which keeps focus in the textarea, so an accept never
    // reaches here; only a genuine focus change does.
    textarea.addEventListener('blur', () => this._completions?.close());

    // New thread button - creates thread immediately
    const threadBtn = this.querySelector('.new-thread-btn');
    if (threadBtn) {
      threadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._createThread();
      });
    }

    // Schedule-send ("send after a delay") button — opens the delay picker.
    const scheduleBtn = this.querySelector('.schedule-send-btn');
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleSchedulePicker();
      });
    }
    // A draft restored on mount may already carry a pending send — re-arm (or,
    // if its target has passed, fire) it now that the controls exist.
    this._syncScheduledSendFromDraft();

    // Send button (always visible). Send-only — cancelling a running turn is
    // the footer Stop button's job, so this never morphs into a Stop control.
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) {
      sendBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendMessage();
      });
    }

    // Context-cache warning — the round alert just before Send. The strategy
    // selector owns detection and fires a bubbling event when its classification
    // flips; mirror that onto the button's visibility. Bound once on `this`: the
    // event rides up through the child re-renders, so the listener must not stack.
    if (!this._impactListenerBound) {
      this._impactListenerBound = true;
      this.addEventListener(CONTEXT_CACHE_IMPACT_CHANGED, (e) => {
        this._cacheImpactWarning = !!(/** @type {CustomEvent} */ (e).detail?.busts);
        this._updateCacheWarningButton();
      });
    }
    // Clicking (or tapping) the warning surfaces its explanation — touch has no
    // hover, so the native-title tooltip would otherwise never appear there.
    const cacheWarnBtn = this.querySelector('#context-cache-warning');
    if (cacheWarnBtn) {
      cacheWarnBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tooltipManager.showFor(/** @type {HTMLElement} */ (cacheWarnBtn));
      });
    }

    // Touch-only "⋮" overflow button: opens the actions sheet (commands, attach
    // image, new thread) so those affordances need no inline row on a phone.
    const moreBtn = this.querySelector('#more-actions-button');
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._toggleActionsSheet();
      });
    }

    // Seed the Send button's empty/disabled state from any restored draft.
    this._updateSendButtonState();
  }

  /**
   * Whether the composer currently holds nothing sendable — no non-whitespace
   * text and no staged attachments or dropped text files. This is the single
   * definition of "empty" shared by the Send button (which can't send an empty
   * message), the schedule button (which mustn't arm a delayed send that would
   * silently fire nothing), and the "is the user mid-message?" test that decides
   * whether a conversation may pull the user to another tab.
   * @returns {boolean} True when there is nothing sendable.
   */
  isEmpty() {
    const textarea = this.querySelector('textarea');
    const hasText = !!(textarea && textarea.value.trim());
    const hasAttachments = this._resolvedAttachments().length > 0 || this._pendingTextFiles.length > 0;
    return !hasText && !hasAttachments;
  }

  /**
   * Refresh both empty-sensitive controls from the current composer contents:
   * the `.is-empty` class on the Send button (so a whitespace-only message
   * can't be sent) and the schedule button's disabled/armed look (so a delayed
   * send can't be armed on — or appear active over — an empty box). Cheap;
   * called from the textarea input handler, after programmatic text changes,
   * and on every attachment mutation.
   * @private
   */
  _updateSendButtonState() {
    const empty = this.isEmpty();
    const sendBtn = this.querySelector('#send-button');
    if (sendBtn) sendBtn.classList.toggle('is-empty', empty);
    this._updateNewThreadControls();
    // The schedule button follows the same empty rule; _updateScheduleButton
    // re-reads emptiness itself, so just re-render it.
    this._updateScheduleButton();
  }

  _updateNewThreadControls() {
    const busy = this._conversation?.isTurnActive() === true;
    const button = /** @type {HTMLButtonElement|null} */ (this.querySelector('.new-thread-btn'));
    if (button) {
      button.disabled = busy;
      button.title = busy
        ? 'Wait for the current turn to finish before creating a new thread'
        : 'Create a new sub-thread';
    }
    this.querySelectorAll('[data-command="thread"], [data-action="new-thread"]').forEach((row) => {
      row.classList.toggle('disabled', busy);
      row.setAttribute('aria-disabled', String(busy));
    });
  }

  /**
   * Flash the cache warning when the provider reports a consequential cold
   * start for this composer's thread. The worker includes the turn's shared
   * start time, making the signature stable across repeated Yjs observations
   * while still allowing a later miss with the same reason to flash again.
   * @private
   */
  _updateProviderCacheMiss() {
    const state = this._conversation?.processingState;
    const reason = typeof state?.cacheMissReason === 'string' ? state.cacheMissReason : '';
    const stateThread = state?.threadItemId || null;
    if (!reason || stateThread !== (this.threadItemId || null)) return;
    const signature = `${state?.startedAt || ''}:${stateThread || 'root'}:${reason}`;
    if (signature === this._activeCacheMissSignature) return;
    this._activeCacheMissSignature = signature;
    this._cacheMissReason = reason;
    if (this._cacheMissFlashTimeoutId !== null) clearTimeout(this._cacheMissFlashTimeoutId);
    this._cacheMissFlashTimeoutId = window.setTimeout(() => {
      this._cacheMissFlashTimeoutId = null;
      this._cacheMissReason = null;
      this._updateCacheWarningButton();
    }, 8000);
    this._updateCacheWarningButton();
  }

  /** @private */
  _updateCacheWarningButton() {
    const btn = this.querySelector('#context-cache-warning');
    if (!btn) return;
    const providerMiss = this._cacheMissReason !== null;
    const title = providerMiss
      ? `Claude Code rebuilt the context instead of using its cache. Reason: ${this._cacheMissReason}`
      : 'Items in the conversation have changed, so the next message will cause a cache-miss';
    btn.toggleAttribute('hidden', !providerMiss && !this._cacheImpactWarning);
    btn.classList.toggle('cache-miss-flash', providerMiss);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
  }

  /**
   * Whether this composer should behave as a touch composer: Enter inserts a
   * newline (the onscreen keyboard's return key) and the touch-only Send / "⋮"
   * affordances are active. Gated on a coarse pointer with no hover — the same
   * signal the CSS `@media (hover: none) and (pointer: coarse)` block keys off,
   * so the key behaviour and the layout never disagree. A narrow DESKTOP window
   * (fine pointer) keeps Enter-to-send.
   *
   * Tests can't drive `matchMedia`, so an explicit `_touchComposerOverride`
   * (true/false) wins when set — that is the only way the harness flips this.
   * @returns {boolean} True when the composer should treat Enter as newline.
   * @private
   */
  _isTouchComposer() {
    if (typeof this._touchComposerOverride === 'boolean') {
      return this._touchComposerOverride;
    }
    return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches === true;
  }

  /**
   * The persistable subset of the staged attachments: fully-uploaded refs only
   * (a resolved AssetRef has an id and is not mid-upload), stripped of the
   * UI-only preview/uploading fields. This is exactly what both a send and a
   * draft-save carry — a mid-upload placeholder has no asset to reference yet.
   * @returns {import('../utils/attachments.js').AssetRef[]} The uploaded refs (no placeholders).
   * @private
   */
  _resolvedAttachments() {
    return this._pendingAttachments
      .filter((a) => a.id && !a._uploading)
      .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
  }

  /**
   * Persist the full draft — text, staged image attachments, AND dropped text
   * files — to the thread model as one record. Called from every site that
   * mutates any part (text input, attachment add/remove/restore, text-file
   * drop/remove) so they can never drift: a quit/restart restores the whole
   * draft or nothing. Attachment/text-file changes call this immediately; text
   * changes go through the debounce below.
   * @param {string} [text] - Text to persist; defaults to the live textarea value.
   * @private
   */
  _persistDraft(text) {
    if (!this._messageThread) return;
    const value = (text !== undefined) ? text : this.getText();
    this._messageThread.draft = {
      text: value,
      attachments: this._resolvedAttachments(),
      textFiles: this._pendingTextFiles.map(({ filename, content, bytes }) => ({ filename, content, bytes })),
      // The append-only paste-blob table, so an inline placeholder survives a
      // reload / thread switch / remote client and resolves at send time.
      pasteBlobs: Array.from(this._pasteBlobs, ([id, b]) => ({ id, content: b.content, bytes: b.bytes })),
      // Preserve any armed send across the keystroke-driven draft saves — the
      // user keeps typing while a send is scheduled, and each save must not
      // drop the timer.
      scheduledSendAt: this._scheduledSendAt
    };
  }

  /**
   * Immediately persist the live textarea value, bypassing the debounce. Used by
   * page/native-window teardown, where the debounced timer may not get another
   * turn before the webview is destroyed.
   */
  flushDraft() {
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
      this._draftSaveTimeoutId = null;
    }
    this._persistDraft();
  }

  /**
   * Schedule a debounced save of the draft (text + attachments). Debounced so
   * keystrokes don't thrash the Yjs doc; attachment add/remove persist
   * immediately via _persistDraft (a discrete, infrequent event).
   * @param {string} text - Current textarea value
   * @private
   */
  _scheduleDraftSave(text) {
    // Clear any existing timeout
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
    }
    // Schedule save after debounce delay
    this._draftSaveTimeoutId = setTimeout(() => {
      this._draftSaveTimeoutId = null;
      this._persistDraft(text);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }

  /**
   * Set the textarea text and auto-resize
   * @param {string} text
   */
  setText(text) {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    // Assigning `.value` — even the same string — resets the browser's native
    // undo stack. Skip the write when the value is unchanged so a preceding
    // undoable clear (e.g. New Thread moving the draft out via
    // _clearMovedTextUndoable, then clearInput() calling setText('')) stays
    // recoverable with Ctrl/Cmd+Z instead of being wiped by the empty re-set.
    if (textarea.value !== text) textarea.value = text;
    this.autoResize(textarea);
    this._updateSendButtonState();
    // Programmatic sets (history nav, restored/moved drafts) may carry raw
    // tokens; the blob table lives on the box, so refresh the mirror to match.
    this._syncPasteMirror();
    // Re-baseline the reconciler: a programmatic write is trusted, so it becomes
    // the new known-good value (never something to revert to a stale base).
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
  }

  /**
   * Clear the textarea as an UNDOABLE edit — Ctrl/Cmd+Z restores the text — so a
   * mis-pressed Escape doesn't silently lose a drafted prompt. Assigning
   * `textarea.value = ''` wipes the browser's native undo stack; going through
   * `execCommand` on a full selection keeps the clear on that stack instead.
   * The draft is saved to history first (retrievable with ArrowUp) as a second
   * safety net. Focuses + selects the textarea because execCommand edits target
   * the focused selection, which also makes this work when the box wasn't
   * focused (e.g. Escape from an empty conversation).
   * @returns {boolean} True if there was text to clear
   */
  clearTextUndoable() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return false;
    if (textarea.value === '') return false;

    // Save the draft to history before clearing so ArrowUp can retrieve it.
    const trimmed = textarea.value.trim();
    if (trimmed && this.session) {
      this.session.addMessageToHistory({ content: trimmed, attachments: [] });
    }

    textarea.focus();
    textarea.select();
    // Clearing the box is the REQUIRED outcome; keeping it on the native undo
    // stack (Ctrl/Cmd+Z restores the draft) is the nice-to-have. So attempt the
    // undoable delete, then unconditionally force-empty if anything survived —
    // never trust execCommand's return value. `delete` on the full selection is
    // the undoable primitive; `insertText('', '')` is NOT usable here (on WebKit
    // — the desktop app — an empty insert is a no-op that still returns true, so
    // the box would silently never clear).
    document.execCommand('delete', false);
    if (textarea.value !== '') {
      textarea.value = '';
    }

    this.currentDraft = { content: '', attachments: [] };
    this.historyIndex = -1;
    this.autoResize(textarea);
    this._updateSendButtonState();
    this._scheduleDraftSave(textarea.value);
    // Cleared to empty: drop the mirror and re-baseline the reconciler (the
    // fallback value write above fires no input event of its own).
    this._syncPasteMirror();
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
    return true;
  }

  /**
   * Clear the textarea as an UNDOABLE edit WITHOUT disturbing focus — used by the
   * New Thread flow, which moves this box's text into a freshly opened thread and
   * needs that new thread's box (not this one) to end up with the keyboard.
   *
   * Unlike {@link clearTextUndoable}, this deliberately does NOT call focus() or
   * select-then-refocus: it only acts when the textarea is ALREADY the active
   * element (execCommand requires a focused, selected target), and it never
   * blurs. So the focus state is left exactly as the caller found it and the
   * subsequent column rebuild's focus lands where it should. No-op (returning
   * false) when the box isn't focused or is empty — the normal clearInput() then
   * empties it non-undoably, which is an acceptable degradation for that case.
   * @returns {boolean} True if the text was cleared undoably in place.
   * @private
   */
  _clearMovedTextUndoable() {
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea || textarea.value === '') return false;
    if (document.activeElement !== textarea) return false;

    const savedStart = textarea.selectionStart;
    const savedEnd = textarea.selectionEnd;
    textarea.select();
    // `delete` keeps the clear on the native undo stack (Ctrl/Cmd+Z restores it).
    // Not `insertText('', '')`: an empty insert is a no-op that still returns true
    // on WebKit (so the box wouldn't actually clear) and corrupts Chromium's undo
    // stack. If the host rejects the editing command there is nothing we can do
    // undoably without a focus()-based fallback, so leave it to clearInput.
    const ok = document.execCommand('delete', false);
    if (!ok) {
      try { textarea.setSelectionRange(savedStart, savedEnd); } catch { /* non-fatal */ }
      return false;
    }

    this.currentDraft = { content: '', attachments: [] };
    this.historyIndex = -1;
    this.autoResize(textarea);
    this._updateSendButtonState();
    this._syncPasteMirror();
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
    return true;
  }

  /**
   * Set the textarea to a command-supplied draft, focus it, and place the caret
   * at the end so the user can immediately continue typing. Used by user-defined
   * slash commands in 'draft' run mode (via the setDraft command side effect).
   * @param {string} text
   */
  setDraft(text) {
    this.setText(text);
    const textarea = this.querySelector('textarea');
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch {
      // setSelectionRange throws on some input types — non-fatal.
    }
  }

  /**
   * Get the current textarea text
   * @returns {string} Current text value
   */
  getText() {
    const textarea = this.querySelector('textarea');
    return textarea ? textarea.value : '';
  }

  /**
   * Auto-resize textarea to fit content
   * @param {HTMLTextAreaElement} textarea
   */
  autoResize(textarea) {
    textarea.style.overflowY = 'hidden'; // Temporarily hide scrollbar for accurate measurement
    textarea.style.height = 'auto'; // Reset height to auto to get correct scrollHeight
    const newHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
    textarea.style.height = newHeight + 'px';
    // Enable scrolling if the maximum height is reached
    textarea.style.overflowY = newHeight < MAX_TEXTAREA_HEIGHT_PX ? 'hidden' : 'auto';
  }

  /**
   * Validate and dispatch the current input as a send-message event.
   * @returns {Promise<string|null>} null when the message was dispatched;
   *   otherwise a short reason describing which guard blocked the send.
   *   Callers that must know the message went out (the test driver, most
   *   importantly) check the return value — a blocked send is otherwise
   *   indistinguishable from a sent one.
   */
  async sendMessage() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return 'no textarea';

    // Expand any inline paste placeholders to their full content at their exact
    // positions BEFORE any downstream logic. From here on `message` is the plain
    // text a normal paste would have produced, so the size cap, @-mention
    // extraction, the stored user message, and every consumer are unchanged.
    const message = expandPasteTokens(textarea.value, this._pasteBlobs).trim();
    // A staged image OR a dropped text file makes an otherwise-empty message a
    // valid send: the text files become context items ahead of the (empty) user
    // message, exactly like a caption-less image attachment.
    const hasAttachments = this._resolvedAttachments().length > 0 || this._pendingTextFiles.length > 0;

    // Block sending while confirmation is pending. An image-only message (no
    // text but staged attachments) is a valid send: the worker treats an
    // attachment-bearing message as non-empty (UserMessageInput.isEmpty) and
    // each provider omits the empty text block on the wire, so nothing forces
    // the user to type a caption.
    if ((!message && !hasAttachments) || this.disabled || this.confirmationPending) {
      return 'empty, disabled, or confirmation pending';
    }

    // Reject an oversized message. A message is stored inline in the Yjs doc
    // and re-sent to the model every turn, so a huge paste bloats the doc and
    // the context. The cap is forgiving (a stack trace, a source file, a JSON
    // blob all fit); past it the user should put the data in a file and point
    // the model at it instead.
    if (message.length > MAX_MESSAGE_CHARS) {
      this.showWarning(
        `Message is too large (${message.length.toLocaleString()} characters, ` +
        `max ${MAX_MESSAGE_CHARS.toLocaleString()}). Save it to a file and ` +
        `reference the path instead.`
      );
      return 'message too large';
    }

    // While a turn is in flight (the conversation is processing, or the
    // thread has busy items such as a running tool or an approval awaiting
    // a decision) the message is QUEUED, not refused — Conversation.sendMessage
    // forwards it to the worker, which parks it in pendingItems and drains it
    // at the next boundary. So we don't block here; we just nudge the
    // status into view so the user sees the queued bubble land.
    const visibleConv = this.session ? this.session.getVisibleConversation() : null;
    const busy = (visibleConv && visibleConv.isProcessing) ||
            (this._messageThread && this._messageThread.hasBusyItems());
    if (busy) {
      this._scrollToStatus();
    }

    // Create context items for all @-mentions AND dropped text files before
    // sending. Awaited here so these content items land BEFORE the user message.
    //
    // Where they land depends on whether this send will be QUEUED. On an idle
    // send the reads go straight into the committed items array, landing just
    // before the about-to-send message. But while a turn is in flight the
    // message is parked in the worker's pendingItems queue and only promoted at
    // the next turn boundary — so reads written into items now would be stranded
    // above the whole in-flight turn's output, with the message promoted far
    // below. When busy we therefore enqueue the reads onto the SAME pendingItems
    // queue (ahead of the worker's queued user message), so promotePendingItems
    // moves the reads and the message into items together, as a contiguous group.
    //
    // Dropped files go through the same path as mentions, differing only in that
    // they carry inline content (a `dropped-file` snapshot) rather than a path
    // the server re-reads.
    // The prose actually sent: the typed text with any `$name` skill triggers
    // removed (they become tool-calls, never prose). Reassigned in the thread
    // block below; equals `message` when there is no thread or no `$name`.
    let outgoingMessage = message;
    // Agent Skills the user explicitly chose via `$name` mentions, forwarded to
    // the worker (NOT loaded here). Resolved against THIS thread's FROZEN
    // snapshot — never the live catalog — so we only ever forward names the
    // `skill` tool will accept; unknown `$foo` is left verbatim as prose. The
    // worker loads each as a real, visible `skill` TOOL-ACTION before the turn:
    // that document-driven action is the only path that injects the SKILL.md
    // body (a plain context-item call would merely re-seed the standing
    // "## Skills" list), so the composer forwards names rather than loading.
    /** @type {string[]} */
    let skillNames = [];
    if (this._messageThread) {
      const mt = this._messageThread;

      const snapshot = await getThreadSkillSnapshot(mt);
      const extracted = extractSkillMentions(message, snapshot.map((s) => s.name));
      skillNames = extracted.names;
      outgoingMessage = extracted.text;

      // Create context items for all @-mentions AND dropped text files before
      // sending (from the trigger-stripped prose — stripping `$name` never
      // affects an `@` token). Awaited here so these land BEFORE the user message.
      const paths = await extractFileMentionsAsync(outgoingMessage);
      const textFiles = this._pendingTextFiles;
      this._pendingTextFiles = [];
      if (paths.length > 0 || textFiles.length > 0) {
        const runFile = busy
          ? (/** @type {string} */ p) => mt.executeContextItemIntoPending('file-content', { path: p })
          : (/** @type {string} */ p) => mt.executeContextItem('file-content', { path: p });
        const runDropped = busy
          ? (/** @type {{filename:string,content:string}} */ t) =>
            mt.executeContextItemIntoPending('dropped-file', { filename: t.filename, content: t.content })
          : (/** @type {{filename:string,content:string}} */ t) =>
            mt.executeContextItem('dropped-file', { filename: t.filename, content: t.content });
        this._lastMentionPromise = Promise.all([
          ...paths.map(runFile),
          ...textFiles.map(runDropped)
        ]);
        await this._lastMentionPromise;
      }
      this._renderAttachmentChips();
    }

    // The Conversation calls clearInput() after successful validation, so the
    // message survives in the textarea if the send fails.
    // Forward any attachments staged on this composer (populated by the
    // paste/drag/picker UI in a later step). Pass a copy and clear after
    // dispatch so the next message starts empty.
    // Only forward fully-uploaded attachments (a resolved AssetRef has an id);
    // strip the UI-only preview/uploading fields before they leave the box.
    const attachments = this._pendingAttachments
      .filter((a) => a.id && !a._uploading)
      .map(({ id, mime, filename, bytes, width, height }) => ({ id, mime, filename, bytes, width, height }));
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
    this._pendingAttachments = [];
    this._renderAttachmentChips();
    this.dispatchEvent(new CustomEvent('send-message', {
      detail: {
        message: outgoingMessage,
        threadItemId: this.threadItemId || null,
        messageThread: this._messageThread || null,
        attachments,
        skills: skillNames
      },
      bubbles: true,
      composed: true
    }));
    return null;
  }

  /**
   * Clear the input field after message is accepted
   * Called by Conversation after successful validation
   */
  clearInput() {
    const textarea = this.querySelector('textarea');
    if (!textarea) return;

    // Dismiss any open completion popup (@ mentions / slash commands). A send
    // via Enter keeps focus in the textarea, so the blur handler that normally
    // closes the menu never fires — without this, submitting a command like
    // `/clear` with nothing highlighted leaves the popup stranded over the now
    // empty box. Every successful send funnels through here, so this covers the
    // Enter, touch Send button, and scheduled-flush paths alike.
    this._completions?.close();

    // Reset history navigation state
    this.historyIndex = -1;
    this.currentDraft = { content: '', attachments: [] };
    this._historyEdits = {};

    // Drop any staged text files — they were flushed into context items at send.
    this._pendingTextFiles = [];

    // GC the paste-blob side table and tear down the mirror — this draft is done,
    // so the append-only table's life ends here (a fresh draft starts empty).
    this._pasteBlobs = new Map();
    this._teardownPasteMirror();
    this._pasteLastValue = '';
    this._pasteLastCaret = 0;

    // Clear any pending draft save and clear the saved draft (text +
    // attachments) as one unit.
    if (this._draftSaveTimeoutId !== null) {
      clearTimeout(this._draftSaveTimeoutId);
      this._draftSaveTimeoutId = null;
    }
    if (this._messageThread) {
      this._messageThread.draft = null;
    }

    // Sending (or otherwise clearing) the box consumes any armed scheduled send:
    // the draft it was attached to is now gone. Drop the in-memory target and
    // countdown too — otherwise the button stays visually "armed", and the next
    // keystroke's _persistDraft would re-attach the stale target to a fresh,
    // unrelated draft and fire it. The draft was just nulled above, so this
    // resets in-memory state only (no re-persist needed).
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._updateScheduleButton();

    // Clear input; callers manage focus explicitly.
    this.setText('');
  }

  /**
   * Set disabled state for the input
   * @param {boolean} disabled
   */
  setDisabled(disabled) {
    this.disabled = disabled;
    const textarea = this.querySelector('textarea');

    if (textarea) textarea.disabled = disabled;
  }

  /**
   * Set confirmation pending state
   * @param {boolean} pending - Whether a confirmation is pending
   */
  setConfirmationPending(pending) {
    this.confirmationPending = pending;
    const textarea = this.querySelector('textarea');

    if (textarea) {
      if (pending) {
        textarea.setAttribute('data-confirmation-pending', 'true');
      } else {
        textarea.removeAttribute('data-confirmation-pending');
      }
    }
  }

  /**
   * Set blocked state (e.g., during action approval)
   * Disables input and shows a status message
   * @param {boolean} blocked - Whether input is blocked
   * @param {string} [reason] - Reason for blocking (e.g., "Waiting for approval...")
   */
  setBlocked(blocked, reason = '') {
    const textarea = this.querySelector('textarea');

    if (textarea) {
      if (blocked) {
        textarea.disabled = true;
        textarea.placeholder = reason || 'Input blocked...';
        textarea.setAttribute('data-blocked', 'true');
      } else {
        textarea.disabled = false;
        // On a touch composer Enter inserts a newline, so the desktop
        // "Shift+Enter for new line" hint would be wrong there.
        textarea.placeholder = this._isTouchComposer()
          ? 'Type your message...'
          : 'Type your message... (Shift+Enter for new line)';
        textarea.removeAttribute('data-blocked');
      }
    }
  }

  /**
   * Set the session reference for accessing message history
   * @param {import('../model/session.js').default} session - Session instance
   */
  setSession(session) {
    this.session = session;
  }

  /**
   * Set the conversation reference for the strategy selector and permission controls
   * @param {import('../model/conversation.js').default|null} conversation - Conversation instance
   */
  setConversation(conversation) {
    const conversationChanged = this._conversation !== conversation;
    if (this._conversationMetadataObserver && this._conversation) {
      this._conversation.unobserveMetadata(this._conversationMetadataObserver);
    }
    if (conversationChanged) {
      if (this._cacheMissFlashTimeoutId !== null) clearTimeout(this._cacheMissFlashTimeoutId);
      this._cacheMissFlashTimeoutId = null;
      this._activeCacheMissSignature = null;
      this._cacheMissReason = null;
    }
    this._conversation = conversation;
    this._conversationMetadataObserver = null;
    if (conversation) {
      this._conversationMetadataObserver = (event) => {
        if (event.keysChanged?.has?.('processingState')) {
          this._updateNewThreadControls();
          this._updateProviderCacheMiss();
        }
      };
      conversation.observeMetadata(this._conversationMetadataObserver);
    }
    this._updateNewThreadControls();
    this._updateProviderCacheMiss();

    const permissionControls = this.querySelector('permission-controls');
    if (permissionControls && 'setMessageThread' in permissionControls) {
      /** @type {HTMLElement & {setMessageThread: function(import('../model/message-thread.js').default|null): void}} */
      (permissionControls).setMessageThread(this._messageThread);
    }
    const modelSelector = this.querySelector('model-selector');
    if (modelSelector && 'setConversation' in modelSelector) {
      /** @type {any} */ (modelSelector).setConversation(this._conversation);
    }

  }

  /**
   * Bind the strategy selector to this composer's thread. Strategy is
   * per-thread with walk-up inheritance: a sub-thread shows its effective
   * strategy (inherited from the conversation unless it sets its own override),
   * and selecting one writes to the bound thread (MessageThread.setStrategy).
   * @private
   */
  _syncStrategySelector() {
    const strategySelector = this.querySelector('strategy-selector');
    if (!strategySelector || !('setMessageThread' in strategySelector)) return;
    /** @type {{setMessageThread: function(import('../model/message-thread.js').default|null): void}} */
    (strategySelector).setMessageThread(this._messageThread);
  }

  /**
   * Set the message thread for this composer
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    // Key on LOGICAL identity (conversation + thread item), and make the guard
    // STICKY via `_restoredThreadKey`: a sub-thread column rebuilds a fresh
    // MessageThread wrapper for the SAME underlying thread on every doc update,
    // and the binding can transiently reset — either would make an
    // object/field-identity check think the thread is new, re-run the restore
    // below, and reset the textarea to the last debounce-saved draft, clobbering
    // in-flight typing AND wiping the native undo stack. Restoring only when the
    // logical key genuinely changes means a same-thread re-bind never touches
    // the textarea. Restore the draft only on a real switch to a different thread.
    const key = `${messageThread.conversationId}::${messageThread.threadItemId ?? 'root'}`;
    const isNewThread = this._restoredThreadKey !== key;

    // Switching away from a previously-bound thread: flush its live draft first,
    // so in-flight typing isn't stranded by the keystroke debounce (which may
    // not have fired). Guarded — the outgoing thread's container may already be
    // gone (a closed/deleted sub-thread), and losing the flush there is benign.
    if (isNewThread && this._messageThread && this._restoredThreadKey !== null) {
      try {
        this.flushDraft();
      } catch { /* outgoing thread torn down — nothing to preserve */ }
    }

    this._messageThread = messageThread;
    this.threadItemId = messageThread.threadItemId;
    this._updateProviderCacheMiss();

    this._syncStrategySelector();

    this._refreshSkillButtonVisibility();

    const modelSelector = this.querySelector('model-selector');
    if (modelSelector && 'setMessageThread' in modelSelector) {
      /** @type {any} */ (modelSelector).setMessageThread(messageThread);
    }

    // Restore the draft when switching to a new thread — text AND attachments,
    // as one unit (they were persisted together). Stage the attachments
    // without re-persisting (we're reading from the model, not changing it).
    if (isNewThread) {
      // Mark this thread's draft as restored BEFORE the writes below, so any
      // re-entrant/rebuild bind that lands mid-restore sees the key and skips.
      this._restoredThreadKey = key;
      const draft = messageThread.draft;
      this._stagePendingAttachments(draft.attachments);
      this._stagePendingTextFiles(draft.textFiles);
      // Restore the append-only paste-blob table for this thread before staging
      // its text, so any inline placeholder in that text resolves and renders.
      this._pasteBlobs = new Map((draft.pasteBlobs || []).map((b) => [b.id, { content: b.content, bytes: b.bytes }]));
      const textarea = this.querySelector('textarea');
      if (textarea) {
        const draftText = draft.text || '';
        if (textarea.value !== draftText) {
          textarea.value = draftText;
        }
        // Rebuild (or tear down) the token mirror for the newly-bound thread.
        this._syncPasteMirror();
        // Baseline the reconciler on the restored text (trusted).
        this._pasteLastValue = textarea.value;
        this._pasteLastCaret = textarea.selectionStart;
        textarea.style.height = 'auto';
        const attemptResize = (/** @type {number} */ attempts) => {
          if (textarea.offsetHeight > 0) {
            this.autoResize(textarea);
          } else if (attempts < 5) {
            requestAnimationFrame(() => attemptResize(attempts + 1));
          }
        };
        // Settle synchronously when the textarea is already laid out (the
        // tab-switch case) so the column's scroll-to-bottom runs against a
        // stable composer-box height instead of a still-growing one — otherwise
        // the textarea inflates a few frames later and shoves the footer
        // below the fold. Re-assert after layout for the not-yet-sized case
        // (and to correct any width-dependent wrap measurement).
        attemptResize(0);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => attemptResize(0));
        });
      }
      // Rebind the scheduled-send timer to the newly-bound thread: cancel the
      // previous thread's live timer and re-arm from THIS thread's persisted
      // draft (firing at once if its target already passed).
      this._syncScheduledSendFromDraft();
    }
  }

  /**
   * Get user message history from session (most recent first).
   * @returns {import('../model/session.js').HistoryMessage[]} History entries, newest first.
   */
  getUserHistory() {
    if (!this.session) return [];

    // Return session-level message history (shared across all conversations)
    // Reverse for arrow-up navigation (most recent first)
    return [...this.session.messageHistory].reverse();
  }

  /**
   * Snapshot the live composer as a history level: its text plus the currently
   * staged (uploaded) image attachments. Used to preserve the -1 draft and any
   * per-level edits before navigating away from them.
   * @returns {import('../model/session.js').HistoryMessage} The composer's current text and staged attachments.
   * @private
   */
  _snapshotComposerLevel() {
    return { content: this.getText(), attachments: this._resolvedAttachments() };
  }

  /**
   * Load a history level into the composer: set the text, re-stage its image
   * attachments as chips (a GC'd asset simply renders broken and is dropped at
   * send), park the caret at the end, and persist the whole draft.
   * @param {HTMLTextAreaElement} textarea
   * @param {import('../model/session.js').HistoryMessage} entry
   * @private
   */
  _applyHistoryLevel(textarea, entry) {
    this.setText(entry.content);
    this._stagePendingAttachments(entry.attachments || []);
    textarea.selectionStart = textarea.selectionEnd = entry.content.length;
    this._scheduleDraftSave(textarea.value);
  }

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {number} prevStart
   * @param {number} prevEnd
   * @private
   */
  _navigateHistoryUp(textarea, prevStart, prevEnd) {
    if (this._completions?.isActive()) return;
    if (textarea.selectionStart !== prevStart || textarea.selectionEnd !== prevEnd) return;
    const history = this.getUserHistory();
    if (history.length === 0) return;
    // Preserve the level we're leaving: the work-in-progress draft at -1,
    // otherwise this level's in-place edit (text + staged attachments).
    if (this.historyIndex === -1) {
      this.currentDraft = this._snapshotComposerLevel();
    } else {
      this._historyEdits[this.historyIndex] = this._snapshotComposerLevel();
    }
    if (this.historyIndex < history.length - 1) {
      this.historyIndex++;
      const entry = /** @type {import('../model/session.js').HistoryMessage} */ (
        this._historyEdits[this.historyIndex] !== undefined
          ? this._historyEdits[this.historyIndex]
          : history[this.historyIndex]);
      this._applyHistoryLevel(textarea, entry);
    }
  }

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {number} prevStart
   * @param {number} prevEnd
   * @private
   */
  _navigateHistoryDown(textarea, prevStart, prevEnd) {
    if (this._completions?.isActive()) return;
    if (textarea.selectionStart !== prevStart || textarea.selectionEnd !== prevEnd) return;
    if (this.historyIndex > -1) {
      this._historyEdits[this.historyIndex] = this._snapshotComposerLevel();
      this.historyIndex--;
      /** @type {import('../model/session.js').HistoryMessage} */
      let entry;
      if (this.historyIndex === -1) {
        entry = this.currentDraft;
      } else {
        const history = this.getUserHistory();
        entry = /** @type {import('../model/session.js').HistoryMessage} */ (
          this._historyEdits[this.historyIndex] !== undefined
            ? this._historyEdits[this.historyIndex]
            : history[this.historyIndex]);
      }
      this._applyHistoryLevel(textarea, entry);
    }
  }

  /**
   * Show a prominent, transient warning notice to the user. Delegates to the
   * app-level `showNotice` (a centered modal-dialog): the composer owns no
   * warning state of its own.
   * @param {string} message - Warning message to display
   * @param {number} [duration=5000] - Duration to show warning in milliseconds (0 = manual dismissal only)
   */
  showWarning(message, duration = 5000) {
    showNotice(message, { duration });
  }

  /**
   * Scroll the parent conversation-area's footer into view.
   * Called when send is blocked so the user can see what's happening.
   * @private
   */
  _scrollToStatus() {
    const convArea = this.closest('conversation-area');
    if (!convArea) return;
    const footer = convArea.querySelector('conversation-footer');
    if (footer) {
      footer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ========================================================================
  // IMAGE ATTACHMENTS
  // ========================================================================

  /**
   * The per-image byte ceiling for the model this composer will send to.
   * Resolves the effective provider (thread override → conversation default)
   * and returns its documented per-image limit ({@link PROVIDER_MAX_IMAGE_BYTES}),
   * falling back to {@link MAX_ATTACHMENT_BYTES} when the provider has no
   * specific limit or the model is automatic (provider unknown client-side).
   * @returns {number} Max bytes for a single image attachment.
   * @private
   */
  _maxImageBytes() {
    const cfg = this._messageThread?.getEffectiveModelConfig?.()
      || this._conversation?.modelConfig
      || null;
    const provider = cfg && cfg.provider ? cfg.provider : '';
    return PROVIDER_MAX_IMAGE_BYTES[provider] || MAX_ATTACHMENT_BYTES;
  }

  /**
   * Fallback image paste for WebKit desktop windows (WebKitGTK/WKWebView, i.e.
   * the Wails app), whose synchronous `paste` event omits the image file and
   * exposes it only through the async Clipboard API. Materialises any image
   * entries as `File`s and routes them through the same {@link _handleFiles}
   * path as sync paste / drop / picker. Best-effort: a missing API or a
   * clipboard with no image is a silent no-op, so it can only add successful
   * pastes, never break one.
   * @returns {Promise<void>}
   * @private
   */
  async _pasteImagesFromAsyncClipboard() {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.read !== 'function') return;
    let clipboardItems;
    try {
      clipboardItems = await clipboard.read();
    } catch {
      return; // no permission, insecure context, or nothing readable
    }
    /** @type {File[]} */
    const files = [];
    for (const item of clipboardItems) {
      const type = Array.from(item.types || []).find((t) => t.startsWith('image/'));
      if (!type) continue;
      try {
        const blob = await item.getType(type);
        const ext = type.split('/')[1] || 'png';
        files.push(new window.File([blob], `pasted-image-${files.length + 1}.${ext}`, { type }));
      } catch { /* skip an entry we can't materialise; keep any others */ }
    }
    if (files.length > 0) this._handleFiles(files);
  }

  /**
   * Validate and upload a set of dropped/pasted/picked files, pushing each
   * successful upload onto _pendingAttachments. Non-image files are ignored;
   * oversized files (single or aggregate) are rejected with a warning.
   *
   * Image attachments are staged regardless of the current model's *capability*
   * — that is never gated client-side; a model that can't accept images rejects
   * the request at send time. Image *size* IS gated here, to the send target's
   * per-provider limit ({@link _maxImageBytes}), so an image the provider would
   * reject never enters the conversation in the first place.
   * @param {FileList|File[]} fileList
   * @private
   */
  _handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type && f.type.startsWith('image/'));
    if (files.length === 0) return;

    const maxPerImage = this._maxImageBytes();

    for (const file of files) {
      if (file.size > maxPerImage) {
        this.showWarning(
          `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB, ` +
          `max ${maxPerImage / 1024 / 1024} MB per image for the current model).`
        );
        continue;
      }
      const pendingTotal = this._pendingAttachments.reduce((sum, a) => sum + (a.bytes || 0), 0);
      if (pendingTotal + file.size > MAX_TURN_ATTACHMENT_BYTES) {
        this.showWarning(
          `Attachments exceed the ${MAX_TURN_ATTACHMENT_BYTES / 1024 / 1024} MB ` +
          `per-message limit.`
        );
        break;
      }
      this._uploadAndAdd(file);
    }
  }

  /**
   * Validate and stage a set of dropped non-image files as text snapshots.
   *
   * Three gates, in order:
   *  1. per-file size — checked on `file.size` BEFORE any read, so a multi-GB
   *     drop is rejected without ever being allocated or decoded;
   *  2. aggregate size — the drop's text files may not sum past the per-message
   *     limit (counting already-staged files);
   *  3. binary — after decoding a known-small file, reject anything that looks
   *     binary rather than text ({@link looksBinary}).
   *
   * Survivors are pushed onto `_pendingTextFiles` and become `dropped-file`
   * context items at send time.
   * @param {FileList|File[]} fileList
   * @private
   */
  _handleTextFiles(fileList) {
    for (const file of Array.from(fileList)) {
      // Gate 1: size, on metadata, before reading a single byte.
      if (file.size > MAX_TEXT_DROP_BYTES) {
        this.showWarning(
          `"${file.name}" is too large to attach as text ` +
          `(${(file.size / 1024 / 1024).toFixed(1)} MB, ` +
          `max ${MAX_TEXT_DROP_BYTES / 1024} KB).`
        );
        continue;
      }
      // Gate 2: aggregate across already-staged text files.
      const stagedTotal = this._pendingTextFiles.reduce((sum, t) => sum + (t.bytes || 0), 0);
      if (stagedTotal + file.size > MAX_TEXT_DROP_TURN_BYTES) {
        this.showWarning(
          `Dropped text files exceed the ${MAX_TEXT_DROP_TURN_BYTES / 1024 / 1024} MB ` +
          `per-message limit.`
        );
        break;
      }

      const reader = new window.FileReader();
      reader.onload = () => {
        // readAsText yields a string; guard the union type without String().
        const content = typeof reader.result === 'string' ? reader.result : '';
        // Gate 3: binary check (file is already known-small, so this is cheap).
        if (looksBinary(content)) {
          this.showWarning(`"${file.name}" doesn't look like a text file.`);
          return;
        }
        this._pendingTextFiles.push({ filename: file.name, content, bytes: file.size });
        this._renderAttachmentChips();
        // Persist so the staged file survives a reload alongside the text.
        this._persistDraft();
      };
      reader.onerror = () => this.showWarning(`Couldn't read "${file.name}".`);
      reader.readAsText(file);
    }
  }

  /**
   * Remove a staged dropped text file and re-render the chip row.
   * @param {{filename:string,content:string,bytes:number}} entry
   * @private
   */
  _removeTextFile(entry) {
    const idx = this._pendingTextFiles.indexOf(entry);
    if (idx === -1) return;
    this._pendingTextFiles.splice(idx, 1);
    this._renderAttachmentChips();
    this._persistDraft();
  }

  // ========================================================================
  // PASTE PLACEHOLDERS
  //
  // A large paste collapses into an inline placeholder token — a run of
  // ordinary characters (invisible delimiters bracketing a visible label) that
  // behaves as text in every way (undoable, single-backspace-deletable,
  // selectable, copyable) yet renders as a styled pill. The full content lives
  // in the append-only _pasteBlobs table and is inlined at its exact position
  // at send time, so the model/stored message is identical to a plain paste.
  // See utils/paste-tokens for the grammar and the pure helpers.
  // ========================================================================

  /**
   * Whether a pasted text payload is large enough to capture into a placeholder
   * token rather than land as ordinary text. Either threshold trips it; a
   * payload that decodes as binary is also captured (defensive — don't flood the
   * box with mojibake).
   * @param {string} text
   * @returns {boolean} True to capture, false to paste normally.
   * @private
   */
  _shouldCapturePaste(text) {
    if (looksBinary(text)) return true;
    if (text.length >= PASTE_CHIP_MIN_CHARS) return true;
    // Count newlines rather than splitting (cheaper on a big blob).
    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
    return lines >= PASTE_CHIP_MIN_LINES;
  }

  /**
   * UTF-8 byte size of a string, for the token label.
   * @param {string} str
   * @returns {number} Byte length.
   * @private
   */
  _pasteByteLength(str) {
    try { return new Blob([str]).size; } catch { return str.length; }
  }

  /**
   * Capture `content` as an inline placeholder: allocate (or reuse, on an exact
   * content match) a token id, store the blob, and insert the token string at
   * the caret. The insert goes through the native editing path so Cmd+Z undoes
   * the capture as one edit; the blob stays in the append-only table until GC.
   * @param {string} content
   * @private
   */
  _capturePaste(content) {
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea) return;
    const bytes = this._pasteByteLength(content);
    // Dedup: identical content already captured reuses that id (double-paste
    // gives two tokens sharing one blob; both expand at send). Exact === only.
    let id = null;
    for (const [existingId, blob] of this._pasteBlobs) {
      if (blob.content === content) { id = existingId; break; }
    }
    if (id === null) {
      id = nextPasteId(textarea.value, this._pasteBlobs);
      this._pasteBlobs.set(id, { content, bytes });
    }
    this._insertAtCaret(textarea, makeToken(id, bytes));
    this._afterTokenMutation(textarea);
  }

  /**
   * Insert `text` at the caret, preferring the native undoable path
   * (execCommand) and falling back to a direct value splice where the host
   * rejects the command (older engines, headless test window). Leaves the caret
   * after the inserted text.
   * @param {HTMLTextAreaElement} textarea
   * @param {string} text
   * @private
   */
  _insertAtCaret(textarea, text) {
    textarea.focus();
    const before = textarea.value;
    // Baseline the reconciler to the pre-insert value: execCommand fires `input`
    // synchronously below, and it must compare against what the box holds NOW —
    // never a stale base that would make it revert this trusted insert.
    this._pasteLastValue = before;
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (ok && textarea.value !== before) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = before.slice(0, start) + text + before.slice(end);
    const pos = start + text.length;
    try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
  }

  /**
   * Delete the `[start, end)` character range, preferring the native undoable
   * path (select + execCommand('delete')) with a direct-splice fallback.
   * @param {HTMLTextAreaElement} textarea
   * @param {number} start
   * @param {number} end
   * @private
   */
  _deleteRange(textarea, start, end) {
    textarea.focus();
    const before = textarea.value;
    // Baseline the reconciler to the pre-delete value (see _insertAtCaret): the
    // token in [start, end) is fully inside the change, so the delete reads as
    // legitimate rather than a partial-interior edit to revert.
    this._pasteLastValue = before;
    try { textarea.setSelectionRange(start, end); } catch { /* non-fatal */ }
    let ok = false;
    try { ok = document.execCommand('delete', false); } catch { ok = false; }
    if (!ok || textarea.value === before) {
      textarea.value = before.slice(0, start) + before.slice(end);
      try { textarea.setSelectionRange(start, start); } catch { /* non-fatal */ }
    }
    this._afterTokenMutation(textarea);
  }

  /**
   * Replace a token with its full content in place (undoable). Cmd+Z afterwards
   * restores the placeholder: the token characters come back and the append-only
   * table still resolves them.
   * @param {HTMLTextAreaElement} textarea
   * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
   * @private
   */
  _expandToken(textarea, tok) {
    const entry = this._pasteBlobs.get(tok.id);
    const content = entry ? entry.content : tok.text.slice(1, -1);
    textarea.focus();
    try { textarea.setSelectionRange(tok.start, tok.end); } catch { /* non-fatal */ }
    const before = textarea.value;
    // Baseline the reconciler to the pre-expand value (see _insertAtCaret): the
    // token is fully inside the replaced range, so expansion reads as legitimate.
    this._pasteLastValue = before;
    let ok = false;
    try { ok = document.execCommand('insertText', false, content); } catch { ok = false; }
    if (!ok || textarea.value === before) {
      textarea.value = before.slice(0, tok.start) + content + before.slice(tok.end);
      const pos = tok.start + content.length;
      try { textarea.setSelectionRange(pos, pos); } catch { /* non-fatal */ }
    }
    this._afterTokenMutation(textarea);
  }

  /**
   * Atomicity for placeholder tokens under Backspace/Delete/Arrow keys. Returns
   * true (and prevents the default) when it acted on a token, false to let the
   * key behave normally. A fast no-op when the text holds no tokens.
   * @param {KeyboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   * @returns {boolean} Whether the key was handled as a token operation.
   * @private
   */
  _handleTokenKeydown(e, textarea) {
    const key = e.key;
    if (key !== 'Backspace' && key !== 'Delete' && key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
    const value = textarea.value;
    if (!hasTokens(value)) return false;
    const collapsed = textarea.selectionStart === textarea.selectionEnd;
    if (!collapsed) return false; // selection-based edits: snapping keeps endpoints out
    const p = textarea.selectionStart;
    const tokens = parseTokens(value);

    if (key === 'Backspace' || key === 'Delete') {
      // Shift/Ctrl deletes keep native behaviour (the reconciler backstops any
      // partial cut). A plain, word (Alt) or line (Meta) delete that ABUTS a
      // token in the delete direction would otherwise chew into the label, so
      // remove the whole token as one unit instead.
      if (e.shiftKey || e.ctrlKey) return false;
      const tok = key === 'Backspace'
        ? tokens.find((t) => t.end === p)
        : tokens.find((t) => t.start === p);
      if (!tok) return false;
      e.preventDefault();
      this._deleteRange(textarea, tok.start, tok.end);
      return true;
    }

    // Plain arrows skip a token as one unit. Modified arrows (word/line move,
    // shift-select) fall through to native motion; the selection-snapper then
    // bounces any caret/endpoint that landed inside a token back to a boundary.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
    const tok = key === 'ArrowLeft'
      ? tokens.find((t) => t.end === p)
      : tokens.find((t) => t.start === p);
    if (!tok) return false;
    e.preventDefault();
    const to = key === 'ArrowLeft' ? tok.start : tok.end;
    try { textarea.setSelectionRange(to, to); } catch { /* non-fatal */ }
    this._pasteLastCaret = to;
    return true;
  }

  /**
   * copy/cut handler: when the selection contains any token, write the EXPANDED
   * text (tokens replaced by their content) to the clipboard and, for cut,
   * delete the selection undoably. When the selection holds no token the browser
   * does its normal thing. This keeps sentinel characters from ever leaving the
   * composer — a paste back into another Juggler box re-captures naturally.
   * @param {ClipboardEvent} e
   * @param {HTMLTextAreaElement} textarea
   * @param {boolean} isCut
   * @private
   */
  _onClipboardCopyCut(e, textarea, isCut) {
    if (this._pasteBlobs.size === 0) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return;
    const selected = textarea.value.slice(start, end);
    if (!hasTokens(selected)) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    const expanded = expandPasteTokens(selected, this._pasteBlobs);
    e.clipboardData.setData('text/plain', expanded);
    if (isCut) this._deleteRange(textarea, start, end);
  }

  /**
   * Length of the common leading run of two strings.
   * @param {string} a
   * @param {string} b
   * @returns {number} The shared-prefix length.
   * @private
   */
  _commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  /**
   * Whether the single contiguous edit that turned `prev` into `cur` cut into a
   * token's interior (as opposed to leaving tokens whole — typing outside them,
   * or deleting one entirely). A textarea `input` is always one contiguous
   * replacement, so the changed span in `prev` is `[prefix, prev.len - suffix)`;
   * a token that overlaps that span but isn't fully inside it was damaged.
   * @param {string} prev - The last known-good value.
   * @param {string} cur - The current value after the edit.
   * @returns {{start:number, end:number}|null} The damaged span in `prev`, or null.
   * @private
   */
  _damagedTokenSpan(prev, cur) {
    const pre = this._commonPrefixLen(prev, cur);
    let sfx = 0;
    const maxSfx = Math.min(prev.length - pre, cur.length - pre);
    while (sfx < maxSfx && prev[prev.length - 1 - sfx] === cur[cur.length - 1 - sfx]) sfx++;
    const chgStart = pre;
    const chgEnd = prev.length - sfx; // [chgStart, chgEnd) is the edited span in prev
    for (const t of parseTokens(prev)) {
      const overlaps = t.start < chgEnd && t.end > chgStart;
      const contained = t.start >= chgStart && t.end <= chgEnd;
      if (overlaps && !contained) return t;
    }
    return null;
  }

  /**
   * Reconcile the textarea after an `input` so a placeholder's contents can never
   * be edited — only deleted whole. Two layers:
   *  1. If the edit cut into a token's interior (a path that dodged the
   *     caret/selection interceptors — autocorrect, dictation, drag-drop, exotic
   *     IME), REVERT to the last known-good value: the edit simply doesn't take,
   *     and the captured content is never silently lost.
   *  2. Otherwise strip any orphaned delimiter characters as a final safety net,
   *     then adopt the current value as the new known-good base.
   * @param {HTMLTextAreaElement} textarea
   * @returns {boolean} True if the value was changed (reverted or cleaned).
   * @private
   */
  _reconcileTokens(textarea) {
    const cur = textarea.value;
    const prev = this._pasteLastValue;
    const curHasDelims = cur.indexOf(PASTE_TOKEN_OPEN) !== -1 || cur.indexOf(PASTE_TOKEN_CLOSE) !== -1;
    // Fast path: no tokens are or were in play — nothing to guard.
    if (!curHasDelims && !hasTokens(prev)) { this._pasteLastValue = cur; return false; }

    if (!this._pasteComposing && hasTokens(prev)) {
      const damaged = this._damagedTokenSpan(prev, cur);
      if (damaged) {
        // Reject the edit: restore the last good value, park the caret at the
        // start of the token that was hit (a boundary, never its interior).
        this._snappingSelection = true;
        textarea.value = prev;
        try { textarea.setSelectionRange(damaged.start, damaged.start); } catch { /* non-fatal */ }
        this._snappingSelection = false;
        this._pasteLastValue = prev;
        this._pasteLastCaret = damaged.start;
        return true;
      }
    }

    // Edit is legitimate. Strip any stray delimiters (half a token left by a
    // path this couldn't revert) and adopt the result as the new base.
    const cleaned = stripStrayDelimiters(cur, this._pasteBlobs);
    if (cleaned !== cur) {
      const at = Math.min(textarea.selectionStart, cleaned.length);
      textarea.value = cleaned;
      try { textarea.setSelectionRange(at, at); } catch { /* non-fatal */ }
      this._pasteLastValue = cleaned;
      this._pasteLastCaret = at;
      return true;
    }
    this._pasteLastValue = cur;
    this._pasteLastCaret = textarea.selectionStart;
    return false;
  }

  /**
   * Hit-test a viewport point against the mirror's rendered token pills, mapping
   * a hit to its token in text order. Used for click-to-expand, which can't rely
   * on the caret (a click inside a token is snapped to a boundary before `click`
   * fires).
   * @param {number} x - Client X.
   * @param {number} y - Client Y.
   * @returns {{token: import('../utils/paste-tokens.js').PasteTokenMatch, span: Element}|null}
   *   The hit token and its rendered pill span, or null.
   * @private
   */
  _tokenAtPoint(x, y) {
    if (!this._pasteMirror) return null;
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea) return null;
    const spans = this._pasteMirror.querySelectorAll('.paste-token');
    const tokens = parseTokens(textarea.value);
    const n = Math.min(spans.length, tokens.length);
    for (let i = 0; i < n; i++) {
      const span = spans[i];
      const tok = tokens[i];
      if (!span || !tok) continue;
      const r = span.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { token: tok, span };
    }
    return null;
  }

  /**
   * Expand a token in response to a click, with a visible acknowledgement. The
   * insert of a large blob is synchronous and can briefly block the main thread,
   * so paint a "busy" state on the pill FIRST (forcing a layout flush), then run
   * the expansion on a later frame so that state is on screen before the block.
   * @param {HTMLTextAreaElement} textarea
   * @param {import('../utils/paste-tokens.js').PasteTokenMatch} tok
   * @param {Element} [span] - The pill span to flag as busy.
   * @private
   */
  _expandTokenWithFeedback(textarea, tok, span) {
    if (span) {
      span.classList.add('expanding');
      void (/** @type {HTMLElement} */ (span)).offsetHeight; // force the state to paint
    }
    const run = () => {
      // Re-resolve the token by id from the CURRENT text: the defer opens a small
      // window in which positions could shift, so never expand a stale span.
      const cur = parseTokens(textarea.value);
      const fresh = cur.find((t) => t.id === tok.id && t.start === tok.start) || cur.find((t) => t.id === tok.id);
      if (fresh) this._expandToken(textarea, fresh);
    };
    // A click means the view is frontmost, so rAF is not throttled here; a double
    // rAF guarantees the busy state has painted before the blocking insert.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(run));
    } else {
      setTimeout(run, 0);
    }
  }

  /**
   * Shared tail for every token-text mutation (capture, expand, delete, cut):
   * refresh the mirror, re-measure the textarea, update the empty-sensitive
   * controls, and persist the draft immediately (a discrete event, like an
   * attachment add).
   * @param {HTMLTextAreaElement} textarea
   * @private
   */
  _afterTokenMutation(textarea) {
    // A capture/expand/delete/cut is trusted, so it becomes the reconciler's new
    // known-good base (an execCommand mutation also fires input, which must not
    // then see the pre-mutation value and revert it).
    this._pasteLastValue = textarea.value;
    this._pasteLastCaret = textarea.selectionStart;
    this._syncPasteMirror();
    this.autoResize(textarea);
    this._updateSendButtonState();
    this._persistDraft();
    this._completions?.handleInput();
  }

  // ── Token mirror overlay ───────────────────────────────────────────────

  /**
   * Rebuild or tear down the backdrop mirror to match the current text. With no
   * tokens the mirror is removed and the textarea is a plain, fully ordinary
   * textarea — all mirror risk is confined to the moments a placeholder exists.
   * @private
   */
  _syncPasteMirror() {
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea) return;
    const tokens = parseTokens(textarea.value);
    if (tokens.length === 0) {
      this._teardownPasteMirror(textarea);
      return;
    }
    this._ensurePasteMirror(textarea);
    this._renderPasteMirror(textarea.value, tokens);
    this._syncMirrorMetrics(textarea);
  }

  /**
   * Create the mirror div (once) behind the textarea, switch the textarea to
   * transparent-text mode, disable spellcheck (squiggles on invisible text), and
   * wire the resize + selection-snapping listeners.
   * @param {HTMLTextAreaElement} textarea
   * @private
   */
  _ensurePasteMirror(textarea) {
    if (this._pasteMirror) return;
    const mirror = document.createElement('div');
    mirror.className = 'paste-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    // Insert as the textarea's previous sibling so it sits behind it in the
    // wrapper's stacking context.
    textarea.parentElement?.insertBefore(mirror, textarea);
    this._pasteMirror = mirror;
    textarea.classList.add('paste-mirrored');
    textarea.spellcheck = false;
    if (typeof ResizeObserver === 'function') {
      this._pasteMirrorRO = new ResizeObserver(() => this._syncMirrorMetrics(textarea));
      this._pasteMirrorRO.observe(textarea);
    }
    // Selection snapping: an endpoint strictly inside a token snaps outward, so
    // you can select ACROSS a token but never INTO it (also keeps typing/caret
    // out of the label). Throttled to a microtask-ish guard via a reentrancy flag.
    this._pasteSelectionListener = () => this._snapSelectionOutOfTokens(textarea);
    document.addEventListener('selectionchange', this._pasteSelectionListener);
  }

  /**
   * Remove the mirror and restore the plain-textarea state. Idempotent.
   * @param {HTMLTextAreaElement} [textarea]
   * @private
   */
  _teardownPasteMirror(textarea) {
    const ta = textarea || /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (this._pasteMirrorRO) {
      this._pasteMirrorRO.disconnect();
      this._pasteMirrorRO = null;
    }
    if (this._pasteSelectionListener) {
      document.removeEventListener('selectionchange', this._pasteSelectionListener);
      this._pasteSelectionListener = null;
    }
    if (this._pasteMirror) {
      this._pasteMirror.remove();
      this._pasteMirror = null;
    }
    if (ta) {
      ta.classList.remove('paste-mirrored');
      ta.spellcheck = false; // matches the render() attribute default
      if (ta.style.cursor) ta.style.cursor = ''; // drop any hover pointer cursor
    }
  }

  /**
   * Render the mirror's content: the same character string as the textarea, with
   * each token wrapped in a styled `.paste-token` span. Because the label is real
   * text and the span carries only metric-safe styling, both layers lay out
   * identically by construction.
   * @param {string} text
   * @param {import('../utils/paste-tokens.js').PasteTokenMatch[]} tokens
   * @private
   */
  _renderPasteMirror(text, tokens) {
    const mirror = this._pasteMirror;
    if (!mirror) return;
    mirror.textContent = '';
    let last = 0;
    for (const t of tokens) {
      if (t.start > last) mirror.appendChild(document.createTextNode(text.slice(last, t.start)));
      const span = document.createElement('span');
      span.className = 'paste-token';
      span.textContent = t.text; // full token incl. invisible delimiters
      mirror.appendChild(span);
      last = t.end;
    }
    // A trailing newline needs a following character for pre-wrap to show the
    // final empty line; mirror the textarea by appending the remainder plus a
    // sentinel space when it ends on a newline.
    let tail = text.slice(last);
    if (tail.endsWith('\n')) tail += '\u200b';
    if (tail) mirror.appendChild(document.createTextNode(tail));
  }

  /**
   * Copy the textarea's box metrics and scroll onto the mirror so the two layers
   * overlap exactly. Computed styles are copied (rather than assumed from CSS) so
   * the mirror inherits the textarea's real font, regardless of theme.
   * @param {HTMLTextAreaElement} textarea
   * @private
   */
  _syncMirrorMetrics(textarea) {
    const mirror = this._pasteMirror;
    if (!mirror) return;
    const cs = window.getComputedStyle(textarea);
    for (const prop of [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
      'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
    ]) {
      // @ts-ignore indexed style write
      mirror.style[prop] = cs[prop];
    }
    mirror.style.top = `${textarea.offsetTop}px`;
    mirror.style.left = `${textarea.offsetLeft}px`;
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.height = `${textarea.clientHeight}px`;
    mirror.scrollTop = textarea.scrollTop;
  }

  /**
   * Snap a selection endpoint that lands strictly inside a token outward to the
   * token boundary. Guarded against reentrancy (setting the range re-fires
   * selectionchange) and a no-op when nothing needs snapping.
   * @param {HTMLTextAreaElement} textarea
   * @private
   */
  _snapSelectionOutOfTokens(textarea) {
    if (this._snappingSelection || this._pasteComposing) return;
    if (document.activeElement !== textarea) return;
    if (!hasTokens(textarea.value)) return;
    const tokens = parseTokens(textarea.value);
    let s = textarea.selectionStart;
    let en = textarea.selectionEnd;

    // Collapsed caret: it must never rest INSIDE a token. Snap it out in the
    // direction of travel (a word/line jump or Home/End that landed in a label
    // continues past it), falling back to the nearer edge when direction is
    // ambiguous. This is what makes the interior unreachable by the caret, so no
    // keystroke or paste can target it.
    if (s === en) {
      let p = s;
      for (const t of tokens) {
        if (p > t.start && p < t.end) {
          const movingRight = p >= this._pasteLastCaret;
          p = movingRight ? t.end : t.start;
          break;
        }
      }
      if (p !== s) {
        this._snappingSelection = true;
        try { textarea.setSelectionRange(p, p); } catch { /* non-fatal */ } finally { this._snappingSelection = false; }
      }
      this._pasteLastCaret = textarea.selectionStart;
      return;
    }

    // Range selection: snap each endpoint outward so you can select ACROSS a
    // token but never INTO it (also keeps a subsequent typed replacement whole).
    const dir = textarea.selectionDirection;
    for (const t of tokens) {
      if (s > t.start && s < t.end) s = (s - t.start) <= (t.end - s) ? t.start : t.end;
      if (en > t.start && en < t.end) en = (en - t.start) <= (t.end - en) ? t.start : t.end;
    }
    if (s !== textarea.selectionStart || en !== textarea.selectionEnd) {
      if (s > en) { const tmp = s; s = en; en = tmp; }
      this._snappingSelection = true;
      try {
        textarea.setSelectionRange(s, en, dir === 'none' ? undefined : dir);
      } catch { /* non-fatal */ } finally {
        this._snappingSelection = false;
      }
    }
    this._pasteLastCaret = textarea.selectionStart;
  }

  /**
   * Upload one image file to the conversation's asset store, showing an
   * "uploading" chip while in flight and replacing it with the resolved
   * AssetRef on success (or removing it on failure).
   * @param {File} file
   * @private
   */
  async _uploadAndAdd(file) {
    const convId = this._conversation?.id;
    if (!convId) {
      this.showWarning('No active conversation for the attachment.');
      return;
    }
    // Placeholder chip while the bytes upload. Carries a local preview URL so
    // the thumbnail shows immediately (the asset GET URL only works post-upload).
    const placeholder = {
      id: '', mime: file.type, filename: file.name, bytes: file.size,
      width: 0, height: 0, _uploading: true, _previewURL: URL.createObjectURL(file)
    };
    this._pendingAttachments.push(placeholder);
    this._renderAttachmentChips();

    try {
      const ref = await apiService.uploadAsset(convId, file);
      const idx = this._pendingAttachments.indexOf(placeholder);
      if (idx !== -1) {
        // Carry the local preview URL onto the resolved ref so the thumbnail
        // doesn't flicker (revoked when the chip is removed / cleared).
        this._pendingAttachments[idx] = { ...ref, _previewURL: placeholder._previewURL };
      } else if (placeholder._previewURL) {
        // Chip was removed mid-upload — drop the resolved ref and free the URL.
        URL.revokeObjectURL(placeholder._previewURL);
      }
      this._renderAttachmentChips();
      // The attachment is now a resolved asset — fold it into the persisted
      // draft so it survives a reload alongside the text.
      this._persistDraft();
    } catch (err) {
      const idx = this._pendingAttachments.indexOf(placeholder);
      if (idx !== -1) this._pendingAttachments.splice(idx, 1);
      if (placeholder._previewURL) URL.revokeObjectURL(placeholder._previewURL);
      this._renderAttachmentChips();
      this.showWarning(`Image upload failed: ${extractErrorMessage(err)}`);
    }
  }

  /**
   * Remove a staged attachment and re-render the chip row.
   * @param {{_previewURL?:string}} ref
   * @private
   */
  _removeAttachment(ref) {
    const idx = this._pendingAttachments.indexOf(/** @type {any} */ (ref));
    if (idx === -1) return;
    this._pendingAttachments.splice(idx, 1);
    if (ref._previewURL) URL.revokeObjectURL(ref._previewURL);
    this._renderAttachmentChips();
    // Persist the draft so the removal survives a reload too.
    this._persistDraft();
  }

  /**
   * Replace the staged attachments with a restored set (used when a "rewind to
   * this message" puts an attachment-bearing user message back into the box for
   * editing/resend). Clones each ref down to the persistable AssetRef fields,
   * dropping any UI-only state (`_previewURL`/`_uploading`) from the source —
   * the restored chips render their thumbnails from the asset GET URL.
   *
   * Attachments are restored regardless of the current model — capability is
   * not gated client-side. A model that can't accept images rejects the
   * request at send time and that provider error surfaces as the turn error.
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
   * @returns {number} Count of attachments actually staged.
   */
  setPendingAttachments(refs) {
    const count = this._stagePendingAttachments(refs);
    // This is a genuine draft change (rewind/restore-from-message) — persist
    // the whole draft so text + attachments survive a reload together.
    this._persistDraft();
    return count;
  }

  /**
   * Replace the in-memory staged attachments and re-render the chip row WITHOUT
   * persisting. Used both by setPendingAttachments (which then persists) and by
   * the draft-restore path in setMessageThread (which is reading FROM the
   * persisted draft, so re-persisting would be redundant churn).
   * @param {Array<{id:string,mime:string,filename:string,bytes:number,width:number,height:number}>} refs
   * @returns {number} Count of attachments actually staged.
   * @private
   */
  _stagePendingAttachments(refs) {
    // Revoke any preview URLs on the outgoing pending set before replacing it.
    for (const a of this._pendingAttachments) {
      if (a._previewURL) URL.revokeObjectURL(a._previewURL);
    }
    this._pendingAttachments = [];

    const list = Array.isArray(refs) ? refs.filter((r) => r && r.id) : [];
    if (list.length === 0) {
      this._renderAttachmentChips();
      return 0;
    }

    this._pendingAttachments = list.map((r) => ({
      id: r.id,
      mime: r.mime,
      filename: r.filename,
      bytes: r.bytes,
      width: r.width,
      height: r.height
    }));
    this._renderAttachmentChips();
    return this._pendingAttachments.length;
  }

  /**
   * Replace the in-memory staged text files and re-render the chip row WITHOUT
   * persisting — the restore counterpart to {@link _stagePendingTextFiles}'s
   * caller reading FROM the persisted draft. Clones down to the persistable
   * fields so no stray UI state carries over.
   * @param {Array<{filename:string,content:string,bytes:number}>} entries
   * @returns {number} Count of text files actually staged.
   * @private
   */
  _stagePendingTextFiles(entries) {
    const list = Array.isArray(entries)
      ? entries.filter((t) => t && typeof t.content === 'string')
      : [];
    this._pendingTextFiles = list.map((t) => ({
      filename: t.filename || 'dropped file',
      content: t.content,
      bytes: t.bytes || 0
    }));
    this._renderAttachmentChips();
    return this._pendingTextFiles.length;
  }

  /**
   * Render the staged-attachment chip row from _pendingAttachments. Rebuilds
   * only its own container (never the textarea), so caret/focus are preserved.
   * @private
   */
  _renderAttachmentChips() {
    // An image staged with no text is a valid send, so the enabled state of the
    // send button depends on attachments too — refresh it on every attachment
    // mutation (this method is the single choke point for add/remove/stage).
    this._updateSendButtonState();
    const container = this.querySelector('composer-box-attachments');
    if (!container) return;
    container.innerHTML = '';
    if (this._pendingAttachments.length === 0 && this._pendingTextFiles.length === 0) {
      container.classList.remove('has-attachments');
      return;
    }
    container.classList.add('has-attachments');
    const convId = this._conversation?.id;

    for (const ref of this._pendingAttachments) {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip' + (ref._uploading ? ' uploading' : '');

      // Click the thumbnail to preview the staged image full-size — the same
      // lightbox used for attachments inside a sent user-message item.
      const src = ref._previewURL || (ref.id && convId ? apiService.assetURL(convId, ref.id) : '');
      const thumb = createImageThumb({
        src,
        alt: ref.filename || '',
        className: src ? 'attachment-thumb clickable' : 'attachment-thumb',
      });
      chip.appendChild(thumb);

      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = ref.filename || 'image';
      chip.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => this._removeAttachment(ref));
      chip.appendChild(remove);

      container.appendChild(chip);
    }

    // Dropped text files: a document-icon chip (no image thumbnail).
    for (const entry of this._pendingTextFiles) {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip text-file';

      const icon = document.createElement('span');
      icon.className = 'attachment-icon icon-document';
      chip.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = entry.filename || 'text file';
      chip.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.textContent = '\u00d7';
      remove.addEventListener('click', () => this._removeTextFile(entry));
      chip.appendChild(remove);

      container.appendChild(chip);
    }
  }

  /**
   * Create a new thread, including textarea text as initial message
   * @private
   */
  _createThread() {
    if (this._conversation?.isTurnActive()) {
      this.showWarning('Wait for the current turn to finish before creating a new thread.');
      return;
    }
    const textarea = this.querySelector('textarea');
    // Expand any inline paste placeholders before moving the text: the new
    // thread's draft carries the full content inline (no blob table travels
    // through the slash command), matching what a send would have produced.
    const text = textarea ? expandPasteTokens(textarea.value, this._pasteBlobs).trim() : '';
    let command = '/thread';
    if (text) {
      command += ` --draft-message ${text}`;
      // The text is being MOVED into the new thread, so this box must clear. The
      // plain clearInput() that the dispatched '/thread' triggers empties it via
      // `textarea.value = ''`, which wipes the browser's native undo stack — so
      // the user can't Ctrl/Cmd+Z the moved prompt back. Clear it undoably here
      // FIRST (an execCommand edit stays on the undo stack; setText() then skips
      // the no-op re-set of ''), but ONLY when the textarea already holds focus.
      // execCommand needs a focused, selected target, yet we must NOT call
      // focus() ourselves: grabbing focus to this box would rob the new thread's
      // box of the keyboard (its column-rebuild focus is what should win). When
      // the box isn't focused we simply leave it to clearInput() — undo isn't
      // preserved in that rare case, but focus behaviour is untouched.
      this._clearMovedTextUndoable();
    }

    this.dispatchEvent(new CustomEvent('send-message', {
      detail: {
        message: command,
        threadItemId: this.threadItemId || null,
        messageThread: this._messageThread || null
      },
      bubbles: true,
      composed: true
    }));
  }

  // ── Scheduled send ("send after a delay") ─────────────────────────────
  //
  // Clicking the clock button arms a send for a chosen wall-clock time — the
  // intended use is firing a queued command the instant the next LLM-provider
  // time slice opens, so precision is coarse (5-minute granularity). The target
  // is persisted on the thread's draft (epoch ms). This box only arms, cancels,
  // and DISPLAYS a live countdown; the firing itself is owned by
  // scheduledSendService, which sweeps every thread on an interval so a send
  // goes out even while a different thread or tab is on screen. When the due
  // thread IS on screen the service calls _fireScheduledSend here, so the send
  // carries the live textarea's exact contents.

  /**
   * Stop the countdown-refresh interval WITHOUT touching `_scheduledSendAt` or
   * the persisted draft — the target survives so a later rebind restores it.
   * @private
   */
  _stopScheduledCountdown() {
    if (this._scheduledCountdownId !== null) {
      clearInterval(this._scheduledCountdownId);
      this._scheduledCountdownId = null;
    }
  }

  /**
   * Start (or restart) the coarse interval that refreshes the countdown label.
   * Display only — it never fires the send. The label is recomputed from the
   * absolute target each tick, so a throttled background timer can't make the
   * displayed countdown drift.
   * @private
   */
  _startScheduledCountdown() {
    this._stopScheduledCountdown();
    this._scheduledCountdownId = setInterval(() => this._updateScheduleButton(), 30000);
  }

  /**
   * Arm a send for the absolute instant `targetAt` (epoch ms): record it,
   * persist it onto the thread's draft, start the countdown, and reflect it on
   * the clock button. scheduledSendService picks it up from the draft.
   * @param {number} targetAt
   * @private
   */
  _armScheduledSend(targetAt) {
    this._scheduledSendAt = targetAt;
    this._persistDraft();
    this._startScheduledCountdown();
    this._updateScheduleButton();
  }

  /**
   * Cancel the pending send: stop the countdown, clear the target, and remove
   * it from the persisted draft.
   * @private
   */
  _cancelScheduledSend() {
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._persistDraft();
    this._updateScheduleButton();
  }

  /**
   * Fire the pending send. Called by scheduledSendService when THIS box is the
   * one bound to the due thread. Clears the schedule FIRST (and persists that,
   * so an empty box — where sendMessage() no-ops without clearing the draft —
   * doesn't leave the target behind to re-fire on the next sweep), then presses
   * Send on whatever is currently in the box.
   * @private
   */
  _fireScheduledSend() {
    this._stopScheduledCountdown();
    this._scheduledSendAt = null;
    this._persistDraft();
    this._updateScheduleButton();
    this.sendMessage();
  }

  /**
   * Re-derive the displayed scheduled-send state from the bound thread's
   * persisted draft. Stops any countdown left over from a previously-bound
   * thread, then restores the target and its countdown for the newly-bound
   * thread. Firing (including for an already-passed target) is left to
   * scheduledSendService. Called after the controls render and on every genuine
   * thread switch.
   * @private
   */
  _syncScheduledSendFromDraft() {
    this._stopScheduledCountdown();
    const when = this._messageThread ? this._messageThread.draft.scheduledSendAt : null;
    this._scheduledSendAt = (typeof when === 'number' && Number.isFinite(when)) ? when : null;
    if (this._scheduledSendAt !== null) {
      this._startScheduledCountdown();
    }
    this._updateScheduleButton();
  }

  /**
   * Reflect the current scheduled-send state on the clock button: an `armed`
   * class, a live countdown badge, and a tooltip naming the target time.
   *
   * An empty box overrides all of that: arming (or leaving armed) a delayed
   * send with nothing to send would silently fire nothing, so an empty box
   * disables the button and renders it un-armed — WITHOUT clearing
   * `_scheduledSendAt` or the persisted draft. A timer the user already set is
   * only hidden; the moment they type again this re-renders it armed with its
   * countdown intact.
   * @private
   */
  _updateScheduleButton() {
    const btn = this.querySelector('.schedule-send-btn');
    if (!btn) return;
    const label = btn.querySelector('.schedule-send-countdown');
    const empty = this.isEmpty();
    /** @type {HTMLButtonElement} */ (btn).disabled = empty;
    if (this._scheduledSendAt === null || empty) {
      btn.classList.remove('armed');
      // When a timer is armed but hidden by an empty box, point the user at how
      // to bring it back rather than implying nothing is set.
      btn.setAttribute('title', (empty && this._scheduledSendAt !== null)
        ? 'Type a message to resume the timer'
        : 'Send after a delay');
      if (label) {
        /** @type {HTMLElement} */ (label).hidden = true;
        label.textContent = '';
      }
      return;
    }
    btn.classList.add('armed');
    const remaining = Math.max(0, this._scheduledSendAt - Date.now());
    btn.setAttribute('title', `Sending at ${formatClockTime(this._scheduledSendAt)} — click to change or cancel`);
    if (label) {
      /** @type {HTMLElement} */ (label).hidden = false;
      label.textContent = formatDelayShort(remaining);
    }
  }

  /**
   * Toggle the delay picker: close it if open, otherwise open it.
   * @private
   */
  _toggleSchedulePicker() {
    if (this._schedulePickerCleanup) {
      this._closeSchedulePicker();
    } else {
      this._openSchedulePicker();
    }
  }

  /**
   * Close the delay picker (tears down its popup surface).
   * @private
   */
  _closeSchedulePicker() {
    if (this._schedulePickerCleanup) {
      const release = this._schedulePickerCleanup;
      this._schedulePickerCleanup = null;
      release();
    }
  }

  /**
   * Build and present the delay picker, anchored to the clock button (or a
   * bottom sheet on a phone). Two shapes:
   *   • Armed — a single "Cancel timer" button (nothing else to decide).
   *   • Idle — full-width preset chips (15m…5h), hours + 5-minute steppers, and
   *     one full-width "Schedule to send at HH:MM" button that both previews the
   *     target time and confirms it.
   * The picker never edits the textarea.
   * @private
   */
  _openSchedulePicker() {
    let anchor = /** @type {HTMLElement|null} */ (this.querySelector('.schedule-send-btn'));
    // On touch the inline clock button is hidden unless a send is armed (it lives
    // in the "⋮" actions sheet), so anchor to the still-visible overflow button
    // when it is not laid out. On a phone the picker is a bottom sheet, where the
    // anchor is moot anyway.
    if (!anchor || anchor.offsetParent === null) {
      anchor = /** @type {HTMLElement|null} */ (this.querySelector('#more-actions-button')) || anchor;
    }
    if (!anchor) return;

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu schedule-send-menu show';
    menu.id = 'schedule-send-menu';

    const present = () => {
      this._schedulePickerCleanup = presentPopup({
        surface: menu,
        anchor,
        id: 'schedule-send',
        onClose: () => this._closeSchedulePicker(),
        align: 'right',
        insideSelectors: ['.schedule-send-btn', '.schedule-send-menu'],
      });
    };

    // --- Armed: show the target time, offer to cancel -----------------------
    if (this._scheduledSendAt) {
      const targetLine = document.createElement('div');
      targetLine.className = 'schedule-armed-target';
      targetLine.textContent = `Sending at ${formatClockTime(this._scheduledSendAt)}`;
      menu.appendChild(targetLine);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'schedule-cancel-btn schedule-cancel-only';
      cancelBtn.textContent = 'Cancel timer';
      cancelBtn.addEventListener('click', () => {
        this._cancelScheduledSend();
        this._closeSchedulePicker();
      });
      menu.appendChild(cancelBtn);
      present();
      return;
    }

    // --- Idle: pick a delay -------------------------------------------------
    let hours = 1;
    let minutes = 0;

    const heading = document.createElement('div');
    heading.className = 'schedule-send-heading';
    heading.textContent = 'Send after a delay';
    menu.appendChild(heading);

    // Preset chips — stretch to fill the row.
    const presetRow = document.createElement('div');
    presetRow.className = 'schedule-preset-row';
    menu.appendChild(presetRow);

    // Steppers.
    const steppers = document.createElement('div');
    steppers.className = 'schedule-steppers';
    menu.appendChild(steppers);

    /**
     * @param {string} unitLabel
     * @param {() => number} get
     * @param {(v: number) => void} set
     * @param {number} min
     * @param {number} max
     * @param {number} step
     * @returns {HTMLElement} the value element (for later text updates)
     */
    const buildStepper = (unitLabel, get, set, min, max, step) => {
      const wrap = document.createElement('div');
      wrap.className = 'schedule-stepper';
      const dec = document.createElement('button');
      dec.type = 'button';
      dec.className = 'schedule-stepper-btn';
      dec.textContent = '\u2212'; // minus
      dec.setAttribute('aria-label', `Fewer ${unitLabel}`);
      const val = document.createElement('span');
      val.className = 'schedule-stepper-value';
      const unit = document.createElement('span');
      unit.className = 'schedule-stepper-unit';
      unit.textContent = unitLabel;
      const inc = document.createElement('button');
      inc.type = 'button';
      inc.className = 'schedule-stepper-btn';
      inc.textContent = '+';
      inc.setAttribute('aria-label', `More ${unitLabel}`);
      dec.addEventListener('click', () => { set(Math.max(min, get() - step)); refresh(); });
      inc.addEventListener('click', () => { set(Math.min(max, get() + step)); refresh(); });
      wrap.append(dec, val, unit, inc);
      steppers.appendChild(wrap);
      return val;
    };

    const hoursValueEl = buildStepper('hr',
      () => hours, (v) => { hours = v; }, 0, SCHEDULE_MAX_HOURS, 1);
    const minutesValueEl = buildStepper('min',
      () => minutes, (v) => { minutes = v; }, 0, 60 - SCHEDULE_MINUTE_STEP, SCHEDULE_MINUTE_STEP);

    // One full-width button that both previews and confirms the target time.
    const actions = document.createElement('div');
    actions.className = 'schedule-actions';
    const scheduleBtn = document.createElement('button');
    scheduleBtn.type = 'button';
    scheduleBtn.className = 'schedule-confirm-btn';
    actions.appendChild(scheduleBtn);
    menu.appendChild(actions);

    const refresh = () => {
      hoursValueEl.textContent = String(hours);
      minutesValueEl.textContent = String(minutes).padStart(2, '0');
      const totalMin = hours * 60 + minutes;
      if (totalMin <= 0) {
        scheduleBtn.textContent = 'Pick a delay above';
        scheduleBtn.disabled = true;
      } else {
        scheduleBtn.disabled = false;
        scheduleBtn.textContent = `Schedule to send at ${formatClockTime(Date.now() + totalMin * 60000)}`;
      }
    };

    for (const preset of SCHEDULE_PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'schedule-preset';
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        hours = Math.min(SCHEDULE_MAX_HOURS, Math.floor(preset.minutes / 60));
        minutes = preset.minutes % 60;
        refresh();
      });
      presetRow.appendChild(chip);
    }

    scheduleBtn.addEventListener('click', () => {
      const totalMin = hours * 60 + minutes;
      if (totalMin <= 0) return;
      this._armScheduledSend(Date.now() + totalMin * 60000);
      this._closeSchedulePicker();
    });

    refresh();
    present();
  }

  /**
   * Create the commands dropdown menu element
   * @private
   */
  _createCommandsMenu() {
    if (this._commandsMenu) {
      this._commandsMenu.remove();
    }

    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu commands-menu';
    menu.id = 'commands-menu';

    const commands = slashCommandHandler.getCommands();

    // Explicit menu ordering: tab operations first (new, duplicate), then
    // thread, then conversation-history operations (clear, compact).
    const ORDER = ['new', 'duplicate', 'thread', 'clear', 'compact'];
    commands.sort((a, b) => {
      const ai = ORDER.indexOf(a.name);
      const bi = ORDER.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    for (const cmd of commands) {
      const item = document.createElement('li');
      item.className = 'menu-item' + (cmd.danger ? ' danger' : '');
      item.dataset.command = cmd.name;

      const code = document.createElement('code');
      code.textContent = '/' + cmd.name;
      item.appendChild(code);

      const desc = document.createElement('span');
      desc.className = 'menu-item-desc';
      const displayLabel = cmd.label || cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
      desc.textContent = displayLabel;
      item.appendChild(desc);

      item.addEventListener('click', () => {
        this._executeSlashCommand(cmd.name);
      });

      menu.appendChild(item);
    }

    // presentPopup (in _openCommandsMenu) owns body-append and teardown.
    this._commandsMenu = menu;
  }

  /**
   * Toggle commands menu visibility
   * @private
   */
  _toggleCommandsMenu() {
    if (this._commandsMenuOpen) {
      this._closeCommandsMenu();
    } else {
      this._openCommandsMenu();
    }
  }

  /**
   * Toggle the skill picker menu.
   * @private
   */
  _toggleSkillMenu() {
    if (this._skillMenuOpen) {
      this._closeSkillMenu();
    } else {
      this._openSkillMenu();
    }
  }

  /**
   * Open the skill picker: a button-anchored menu of this thread's available
   * skills, mirroring the commands (`/`) button. Nothing is inserted on open or
   * on dismissal — only SELECTING a skill splices `$name ` into the composer (via
   * {@link _insertSkillMention}), so the choice flows through the same send-time
   * activation path as typing `$name`.
   * @private
   * @returns {Promise<void>}
   */
  async _openSkillMenu() {
    const button = this.querySelector('#skill-button');
    if (!button) return;
    const skills = await getThreadSkillSnapshot(this._messageThread);
    if (!Array.isArray(skills) || skills.length === 0) return;

    this._createSkillMenu(skills);
    if (!this._skillMenu) return;

    this._skillMenu.classList.add('show');
    this._skillMenuOpen = true;

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape) and the reposition observer, exactly as the
    // commands menu uses it. A dedicated cleanup handle keeps it independent of
    // the commands-menu popup.
    this._skillPopupCleanup = presentPopup({
      surface: this._skillMenu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'skill-picker',
      onClose: () => this._closeSkillMenu(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#skill-button', '.skill-menu'],
    });
  }

  /**
   * Close the skill picker menu.
   * @private
   */
  _closeSkillMenu() {
    if (!this._skillMenu) return;
    this._skillMenuOpen = false;
    // Release tears down the surface, observer and dismissal wiring.
    if (this._skillPopupCleanup) {
      this._skillPopupCleanup();
      this._skillPopupCleanup = null;
    }
    this._skillMenu = null;
  }

  /**
   * Build the skill picker menu: one row per available skill (mono `$name` +
   * one-line description), each inserting `$name ` on click, followed by a
   * "Manage skills…" footer that opens the Skills settings page. Carries the
   * `commands-menu` class so it borrows the slash-command popup's justified
   * two-column grid and colour scheme verbatim, and shares the `$` completion
   * menu's row builder ({@link renderSkillMenuItem}). presentPopup (in
   * _openSkillMenu) owns body-append and teardown.
   * @param {import('../services/skills.js').SkillMeta[]} skills - This thread's snapshot skills
   * @private
   */
  _createSkillMenu(skills) {
    if (this._skillMenu) {
      this._skillMenu.remove();
    }
    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu commands-menu skill-menu';
    menu.id = 'skill-menu';

    // Name-sorted, matching the `$` autocomplete's stable ordering.
    const sorted = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const skill of sorted) {
      // Same row builder as the `$` completion menu; only the click handler
      // differs (the picker splices the mention; the autocomplete accepts it).
      const item = renderSkillMenuItem(skill);
      item.addEventListener('click', () => {
        this._insertSkillMention(skill.name);
      });
      menu.appendChild(item);
    }

    // Footer: a jump to the Skills settings page (install / edit / remove
    // skills). The picker is a deliberate, mouse-first surface — unlike the `$`
    // autocomplete — so it carries the management affordance the typed path omits.
    const divider = document.createElement('li');
    divider.className = 'menu-divider';
    menu.appendChild(divider);

    const manage = document.createElement('li');
    manage.className = 'menu-item skill-menu-manage';
    manage.dataset.action = 'manage-skills';
    manage.textContent = 'Manage skills…';
    manage.addEventListener('click', () => {
      this._closeSkillMenu();
      /** @type {any} */ (window).openSettings?.('skills');
    });
    menu.appendChild(manage);

    this._skillMenu = menu;
  }

  /**
   * Splice a `$name ` skill mention into the composer at the caret (prefixed with
   * a space when the preceding char isn't a mention boundary), then close the
   * menu and focus the textarea. Identical to accepting the `$` autocomplete, so
   * the mention is loaded and stripped by the normal send-time path.
   * @param {string} name - Exact skill name
   * @private
   */
  _insertSkillMention(name) {
    this._closeSkillMenu();
    const textarea = /** @type {HTMLTextAreaElement|null} */ (this.querySelector('textarea'));
    if (!textarea) return;
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    // Mirror the mention-boundary rule: a `$` only triggers at start-of-text or
    // after whitespace, so insert a leading space when the caret sits on a
    // non-boundary char.
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insertText = (needsSpace ? ' ' : '') + '$' + name + ' ';
    textarea.value = before + insertText + textarea.value.slice(pos);
    const newPos = pos + insertText.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    this.autoResize(textarea);
    textarea.focus();
  }

  /**
   * Show the skill picker button only when this thread advertises at least one
   * skill (mirrors the standing Skills item's own gating). Resolves the frozen
   * snapshot asynchronously and toggles the button's `hidden` attribute; a guard
   * against a null button keeps this safe before/after render.
   * @private
   * @returns {Promise<void>}
   */
  async _refreshSkillButtonVisibility() {
    const button = /** @type {HTMLButtonElement|null} */ (this.querySelector('#skill-button'));
    if (!button) return;
    let hasSkills = false;
    try {
      const skills = await getThreadSkillSnapshot(this._messageThread);
      hasSkills = Array.isArray(skills) && skills.length > 0;
    } catch {
      hasSkills = false;
    }
    button.hidden = !hasSkills;
  }

  /**
   * Open the commands menu
   * @private
   * @returns {Promise<void>}
   */
  async _openCommandsMenu() {
    await slashCommandHandler.init();
    this._createCommandsMenu();

    if (!this._commandsMenu) return;

    const button = this.querySelector('#commands-button');
    if (!button) return;

    this._commandsMenu.classList.add('show');
    this._commandsMenuOpen = true;

    // presentPopup owns body-append, dismissal wiring (outside-click via
    // insideSelectors + Escape, which dismisses the menu rather than
    // cancelling a running turn), the reposition observer, and the
    // anchored-vs-sheet decision.
    this._popupCleanup = presentPopup({
      surface: this._commandsMenu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'slash-commands',
      onClose: () => this._closeCommandsMenu(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#commands-button', '.commands-menu'],
    });
  }

  /**
   * Close the commands menu
   * @private
   */
  _closeCommandsMenu() {
    if (!this._commandsMenu) return;

    this._commandsMenuOpen = false;
    // Release tears down the surface, scrim, observer and dismissal wiring.
    if (this._popupCleanup) {
      this._popupCleanup();
      this._popupCleanup = null;
    }
    this._commandsMenu = null;
  }

  /**
   * Execute a slash command
   * @param {string} commandName
   * @private
   */
  async _executeSlashCommand(commandName) {
    this._closeCommandsMenu();

    if (!this._conversation) return;

    await this._conversation.sendMessage('/' + commandName, null, this._messageThread || undefined);
  }

  /**
   * Toggle the touch-only "⋮" actions sheet.
   * @private
   */
  _toggleActionsSheet() {
    if (this._actionsSheetOpen) {
      this._closeActionsSheet();
    } else {
      this._openActionsSheet();
    }
  }

  /**
   * Build and present the "⋮" actions sheet. Essential controls lead — Strategy,
   * Attach image, Send after a delay, New Thread — always visible so they never
   * scroll off behind a long list. Below them, slash commands and skills each get their own
   * closed-by-default collapsible section (standing in for the inline `/` and `$`
   * buttons, which are hidden on touch), so the sheet opens short and each list is
   * one tap away. On a narrow viewport presentPopup renders it as a bottom sheet
   * (drag-to-dismiss); on a wider one it anchors to the "⋮" button. The rows reuse
   * the same handlers as the inline controls, so nothing nests a second popup.
   * @private
   * @returns {Promise<void>}
   */
  async _openActionsSheet() {
    await slashCommandHandler.init();

    const button = this.querySelector('#more-actions-button');
    if (!button) return;

    const menu = document.createElement('menu');
    menu.className = 'dropdown-menu actions-sheet show';
    menu.id = 'actions-sheet';

    /**
     * @param {string} label
     * @param {string} iconSvg
     * @param {() => void} onClick
     * @param {string} [action]
     */
    const addRow = (label, iconSvg, onClick, action = '') => {
      const item = document.createElement('li');
      item.className = 'menu-item actions-sheet-item';
      if (action) item.dataset.action = action;
      const icon = document.createElement('span');
      icon.className = 'actions-sheet-icon';
      icon.innerHTML = iconSvg;
      item.appendChild(icon);
      const text = document.createElement('span');
      text.className = 'actions-sheet-label';
      text.textContent = label;
      item.appendChild(text);
      item.addEventListener('click', () => {
        this._closeActionsSheet();
        onClick();
      });
      menu.appendChild(item);
    };

    // Essentials lead the sheet so they never scroll off behind a long command
    // list. Relocate the live strategy selector in first — on touch it is hidden
    // from the inline row to keep that row single-line. Re-parenting preserves
    // its messageThread (a plain property, untouched by disconnect/reconnect),
    // so it keeps working; _closeActionsSheet returns it to its inline home
    // before the sheet surface is torn down. It renders its own button +
    // dropdown, so it works at any viewport width (unlike clicking a hidden
    // inline anchor, which would mis-anchor on wide tablets).
    const strategySel = /** @type {HTMLElement|null} */ (this.querySelector('strategy-selector'));
    if (strategySel) {
      const row = document.createElement('li');
      row.className = 'menu-item actions-sheet-item actions-sheet-strategy';
      const label = document.createElement('span');
      label.className = 'actions-sheet-label';
      label.textContent = 'Strategy';
      row.appendChild(label);
      row.appendChild(strategySel); // moves the element out of the inline row
      menu.appendChild(row);
      this._relocatedStrategy = strategySel;
    }

    addRow('Attach image', IMAGE_ATTACH_SVG, () => {
      /** @type {HTMLInputElement|null} */
      (this.querySelector('.attach-file-input'))?.click();
    });

    // Schedule-send ("send after a delay") is a rarely-used control, so on touch
    // it lives here rather than on the inline row. The row opens the same delay
    // picker as the inline clock button (which stays visible only while armed).
    addRow('Send after a delay', CLOCK_SVG, () => this._toggleSchedulePicker());

    /**
     * Append a closed-by-default collapsible section of pre-built rows (native
     * `<details>`, so the header toggle needs no JS state). Skipped when empty.
     * @param {string} title - Section header label
     * @param {HTMLElement[]} rows - Row elements revealed when the section expands
     */
    const addSection = (title, rows) => {
      if (!rows.length) return;
      const section = document.createElement('details');
      section.className = 'actions-sheet-section';
      const summary = document.createElement('summary');
      summary.className = 'actions-sheet-section-header';
      summary.textContent = title;
      section.appendChild(summary);
      for (const row of rows) section.appendChild(row);
      menu.appendChild(section);
    };

    // Slash commands section (collapsed).
    const commands = slashCommandHandler.getCommands();
    const ORDER = ['new', 'duplicate', 'thread', 'clear', 'compact'];
    commands.sort((a, b) => {
      const ai = ORDER.indexOf(a.name);
      const bi = ORDER.indexOf(b.name);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    const commandRows = commands.map((cmd) => {
      const displayLabel = cmd.label || cmd.name.charAt(0).toUpperCase() + cmd.name.slice(1);
      const row = document.createElement('li');
      row.className = 'menu-item actions-sheet-item' + (cmd.danger ? ' danger' : '');
      row.dataset.command = cmd.name;
      const code = document.createElement('code');
      code.textContent = '/' + cmd.name;
      row.appendChild(code);
      const desc = document.createElement('span');
      desc.className = 'actions-sheet-label';
      desc.textContent = displayLabel;
      row.appendChild(desc);
      row.addEventListener('click', () => {
        this._closeActionsSheet();
        this._executeSlashCommand(cmd.name);
      });
      return row;
    });
    addSection('Slash commands', commandRows);

    // Skills section (collapsed) — this thread's frozen snapshot, standing in for
    // the inline `$` picker on touch. Selecting one splices `$name ` into the
    // composer via the same path as the picker/autocomplete; the section is
    // omitted entirely when the thread advertises no skills.
    /** @type {import('../services/skills.js').SkillMeta[]} */
    let skills = [];
    try {
      skills = await getThreadSkillSnapshot(this._messageThread);
    } catch {
      skills = [];
    }
    const skillRows = (Array.isArray(skills) ? skills : [])
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((skill) => {
        const row = document.createElement('li');
        row.className = 'menu-item actions-sheet-item';
        row.dataset.skill = skill.name;
        const code = document.createElement('code');
        code.textContent = '$' + skill.name;
        row.appendChild(code);
        const desc = document.createElement('span');
        desc.className = 'actions-sheet-label';
        desc.textContent = skill.description || skill.name;
        row.appendChild(desc);
        row.addEventListener('click', () => {
          this._closeActionsSheet();
          this._insertSkillMention(skill.name);
        });
        return row;
      });
    addSection('Skills', skillRows);

    // New Thread closes the sheet — it starts a fresh sub-thread rather than
    // acting on this composer, so it sits apart at the bottom below the command
    // and skill sections.
    addRow('New Thread', THREAD_ARROW_SVG, () => this._createThread(), 'new-thread');
    this._updateNewThreadControls();

    this._actionsSheet = menu;
    this._actionsSheetOpen = true;
    this._actionsSheetCleanup = presentPopup({
      surface: menu,
      anchor: /** @type {HTMLElement} */ (button),
      id: 'input-actions-sheet',
      onClose: () => this._closeActionsSheet(),
      align: 'left',
      gap: 4,
      insideSelectors: ['#more-actions-button', '.actions-sheet'],
    });
  }

  /**
   * Close the "⋮" actions sheet.
   * @private
   */
  _closeActionsSheet() {
    if (!this._actionsSheetOpen) return;
    this._actionsSheetOpen = false;
    // Return the relocated strategy selector to its inline home (the FIRST slot
    // in the config cluster — strategy leads so its fixed left edge anchors the
    // permission button, which can hide/show as the strategy changes) BEFORE the
    // sheet surface is removed — otherwise it would be torn down along with it.
    if (this._relocatedStrategy) {
      const config = this.querySelector('input-controls-config');
      if (config) config.insertBefore(this._relocatedStrategy, config.firstElementChild || null);
      this._relocatedStrategy = null;
    }
    if (this._actionsSheetCleanup) {
      this._actionsSheetCleanup();
      this._actionsSheetCleanup = null;
    }
    this._actionsSheet = null;
  }

  render() {
    this.innerHTML = `
            <composer-box-wrapper>
                <composer-box-attachments></composer-box-attachments>
                <textarea
                    placeholder="Enter your command..."
                    aria-label="Message input"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                    enterkeyhint="enter"
                ></textarea>
                <input type="file" class="attach-file-input" accept="image/*" multiple hidden />
                <input-controls>
                    <input-controls-config>
                        <strategy-selector></strategy-selector>
                        <permission-controls></permission-controls>
                        <model-selector id="conversation-model-selector"></model-selector>
                    </input-controls-config>
                    <input-controls-actions>
                        <button class="commands-button input-ctrl-btn" id="commands-button"
                                title="Commands"
                                aria-label="Commands menu">
                            <span class="icon-slash"></span>
                        </button>
                        <button class="skill-button input-ctrl-btn" id="skill-button" hidden
                                title="Load a skill ($)"
                                aria-label="Load a skill">
                            <span class="skill-glyph" aria-hidden="true">$</span>
                        </button>
                        <button class="attach-image-btn input-ctrl-btn" id="attach-image-button"
                                title="Attach image"
                                aria-label="Attach image">
                            <span class="attach-image-icon">${IMAGE_ATTACH_SVG}</span>
                        </button>
                        <button class="more-actions-btn input-ctrl-btn" id="more-actions-button"
                                title="More actions"
                                aria-label="More actions">
                            <span class="more-actions-icon">${KEBAB_SVG}</span>
                        </button>
                        <button class="schedule-send-btn input-ctrl-btn"
                                title="Send after a delay"
                                aria-label="Send after a delay">
                            <span class="schedule-send-icon">${CLOCK_SVG}</span>
                            <span class="schedule-send-countdown" hidden></span>
                        </button>
                    </input-controls-actions>
                    <input-controls-send>
                        <button class="new-thread-btn input-ctrl-btn" title="Create a new sub-thread">
                            New Thread
                            <span class="new-thread-arrow">${THREAD_ARROW_SVG}</span>
                        </button>
                        <button class="context-cache-warning-btn" id="context-cache-warning" hidden
                                title="Items in the conversation have changed, so the next message will cause a cache-miss"
                                aria-label="Items in the conversation have changed, so the next message will cause a cache-miss">
                            <span class="icon-warning" aria-hidden="true"></span>
                        </button>
                        <button class="send-btn is-empty" id="send-button"
                                title="Send message"
                                aria-label="Send message">
                            <span class="send-icon">${SEND_ARROW_SVG}</span>
                        </button>
                    </input-controls-send>
                </input-controls>
            </composer-box-wrapper>
        `;
    // Defer listener setup a frame so the just-written DOM is laid out.
    requestAnimationFrame(() => {
      this.setupListeners();
      // Pass conversation to strategy selector and permission controls if already set
      if (this._conversation) {
        this.setConversation(this._conversation);
      }
    });
  }
}

customElements.define('composer-box', Composer);
