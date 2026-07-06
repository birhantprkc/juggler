//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Chime synth — generates the "needs your attention" notification tone with
 * Web Audio, no samples. Rather than a single struck note, the chime plays a
 * short **motif**: one to four notes scheduled in sequence, each voiced by a
 * metallic bell (a sine fundamental plus two quieter inharmonic partials, the
 * region a struck bell/bar lives in) under an exponential-decay envelope. Every
 * note also blooms in from just above pitch — a subtle downward micro-glide
 * that gives the voice life instead of a dead static tone.
 *
 * The melodic shape is what makes one chime read differently from another: a
 * lone tick, a rising "incoming" 4th, a major-triad arpeggio, a "ta-da", a
 * descending drop, or a four-note sparkle. The public surface stays four
 * *abstract* 0..1 parameters — pitch, pattern, length, volume — that the
 * settings UI exposes as plain rotaries. All the DSP (frequencies, partial
 * ratios, motif tables, envelope timing) lives here and is clamped into a
 * tasteful band so no setting can make the chime sound broken or alarming.
 * @module utils/chime-synth
 */

/**
 * @typedef {object} ChimeParams
 * @property {number} pitch   - 0..1, Low → High (base note frequency).
 * @property {number} pattern - 0..1, selects the melodic motif (tick → sparkle).
 * @property {number} length  - 0..1, Short → Long (note spacing + decay).
 * @property {number} volume  - 0..1, output level.
 */

/**
 * Pleasant, balanced default chime — a major-triad arpeggio at a comfortable
 * register and spacing.
 * @type {ChimeParams}
 */
export const CHIME_DEFAULTS = Object.freeze({
  pitch: 0.5,
  pattern: 0.2,
  length: 0.28,
  volume: 0.6,
});

/**
 * Motif table, ordered simple → rich. Each entry is a sequence of notes; the
 * `pattern` parameter picks one. A note is `{ s, a?, g? }`:
 *  - `s` semitone offset from the base note,
 *  - `a` accent (relative level, default 1),
 *  - `g` glide-from offset in semitones — the note starts `g` above its target
 *    and slides down into it. Small values (the default bloom) just add life;
 *    the larger value on `drop` is an audible downward portamento finish.
 * @type {ReadonlyArray<{name: string, notes: ReadonlyArray<{s: number, a?: number, g?: number}>}>}
 */
const MOTIFS = Object.freeze([
  { name: 'tick',    notes: [{ s: 0 }] },
  { name: 'rise',    notes: [{ s: 0 }, { s: 5 }] },
  { name: 'triad',   notes: [{ s: 0 }, { s: 4 }, { s: 7 }] },
  { name: 'tada',    notes: [{ s: 0, a: 0.85 }, { s: 12 }] },
  { name: 'drop',    notes: [{ s: 12 }, { s: 7 }, { s: 0, g: 5 }] },
  { name: 'sparkle', notes: [{ s: 0 }, { s: 4 }, { s: 7, a: 0.9 }, { s: 12 }] },
]);

/**
 * Inharmonic partials voicing each note: `[ratio, level]` relative to the fundamental.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const PARTIALS = Object.freeze([
  [1, 1],       // fundamental
  [2.76, 0.18], // inharmonic metallic overtone (non-integer → struck metal)
  [5.4, 0.08],  // high partial — adds high-frequency "air"
]);

/** Default per-note bloom: start this many semitones sharp and settle to pitch. */
const BLOOM_SEMITONES = 0.32;

/**
 * Linear-interpolate `v` (clamped to 0..1) into the [lo, hi] band.
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number} The interpolated value within [lo, hi].
 */
function lerp(v, lo, hi) {
  return lo + Math.max(0, Math.min(1, v)) * (hi - lo);
}

/**
 * Semitone offset → frequency multiplier (equal temperament).
 * @param {number} semitones
 * @returns {number} The frequency ratio 2^(semitones/12).
 */
function semis(semitones) {
  return Math.pow(2, semitones / 12);
}

/**
 * @typedef {object} ChimeNote
 * @property {number} freq      - Target frequency of the note's fundamental, Hz.
 * @property {number} fromFreq  - Frequency the note glides in from, Hz.
 * @property {number} at        - Onset time relative to the start of the chime, s.
 * @property {number} glide     - Time to settle from `fromFreq` to `freq`, s.
 * @property {number} decay     - Exponential decay time, s.
 * @property {number} level     - Per-note level (accent), 0..1.
 */

/**
 * Translate the abstract 0..1 params into a concrete, schedulable plan: the
 * resolved motif as a list of notes plus the master gain and total duration.
 * Pure (no AudioContext) so it can be unit-tested.
 * @param {ChimeParams} p
 * @returns {{notes: ChimeNote[], gain: number, duration: number}} The schedulable chime plan.
 */
export function mapChimeParams(p) {
  // Base note, snapped to an equal-tempered chromatic note (A=440): A4 → F#5, 10
  // in-tune steps. Snapping matters because the melody must never land between
  // notes — that reads as out-of-tune to listeners with perfect pitch. Every
  // melody note is this base plus an integer-semitone motif offset, so snapping
  // the base keeps the whole tune chromatic. A comfortable, non-piercing
  // register that still leaves headroom for the +12-semitone top of an arpeggio.
  const f0 = 440 * semis(Math.round(lerp(p.pitch, 0, 9)));
  // Spacing between note onsets and each note's decay both stretch with length:
  // short → a tight ticking cluster, long → a spread, ringing arpeggio.
  const spacing = lerp(p.length, 0.075, 0.17);
  const decay = lerp(p.length, 0.2, 0.55);
  // Output level with headroom so stacked partials never clip.
  const gain = lerp(p.volume, 0, 0.45);

  const idx = Math.min(MOTIFS.length - 1, Math.floor(Math.max(0, Math.min(1, p.pattern)) * MOTIFS.length));
  const motif = MOTIFS[idx];
  if (!motif) return { notes: [], gain, duration: 0 }; // unreachable: idx is clamped in-range
  const bloomGlide = Math.min(0.045, spacing * 0.5);

  const notes = motif.notes.map((n, i) => {
    const freq = f0 * semis(n.s);
    const g = n.g ?? BLOOM_SEMITONES;
    return {
      freq,
      fromFreq: freq * semis(g),
      at: i * spacing,
      // A large, deliberate glide (the `drop` finish) settles over the note's
      // own decay; the subtle bloom settles almost instantly.
      glide: n.g ? Math.min(decay, 0.18) : bloomGlide,
      decay,
      level: n.a ?? 1,
    };
  });

  const last = notes[notes.length - 1];
  const duration = last ? last.at + 0.005 + last.decay : 0;
  return { notes, gain, duration };
}

/** @type {AudioContext|null} Lazily created; shared for the document's life. */
let ctx = null;

/**
 * Report an untoward audio event to the APPLICATION log — not the browser
 * console. Every failure in this module is best-effort and swallowed by design
 * (a parked context simply doesn't sound), which otherwise leaves a silent chime
 * — or a silent settings Preview — with no clue why. The desktop app's WebView
 * console is invisible in a shipped build, so a fault a real user hits would
 * leave no trace to send us; this POSTs it to the shared frontend→app-log bridge
 * ({@link module:cmd/juggler/server/client_report} / `POST /api/client/report`)
 * tagged source="chime", at Info (`level` "info") or Error ("error").
 *
 * Fire-and-forget and fully swallowed — reporting a fault must never throw back
 * into the audio path. Reserved for genuinely untoward events (a wedged/rebuilt
 * context, a resume that never recovers, a fresh context that comes up
 * `interrupted`, no Web Audio at all); routine state transitions are deliberately
 * NOT reported, so the app log — like the console — stays quiet unless something
 * actually went wrong.
 * @param {'info'|'error'} level
 * @param {string} message
 * @returns {void}
 */
function areport(level, message) {
  try {
    if (typeof fetch !== 'function') return;
    fetch('/api/client/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'chime', event: level, message }),
    }).catch(() => { /* reporting a fault must never surface as an error itself */ });
  } catch { /* fetch unavailable (tests/workers) — never throw into the audio path */ }
}

/**
 * Resume a parked context. The shared AudioContext is created once and kept for
 * the document's life, so any state other than `running` means *every* later
 * chime is scheduled against a clock that isn't advancing — i.e. silence — until
 * the app restarts. Two states park it:
 *  - `suspended`: the autoplay-policy start state, lifted by a user gesture.
 *  - `interrupted`: a non-standard WebKit state (the desktop app runs in a
 *    WKWebView). The OS audio session gets interrupted by an output-device
 *    change (headphones in/out, AirPods), system sleep/wake, or another app
 *    grabbing audio. It does **not** recover on its own.
 * Resuming on anything that isn't `running` (rather than only `suspended`) clears
 * the common cases; a stubborn `interrupted` session that resume() can't revive is
 * handled by {@link unlockAudio}, which rebuilds the context from inside a user
 * gesture (see {@link isContextWedged}). `resume()` on a `closed` context rejects
 * harmlessly — the rejection handler reports it to the app log and never rethrows.
 * @param {AudioContext} ac
 * @returns {void}
 */
export function wakeContext(ac) {
  if (ac.state === 'running') return;
  const from = ac.state;
  ac.resume().then(
    () => { /* resumed to `running` — the routine case, not reported */ },
    // Stays parked until the next attempt/gesture. A rejection handler (not a
    // bare .catch) so a stuck `interrupted`/`closed` session lands in the app log,
    // while still never surfacing as an unhandled rejection.
    () => areport('error', `resume() from ${from} rejected — still ${ac.state}`),
  );
}

/**
 * Is this context wedged past what resume() can fix — so a caller inside a user
 * gesture should rebuild it rather than resume it? Two states qualify:
 *  - `closed`: terminal; resume() rejects forever.
 *  - `interrupted`: the WKWebView stuck state (see the module notes and
 *    {@link wakeContext}). resume() *sometimes* clears it, but when the OS audio
 *    session stays wedged it never does, leaving every chime — including the
 *    settings Preview — silent with no error. From inside a gesture the reliable
 *    cure is to discard the context and build a fresh one against the current
 *    output device.
 * Pure (needs no AudioContext) so the decision is unit-testable.
 * @param {{state: string} | null | undefined} ac
 * @returns {boolean} True when the context should be rebuilt, not resumed.
 */
export function isContextWedged(ac) {
  return !ac || ac.state === 'closed' || ac.state === 'interrupted';
}

/**
 * Tear down the shared context so the next {@link audioContext}
 * builds a fresh one against the current output device. The escape hatch for a
 * context wedged past resume() (see {@link isContextWedged}); the old context is
 * closed best-effort and its handles dropped.
 * @returns {void}
 * @private
 */
function recreateContext() {
  const dead = ctx;
  ctx = null;
  if (dead) {
    dead.onstatechange = null; // don't let the pending close() re-enter wakeContext
    if (dead.state !== 'closed') {
      try {
        dead.close().catch(() => { /* already closing/closed */ });
      } catch { /* close() didn't return a promise, or context already gone */ }
    }
  }
}

/**
 * Resolve (lazily creating) the shared AudioContext. Returns null if Web Audio
 * is unavailable. Browsers start the context `suspended` until a user gesture;
 * callers that run inside a gesture should also call {@link unlockAudio}.
 * @returns {AudioContext|null} The shared context, or null when Web Audio is unavailable.
 * @private
 */
function audioContext() {
  // A closed context can never resume — discard it so we build a fresh one below.
  if (ctx && ctx.state === 'closed') recreateContext();
  if (ctx) return ctx;
  const Ctor = /** @type {any} */ (window).AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!Ctor) return null;
  let ac;
  try {
    ac = new Ctor();
  } catch {
    return null;
  }
  // Proactively heal a parked context the moment it parks: an output-device swap
  // or sleep/wake can flip the session to `suspended`/`interrupted` mid-run, and
  // resuming on that transition keeps the next chime ready without waiting for a
  // click. (A gesture still rebuilds when resume() can't clear it — see
  // unlockAudio.) Best-effort, not load-bearing: playChime's play-time recovery
  // (recoverThenSchedule) covers the same ground if onstatechange is unsupported
  // or never fires.
  // A fresh context normally comes up `suspended`; coming up `interrupted` means
  // the OS audio session is wedged below the web layer, where no JS resume can
  // reach — the smoking gun for the total-shutdown case, so surface it.
  if (ac.state === 'interrupted') {
    areport('error', 'fresh AudioContext came up interrupted — OS audio session wedged below the web layer');
  }
  try {
    ac.onstatechange = () => {
      // Report only the OS parking the session live; routine suspend/resume churn
      // isn't worth an app-log line.
      if (ac.state === 'interrupted') areport('info', 'audio session parked (onstatechange → interrupted)');
      wakeContext(ac);
    };
  } catch { /* onstatechange unsettable — play-time recoverThenSchedule still covers it */ }
  ctx = ac;
  return ac;
}

/**
 * Resume the AudioContext from within a user gesture (a click/keypress). Autoplay
 * policy keeps a context `suspended` until this runs at least once; wiring it to
 * the settings "preview" button and the mute toggle is enough to unlock playback
 * for the rest of the session. Safe to call repeatedly.
 * @returns {void}
 */
export function unlockAudio() {
  let ac = audioContext();
  if (!ac) { areport('error', 'unlockAudio: Web Audio unavailable'); return; }
  // Inside a user gesture we can afford the heavy hammer. If the context is wedged
  // past what resume() can fix — a stale `interrupted` session, or a `closed`
  // context — rebuild it fresh against the current output device so this gesture
  // (the settings Preview button or the header bell) reliably restores sound. This
  // is the recovery playChime's play-time resume() path can't perform on its own.
  if (isContextWedged(ac)) {
    areport('info', `unlockAudio: context wedged (${ac.state}) — rebuilding against current device`);
    recreateContext();
    ac = audioContext();
    if (!ac) { areport('error', 'unlockAudio: rebuild failed — Web Audio unavailable'); return; }
  }
  wakeContext(ac);
}

/**
 * Best-effort re-arm of an already-unlocked context, for a *passive* wake signal
 * (window focus / tab becoming visible) rather than a click. Only touches an
 * existing context — it never *creates* one: with no prior unlock gesture there's
 * nothing warmed to lose, and a fresh context would just sit `suspended` until a
 * real gesture anyway.
 *
 * This closes a gap the {@link audioContext} `onstatechange` handler can't cover:
 * when the OS parks the session while the app is backgrounded, the resume() fired
 * on that transition is rejected (a hidden tab isn't allowed to start audio), and
 * `onstatechange` won't fire again because the state doesn't change. Retrying on
 * the focus/visibility edge — the first moment a resume() is actually permitted —
 * revives the context so the next chime plays warm, with no user click.
 * @returns {void}
 */
export function rearmAudio() {
  if (ctx) wakeContext(ctx);
}

/** Retry budget + spacing for driving a parked context to `running` at play time. */
const RECOVER_RETRIES = 3;
const RECOVER_RETRY_MS = 250;

/**
 * Drive a parked context to `running`, then schedule the chime on it — or give up.
 *
 * The automatic alert path fires with no user gesture, so at trigger time the
 * shared context may be `suspended` (autoplay start), `interrupted` (the WKWebView
 * session wedge), or `closed`. Scheduling notes straight away would pin them to a
 * clock that isn't advancing — they'd be dropped, or fire in a clump when it wakes
 * — so we resume FIRST and only schedule once the state is actually `running`:
 *  - `suspended`/`interrupted` that resume() can clear → resumes, then schedules.
 *  - `interrupted`/`closed` that resume() can't → rebuilds the context ONCE (as
 *    {@link unlockAudio} does inside a gesture) and drives the fresh one.
 *  - transient failures → retries a bounded number of times, spaced by `defer`.
 *  - exhausted → logs the terminal state. This is the residual an OS-level session
 *    wedge leaves: nothing in JS can start audio the OS is actively blocking, so
 *    we surface it rather than swallow it.
 *
 * The context factory (`rebuild`), the scheduler (`schedule`), and the retry timer
 * (`defer`) are injected so this control flow is unit-testable without a real
 * AudioContext. Every resume() has a rejection handler, so retries never surface
 * as unhandled rejections.
 * @param {AudioContext} ac - The context to drive.
 * @param {(ac: AudioContext) => void} schedule - Builds+starts the voice graph on a running context.
 * @param {() => AudioContext|null} rebuild - Discards the wedged context and returns a fresh one (or null).
 * @param {{retries?: number, defer?: (fn: () => void) => void}} [opts]
 * @returns {void}
 */
export function recoverThenSchedule(ac, schedule, rebuild, { retries = RECOVER_RETRIES, defer = (fn) => setTimeout(fn, RECOVER_RETRY_MS) } = {}) {
  /**
   * @param {AudioContext} context - Context for this attempt (the original, or a rebuilt one).
   * @param {number} triesLeft - Remaining resume retries.
   * @param {boolean} rebuilt - Whether the one-shot rebuild has already been spent.
   */
  const attempt = (context, triesLeft, rebuilt) => {
    if (context.state === 'running') { schedule(context); return; }
    // Wedged past what resume() can fix: rebuild once against the current output
    // device, then drive the fresh context (which starts `suspended` → resume).
    if (!rebuilt && isContextWedged(context)) {
      areport('info', `playChime: context wedged (${context.state}) — rebuilding`);
      const fresh = rebuild();
      if (!fresh) { areport('error', 'playChime: rebuild failed — Web Audio unavailable'); return; }
      attempt(fresh, triesLeft, true);
      return;
    }
    context.resume().then(
      () => {
        if (context.state === 'running') schedule(context);
        else if (triesLeft > 0) defer(() => attempt(context, triesLeft - 1, rebuilt));
        else areport('error', `playChime: gave up after ${retries} tries — state=${context.state}`);
      },
      () => {
        if (triesLeft > 0) defer(() => attempt(context, triesLeft - 1, rebuilt));
        else areport('error', `playChime: resume() rejected, gave up after ${retries} tries — state=${context.state}`);
      },
    );
  };
  attempt(ac, retries, false);
}

/**
 * Play one chime with the given abstract parameters. No-op (resolves silently)
 * when Web Audio is unavailable. If the shared context is already `running` the
 * voice graph is scheduled immediately (the healthy path — no added latency);
 * otherwise the context is recovered first and the chime scheduled once it's live
 * (see {@link recoverThenSchedule}), so a chime firing against a parked or wedged
 * session still sounds instead of being lost against a frozen clock. Each call
 * builds a fresh, self-disposing voice graph — there is no persistent state to leak.
 * @param {Partial<ChimeParams>} [params] - Overrides merged over CHIME_DEFAULTS.
 * @returns {void}
 */
export function playChime(params = {}) {
  const ac = audioContext();
  if (!ac) { areport('error', 'playChime: Web Audio unavailable — chime dropped'); return; }
  const plan = mapChimeParams({ ...CHIME_DEFAULTS, ...params });
  if (ac.state === 'running') { scheduleChime(ac, plan); return; }
  recoverThenSchedule(
    ac,
    (context) => scheduleChime(context, plan),
    () => { recreateContext(); return audioContext(); },
  );
}

/**
 * Build and start the self-disposing voice graph for one chime on a *running*
 * context. The motif is scheduled relative to `ac.currentTime` read here, so this
 * must run only once the context is live — otherwise the notes pin to a clock that
 * isn't advancing (the whole reason {@link recoverThenSchedule} gates on `running`).
 * @param {AudioContext} ac - A running context.
 * @param {{notes: ChimeNote[], gain: number, duration: number}} plan - The mapped chime plan.
 * @returns {void}
 * @private
 */
function scheduleChime(ac, { notes, gain, duration }) {
  const start = ac.currentTime;
  const attack = 0.005; // near-instant strike

  // Shared master so `volume` scales the whole motif and the stacked notes share
  // one route to the speakers.
  const master = ac.createGain();
  master.gain.value = gain;
  master.connect(ac.destination);

  /**
   * Schedule one note: its strike envelope plus the partials voicing it, each
   * gliding in from `fromFreq` to `freq`.
   * @param {ChimeNote} note
   */
  const playNote = (note) => {
    const t0 = start + note.at;
    const end = t0 + attack + note.decay;

    // Exponential-decay envelope. exponentialRamp can't reach 0, so we strike to
    // a small floor and ramp to a near-silent target, then hard-stop.
    const env = ac.createGain();
    env.connect(master);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(note.level, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    for (const [ratio, level] of PARTIALS) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.fromFreq * ratio, t0);
      osc.frequency.exponentialRampToValueAtTime(note.freq * ratio, t0 + note.glide);
      const g = ac.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(env);
      osc.start(t0);
      osc.stop(end + 0.05);
      osc.onended = () => {
        osc.disconnect();
        g.disconnect();
      };
    }

    // Drop the note's envelope once its tail has rung out.
    setTimeout(() => {
      try {
        env.disconnect();
      } catch { /* already gone */ }
    }, (note.at + attack + note.decay + 0.1) * 1000 + 50);
  };

  notes.forEach(playNote);

  // Tear the shared master down once the whole motif has finished.
  setTimeout(() => {
    try {
      master.disconnect();
    } catch { /* already gone */ }
  }, (duration + 0.1) * 1000 + 50);
}
