//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * When to ask for reply suggestions, and when to shut up.
 *
 * The generator (`reply-suggestions.js`) is the easy half. This is the half
 * that decides whether to spend anything at all, and since the feature is
 * automatic and on by default, THIS FILE IS THE SAFETY STORY — not the prompt.
 * Suggestions that appear under a pending tool approval, or while someone is
 * mid-sentence, or three at a time across background tabs, are how a feature
 * like this gets switched off and never switched back on.
 *
 * The rules, and why each exists:
 *
 *   1. **The conversation is at rest.** Not mid-turn, and not parked on a tool
 *      waiting for approval — that is a question the user must answer, and
 *      putting chat suggestions under it is actively unhelpful. Parked also
 *      covers `AskUserQuestion` for free, since it parks on its own approval
 *      and already draws its own buttons.
 *   2. **The draft is empty.** Someone with words half-typed has an answer
 *      already.
 *   3. **The column is being looked at.** Not just visible: focused window,
 *      on-screen tab. Eight tabs finishing at once would saturate a four-slot
 *      pool that the auto-approve reviewer needs mid-turn.
 *   4. **The column would show them.** A lens on a folded tool run has no
 *      composer to write into, so an answer for it could only be thrown away.
 *   5. **A pause.** Either a short dwell after a turn ends, or — for a
 *      conversation that came to rest before the user arrived — a stretch of
 *      stillness with the column live and the box empty. Both exist to keep a
 *      flick past a column from costing anything.
 *   6. **The setting is on, and known to be on.**
 *
 * There are two ways in, and the difference matters. A turn ending is an
 * observation, and drives the fast path: dwell, then ask. But a conversation
 * that finished its work an hour ago emits nothing at all, and that silence was
 * once the whole shape of the feature — suggestions appeared only if you
 * happened to be watching the moment a turn landed, and a conversation you
 * merely opened never offered anything. So a slow poll asks the same questions
 * of a column that is simply being sat in front of.
 *
 * The poll only ever OFFERS. Clearing the row stays event-driven — a new turn,
 * a keystroke, detaching — because a poll that could clear would blink the row
 * away every time the window lost focus.
 *
 * Spending is fenced by the per-turn cache rather than by the trigger: an
 * answer for `(conversationId, completedTurns)` is asked for at most once and
 * kept, including when it came back empty and including when the user typed
 * past it before it landed. So "always offer" costs one cheap-model call per
 * conversation-turn you rest your eyes on, however many times you look away and
 * come back. Everything that comes back is fenced on the same pair and dropped
 * without a word if either moved while the request was in flight.
 *
 * Once shown, suggestions stay until the draft goes non-empty or a new turn
 * starts — there is no timer that takes them away again, because a row that
 * vanishes on its own is just flicker.
 * @module services/reply-suggestions-controller
 */

import { inspectTurn } from '../model/turn-completion.js';
import { generateReplySuggestions } from './reply-suggestions.js';
import {
  areReplySuggestionsEnabled,
  isReplySuggestionsSettingSeeded,
  refreshReplySuggestionsSetting,
} from './reply-suggestions-setting.js';

/**
 * @type {number} How long a finished turn must sit still before we ask. Long
 * enough that a user who was already typing never triggers a call, short
 * enough that suggestions feel like part of the turn ending.
 */
const DWELL_MS = 600;

/**
 * @type {number} How long a live column must sit still — nobody typing, nobody
 * flicking past it — before a conversation that came to rest earlier is offered
 * anything. Long enough that scanning a row of columns costs nothing; short
 * enough to have landed by the time someone reading one wonders what to say.
 */
const STILLNESS_MS = 2000;

/**
 * @type {number} How often stillness is checked. Every gate this wakes up to
 * ask is a property read until the last one, and the last one is skipped for
 * any column the user is not looking at.
 */
const POLL_MS = 500;

/**
 * Drives reply suggestions for one conversation column.
 *
 * Deliberately holds no DOM: it is handed the questions it needs as callbacks
 * and reports its answer through one. That keeps every rule above testable
 * without a rendered column, which is the only way a list of six conditions
 * stays correct.
 */
export class ReplySuggestionsController {
  /**
   * @param {object} opts - Wiring.
   * @param {() => any[]} opts.getItems - The column's message-thread items.
   * @param {() => string} opts.getDraft - The composer's current text.
   * @param {() => boolean} opts.isLive - Whether the user is looking at this column right now.
   * @param {(suggestions: string[]) => void} opts.onChange - Called with the suggestions to show (`[]` to show none).
   * @param {() => boolean} [opts.isOffered] - Whether this column would show a row at all; a column that would not must not spend.
   * @param {(items: any[], opts: any) => Promise<string[]>} [opts.generate] - The generator (injectable for tests).
   * @param {() => boolean} [opts.isEnabled] - The setting (injectable for tests).
   * @param {number} [opts.dwellMs] - Dwell before asking (injectable for tests).
   * @param {number} [opts.stillnessMs] - Stillness before an at-rest conversation is offered anything (injectable for tests).
   * @param {number} [opts.pollMs] - How often stillness is checked (injectable for tests).
   */
  constructor({ getItems, getDraft, isLive, onChange, isOffered, generate, isEnabled, dwellMs, stillnessMs, pollMs }) {
    /** @type {() => any[]} @private */
    this._getItems = getItems;
    /** @type {() => string} @private */
    this._getDraft = getDraft;
    /** @type {() => boolean} @private */
    this._isLive = isLive;
    /** @type {(suggestions: string[]) => void} @private */
    this._onChange = onChange;
    /** @type {(items: any[], opts: any) => Promise<string[]>} @private */
    this._generate = generate || generateReplySuggestions;
    /** @type {() => boolean} @private */
    this._isEnabled = isEnabled || areReplySuggestionsEnabled;
    /** @type {() => boolean} @private */
    this._isOffered = isOffered || (() => true);
    /** @type {number} @private */
    this._dwellMs = typeof dwellMs === 'number' ? dwellMs : DWELL_MS;
    /** @type {number} @private */
    this._stillnessMs = typeof stillnessMs === 'number' ? stillnessMs : STILLNESS_MS;
    /** @type {number} @private */
    this._pollMs = typeof pollMs === 'number' ? pollMs : POLL_MS;

    /** @type {any} @private */
    this._conversation = null;
    /** @type {((event: any) => void)|null} @private */
    this._observer = null;
    /** @type {AbortController|null} @private */
    this._inFlight = null;
    /** @type {any} @private */
    this._dwellTimer = null;
    /** @type {any} @private - The stillness poll, running for as long as we are attached. */
    this._pollTimer = null;
    /** @type {number} @private - When this column last went still; 0 while nobody is looking at it. */
    this._stillSince = 0;
    /** @type {{convId: string, turn: number}|null} @private - The turn a request is already out for. */
    this._pending = null;
    /** @type {{convId: string, turn: number, suggestions: string[]}|null} @private */
    this._cache = null;
    /** @type {string[]} @private - What is on screen, so a repeat emit can be skipped. */
    this._shown = [];
  }

  /**
   * Bind to a conversation (or null to unbind). Re-binding to the same
   * conversation is a no-op, so a column that re-announces its conversation on
   * every sync does not restart anything.
   * @param {any} conversation - Conversation instance, or null.
   */
  attach(conversation) {
    if (conversation === this._conversation) return;
    this.detach();
    this._conversation = conversation || null;
    if (!this._conversation) return;

    // Seeding the setting here rather than at startup keeps the feature's
    // wiring in one place: the first column to exist asks, long before any
    // turn could end, and until the answer lands rule 6 keeps us quiet.
    if (!isReplySuggestionsSettingSeeded()) void refreshReplySuggestionsSetting();

    this._observer = (/** @type {any} */ event) => {
      const keys = event?.keysChanged;
      if (!keys || keys.has('processingState') || keys.has('completedTurns')) this._evaluate();
    };
    this._conversation.observeMetadata(this._observer);

    // The stillness clock starts now: a column being attached is a column the
    // user has just arrived at, and arriving is the state this poll is for.
    this._stillSince = Date.now();
    this._pollTimer = setInterval(() => this._tick(), this._pollMs);
  }

  /** Unbind, cancel anything in flight, and clear the row. */
  detach() {
    if (this._conversation && this._observer) {
      this._conversation.unobserveMetadata(this._observer);
    }
    this._observer = null;
    this._conversation = null;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._stillSince = 0;
    this._cancel();
    this._emit([]);
    this._cache = null;
  }

  /**
   * The user started typing. Their own words beat anything we were going to
   * suggest, so the row goes.
   *
   * This also restarts the stillness clock, which is what keeps the poll from
   * dropping chips under someone who is deleting a draft to start again: the
   * box goes empty on the last backspace, and nothing is offered until they
   * have left it alone.
   */
  notifyTyping() {
    this._stillSince = Date.now();
    if (!this._shown.length && !this._dwellTimer && !this._inFlight) return;
    this._cancel();
    this._emit([]);
  }

  /**
   * The stillness poll: is this a column being sat in front of, with nothing
   * happening in it and nothing typed into it?
   *
   * Only ever leads to an offer. `_evaluate` does the deciding — this decides
   * only whether it is worth asking it.
   * @private
   */
  _tick() {
    // Mid-turn there is nothing to offer, and this is the moment to be cheapest
    // about asking: `isLive` reads `offsetParent`, which flushes layout, and a
    // streaming column dirties layout continuously. A property read gets us out
    // before that, on the one path that runs on a timer rather than an event.
    const conv = this._conversation;
    if (!conv || (conv.processingState?.status ?? 'idle') !== 'idle') return;

    if (!this._isLive()) {
      // Nobody is looking. The clock restarts when they come back, so a flick
      // through a row of columns never accumulates enough stillness to spend.
      this._stillSince = 0;
      return;
    }
    if (!this._stillSince) {
      this._stillSince = Date.now();
      return;
    }
    if (Date.now() - this._stillSince < this._stillnessMs) return;
    this._evaluate();
  }

  /**
   * Decide what to do about the conversation's current state. Cheap and
   * idempotent — it runs on every relevant metadata change.
   * @private
   */
  _evaluate() {
    const conv = this._conversation;
    if (!conv) return;

    const busy = (conv.processingState?.status ?? 'idle') !== 'idle';
    if (busy) {
      // A new turn is running: whatever is on screen belongs to the last one.
      this._cancel();
      this._emit([]);
      return;
    }

    const turn = conv.completedTurns ?? 0;

    // This turn has already been paid for. Its answer is shown again whenever
    // the conditions come back round — after a draft is typed and deleted, or a
    // tab is left and returned to — and costs nothing to show.
    if (this._cache && this._cache.convId === conv.id && this._cache.turn === turn) {
      if (this._shouldSuggest()) this._emit(this._cache.suggestions);
      return;
    }

    // A soft no. The row is left exactly as it is: this runs on a timer as well
    // as on an observation, and a poll that cleared would take the chips away
    // the moment the window lost focus and put them back when it returned.
    if (!this._shouldSuggest()) return;

    // A request is already out for this turn. Re-arming would abort it and pay
    // for the same answer twice — and a streaming conversation emits several
    // observations a second.
    if (this._pending && this._pending.convId === conv.id && this._pending.turn === turn) return;

    this._cancel();
    this._pending = { convId: conv.id, turn };
    this._dwellTimer = setTimeout(() => {
      this._dwellTimer = null;
      void this._ask(conv, turn);
    }, this._dwellMs);
  }

  /**
   * The gates that do not involve waiting: setting, visibility, draft, parked.
   * @returns {boolean} True when a suggestion would be welcome.
   * @private
   */
  _shouldSuggest() {
    if (!this._isEnabled()) return false;
    if (!this._isOffered()) return false;
    if (!this._isLive()) return false;
    if ((this._getDraft() || '').trim()) return false;

    // A tool parked for approval is a question the user has to answer; chat
    // suggestions under it are noise at best.
    const items = this._getItems() || [];
    try {
      if (inspectTurn(this._conversation, items).parked) return false;
    } catch {
      // A malformed item tree is not worth a broken column over.
      return false;
    }
    return true;
  }

  /**
   * Ask, then show — if the world has not moved on.
   * @param {any} conv - The conversation the request is for.
   * @param {number} turn - The turn the request is for.
   * @private
   */
  async _ask(conv, turn) {
    const controller = new AbortController();
    this._inFlight = controller;
    const suggestions = await this._generate(this._getItems() || [], { signal: controller.signal });
    if (this._inFlight === controller) this._inFlight = null;
    if (this._pending && this._pending.convId === conv.id && this._pending.turn === turn) this._pending = null;

    // The fence. Anything that moved while we were waiting means these words
    // answer a question that is no longer on screen.
    if (controller.signal.aborted) return;
    if (this._conversation !== conv) return;
    if ((conv.completedTurns ?? 0) !== turn) return;

    // Banked before asking whether to show it, and banked even when it came
    // back empty. This answer is the truth about this turn whatever the user
    // was doing when it landed, and keeping it is what stops the poll paying
    // for it a second time once they stop doing that.
    this._cache = { convId: conv.id, turn, suggestions };

    if (!this._shouldSuggest()) return;
    this._emit(suggestions);
  }

  /**
   * Abort an in-flight request and cancel a pending dwell. Does not touch what
   * is on screen — callers decide that separately, because a new turn clears
   * the row while a re-evaluation may be about to replace it.
   * @private
   */
  _cancel() {
    if (this._dwellTimer) {
      clearTimeout(this._dwellTimer);
      this._dwellTimer = null;
    }
    if (this._inFlight) {
      this._inFlight.abort();
      this._inFlight = null;
    }
    this._pending = null;
  }

  /**
   * Report suggestions, skipping a repeat of what is already shown — the row
   * is made of buttons, and rebuilding it under a press eats the press.
   * @param {string[]} suggestions - The suggestions to show.
   * @private
   */
  _emit(suggestions) {
    const next = Array.isArray(suggestions) ? suggestions : [];
    if (next.length === this._shown.length && next.every((s, i) => s === this._shown[i])) return;
    this._shown = next;
    this._onChange(next);
  }
}
