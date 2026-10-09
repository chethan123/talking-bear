// A discrete-event environment simulator for the session reducer's property tests (plan §4.9.1, issue #29).
// It drives `reduce` against a model of the world the effect runner talks to: the named timers, the mic stream,
// the audio context, the capture worklet and worker, the voice player and the sfx scheduler. Time is simulated:
// `now` only moves when the sim delivers a due item or an injection lets a little time pass.
// Test-only code: nothing in the app imports it.

import {
  DEFAULT_CONFIG,
  type Effect,
  type EventType,
  type Permission,
  type Priority,
  type SessionConfig,
  type SessionEvent,
  type SessionState,
  type SfxId,
  type TimerName,
} from '../src/app/events.ts';
import { initialSessionState, reduce } from '../src/app/machine.ts';
import { CUSTOM_PITCH_MAX, CUSTOM_PITCH_MIN, parseSettings, presetFor } from '../src/app/settings.ts';
import type { SegEvent } from '../src/dsp/segmenter.ts';
import { PRESETS, type VoicePreset } from '../src/dsp/types.ts';
import { CUSTOM_PITCH_STEP } from '../src/ui/settings-sheet.ts';

/** A source of uniform numbers in [0, 1). The property tests feed it from fast-check values. */
export type SimRng = () => number;

/** What an `openMic` request answers. `mixed` draws per request: 80 % granted, 10 % denied, 10 % no device. */
export type MicMode = 'granted' | 'denied' | 'noDevice' | 'mixed';

export interface SimOptions {
  /** Initial permission (default `granted`). */
  permission?: Permission;
  /** How `openMic` requests are answered (default `granted`). */
  mic?: MicMode;
  /** Reducer timing (default `DEFAULT_CONFIG`). */
  cfg?: SessionConfig;
  /**
   * Lose this share of `openMic` answers, `clipReady`s and `processed`s, so the waking and processing timeouts
   * fire (default 0: nothing is lost, and no extra random draw is made).
   */
  lossRate?: number;
  /**
   * #116: a noisy room: every `seg` end the sim makes is a cap (`maxLength`) with a voiced ratio below 0.3
   * (default false: the reason is drawn as before and the ratio is uniform in [0, 1)); the worker also caps every
   * VAD-started take after maxUtteranceMs, and in hold-to-talk mode it still reports an onset after each arm.
   */
  noisy?: boolean;
  /**
   * #289: the VAD backend the noisy worker model stands for (default 'silero'). On 'energy' its cap is the voicing
   * rule's misfire of a capped segment, `{ kind: 'misfire', frame, reason: 'maxLength', voicedRatio: 0 }`, rather
   * than a `maxLength` end; nothing else changes and no draw is added.
   */
  backend?: 'silero' | 'energy';
  /** Fields applied over the initial (Asleep) state, e.g. a noisy mode one cap short of hold-to-talk (#116). */
  initial?: Partial<SessionState>;
}

/** The simulated context rate: resumeCtx answers `ctxRunning{48000}`, and ctx frames are `now · 48`. */
export const SIM_SAMPLE_RATE = 48_000;
const FRAMES_PER_MS = SIM_SAMPLE_RATE / 1000;
/** Delays and lengths of the simulated environment (issue #29). */
export const MIC_RESULT_MS = 200;
export const CTX_RUNNING_MS = 20;
export const CLIP_READY_EXTRA_MS = 5;
export const PROCESSED_MS = 30;
export const PLAYBACK_TAIL_MS = 50;
export const SFX_MS = 400;
export const MIN_DURATION_SEC = 0.2;
export const MAX_DURATION_SEC = 7;
/** `step` injects a random event with this probability (otherwise it delivers the earliest due item). */
export const INJECT_PROBABILITY = 0.3;
/** An injection lets at most this much time pass first, and never past the next due item. */
export const MAX_INJECT_ADVANCE_MS = 2000;

/** The audibility horizon when an `arm` effect was applied (property 1). */
export interface ArmCheck {
  readonly at: number;
  readonly voiceUntil: number;
  readonly sfxUntil: number;
}

/** One `reduce` call made by the sim, with the world as it was when its effects were applied. */
export interface Transition {
  readonly index: number;
  /** Simulated time of the dispatch (ms). */
  readonly at: number;
  /** `deliver`: a due timer or environment callback; `inject`: the random pool; `dispatch`: a direct call. */
  readonly source: 'deliver' | 'inject' | 'dispatch';
  readonly event: SessionEvent;
  /** The event carries a stale epoch, id or mic `req` (property 5). */
  readonly stale: boolean;
  readonly prev: SessionState;
  readonly next: SessionState;
  readonly effects: readonly Effect[];
  readonly arms: readonly ArmCheck[];
}

interface Pending {
  readonly due: number;
  readonly order: number;
  readonly event: SessionEvent;
}

/** Every event type the random pool injects (current or stale). The rest are in `SIM_ONLY_KINDS`. */
export const POOL_KINDS = [
  'tapBear',
  'parentContinue',
  'settingsRetry',
  'permissionChanged',
  'ctxRunning',
  'ctxResumeFailed',
  'ctxError',
  'armed',
  'seg',
  'floorSnapshot',
  'clipReady',
  'takeFailed',
  'processed',
  'fxError',
  'reaction',
  'trackMuted',
  'trackUnmuted',
  'trackEnded',
  'inputsChanged',
  'workerFailed',
  'hidden',
  'pagehide',
  'freeze',
  'visible',
  'updateReady',
  'settingsChanged',
  'noiseFloor',
  'holdStart',
  'holdEnd',
] as const satisfies readonly EventType[];
export type PoolKind = (typeof POOL_KINDS)[number];

/**
 * The event types the pool never injects, because the sim schedules them itself: the mic results answer
 * an `openMic`, `timer` fires a pending named timer, and the at-speaker events follow `play` and `sfx`.
 * Injected at random, they would model an impossible world (an sfx that ended while still audible).
 */
export const SIM_ONLY_KINDS = [
  'micGranted',
  'micDenied',
  'noDevice',
  'timer',
  'playbackAtSpeakerEnded',
  'sfxAtSpeakerEnded',
] as const satisfies readonly EventType[];
export type SimOnlyKind = (typeof SIM_ONLY_KINDS)[number];

/** Compiles only if `T` is `never`; otherwise tsc names the offending kinds. */
type MustBeNever<T extends never> = T;
// tsc fails here on an unlisted SessionEvent type: add it to POOL_KINDS (and `make`) or to SIM_ONLY_KINDS.
export type UnclassifiedKind = MustBeNever<Exclude<EventType, PoolKind | SimOnlyKind>>;
// tsc fails here on a type listed in both: keep it in one.
export type DoublyClassifiedKind = MustBeNever<Extract<PoolKind, SimOnlyKind>>;

/** The pool kinds that carry an epoch or a take id: the liveness phase injects only their stale variants. */
export const STALE_KINDS = [
  'armed',
  'seg',
  'floorSnapshot',
  'clipReady',
  'takeFailed',
  'processed',
  'fxError',
] as const;

const PERMISSIONS: readonly Permission[] = ['granted', 'prompt', 'denied'];
const PRIORITIES: readonly Priority[] = [1, 2, 3, 4];
const REACTION_NAMES: readonly string[] = ['tap', 'poke', 'tickle', 'hug'];
const SFX_IDS: readonly SfxId[] = ['boing', 'sneeze', 'giggle', 'hm', 'pop', 'purr'];
const SEG_KINDS: readonly SegEvent['kind'][] = ['start', 'end', 'misfire'];
/** The named presets: the shared `PRESETS` entries, which `presetFor` returns for a named voice. */
const NAMED_PRESETS: readonly VoicePreset[] = Object.values(PRESETS);
/**
 * The custom pitch slider's values (settings sheet): `CUSTOM_PITCH_MIN` to `CUSTOM_PITCH_MAX` in steps of
 * `CUSTOM_PITCH_STEP`, that is 0.7, 0.75, …, 2.2. Each is the double nearest its decimal, as the app reads
 * `Number(slider.value)`, not the sum `0.7 + 2 · 0.05 = 0.7999999999999999`.
 */
const CUSTOM_PITCH_GRID: readonly number[] = Array.from(
  { length: Math.round((CUSTOM_PITCH_MAX - CUSTOM_PITCH_MIN) / CUSTOM_PITCH_STEP) + 1 },
  (_, i) => Number((CUSTOM_PITCH_MIN + i * CUSTOM_PITCH_STEP).toPrecision(12)),
);
/** The worker blocks onsets this long after arm, so a plausible onset is at least this far after it. */
const ONSET_AFTER_ARM_MS = 100;
const MAX_ONSET_AGE_MS = 100;
const MAX_HANGOVER_MS = 800;
/** #116: in a noisy room in hold-to-talk mode, the VAD's onset this long after each arm. */
const NOISY_ONSET_MS = 300;

const pick = <T>(rng: SimRng, xs: readonly T[]): T => {
  const x = xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
  if (x === undefined) throw new Error('pick from an empty list');
  return x;
};

export class SessionSim {
  state: SessionState;
  /** Simulated time (ms). */
  now = 0;
  /** Pending named timers: name → due time (ms). Insertion order breaks ties. */
  readonly timers = new Map<TimerName, number>();
  /** The mic stream is live. */
  micOpen = false;
  /** The replay is audible until this time (ms). */
  audibleVoiceUntil = 0;
  /** The latest sfx is audible until this time (ms). */
  audibleSfxUntil = 0;
  latestSfxSeq = 0;
  /** The worklet is armed: set by `arm`, cleared by `disarm` and `closeMic`. */
  armed = false;
  /** The ctx frame of the latest `arm` (plausible `armed` and `seg` payloads). */
  armFrame: number | null = null;
  readonly effectsLog: { readonly at: number; readonly fx: Effect }[] = [];
  readonly log: Transition[] = [];
  /** `openMic` effects applied while the stream was still open (a leaked stream; property 8). */
  openWhileOpen = 0;

  private readonly cfg: SessionConfig;
  private readonly mic: MicMode;
  private readonly lossRate: number;
  private readonly noisy: boolean;
  private readonly backend: 'silero' | 'energy';
  /** Environment callbacks, sorted by due time, then by scheduling order. */
  private readonly queue: Pending[] = [];
  private order = 0;
  /** `openMic` requests not yet answered and not cancelled by `closeMic`. */
  private readonly outstandingMic = new Set<number>();
  /** `openMic` requests that `closeMic` cancelled before they were answered. */
  private readonly cancelledMic = new Set<number>();
  /** durationSec of each `processed` event dispatched, by id (`play` reads it). */
  private readonly durations = new Map<number, number>();
  /**
   * The rng of the latest step: effects draw from it (`process` durations, `mixed` mic answers, the loss mode).
   * A `dispatch` outside `step` reuses it (`() => 0.5` before the first step).
   */
  private rng: SimRng = () => 0.5;

  constructor(opts: SimOptions = {}) {
    this.cfg = opts.cfg ?? DEFAULT_CONFIG;
    this.mic = opts.mic ?? 'granted';
    this.lossRate = opts.lossRate ?? 0;
    this.noisy = opts.noisy ?? false;
    this.backend = opts.backend ?? 'silero';
    this.state = { ...initialSessionState(opts.permission ?? 'granted'), ...opts.initial };
  }

  /** The current ctx frame. */
  nowFrame(): number {
    return Math.round(this.now * FRAMES_PER_MS);
  }

  /** Runs `reduce`, then applies every effect to the model, in order. */
  dispatch(e: SessionEvent, source: Transition['source'] = 'dispatch'): Transition {
    const prev = this.state;
    const stale = this.isStale(e, prev);
    if (e.t === 'micGranted' || e.t === 'micDenied' || e.t === 'noDevice') {
      // The runner keeps a granted stream only while its request is current; it stops a stale one at once.
      const current = this.outstandingMic.delete(e.req);
      if (current && e.t === 'micGranted') this.micOpen = true;
    }
    if (e.t === 'processed') this.durations.set(e.id, e.durationSec);
    const { state, effects } = reduce(prev, e, this.cfg);
    this.state = state;
    const arms: ArmCheck[] = [];
    for (const fx of effects) this.apply(fx, arms);
    const t: Transition = {
      index: this.log.length,
      at: this.now,
      source,
      event: e,
      stale,
      prev,
      next: state,
      effects,
      arms,
    };
    this.log.push(t);
    return t;
  }

  /**
   * One simulation step. With probability 0.3 it injects a random event from the pool (with `allowUser`
   * false, only a stale epoch/id variant, which property 5 makes inert); otherwise it delivers the earliest due
   * item, advancing `now`. Returns null when nothing happened: nothing is pending and nothing may be injected.
   */
  step(rng: SimRng, allowUser: boolean): Transition | null {
    this.rng = rng;
    const nextDue = this.nextDue();
    if (nextDue === null && !allowUser) return null; // nothing pending, and nothing current may be injected
    if (nextDue !== null && rng() < 1 - INJECT_PROBABILITY) return this.deliver();
    if (rng() >= 0.5) {
      // Let some time pass first, never past the next due item.
      const room =
        nextDue === null ? MAX_INJECT_ADVANCE_MS : Math.min(MAX_INJECT_ADVANCE_MS, nextDue - this.now);
      this.now += Math.floor(rng() * Math.max(0, room));
    }
    return this.dispatch(allowUser ? this.randomEvent(rng) : this.randomStaleEvent(rng), 'inject');
  }

  /** Something (a timer or an environment callback) is pending. */
  hasPending(): boolean {
    return this.nextDue() !== null;
  }

  /** Every stale variant of the epoch-, id- and req-carrying events for the current state (property 5). */
  staleVariants(): SessionEvent[] {
    const s = this.state;
    const frame = this.nowFrame();
    const oldEpoch = s.epoch - 1;
    const oldId = s.takeId - 1;
    const out: SessionEvent[] = [
      { t: 'seg', epoch: oldEpoch, ev: { kind: 'start', frame } },
      {
        t: 'seg',
        epoch: oldEpoch,
        ev: { kind: 'end', frame, lastSpeechFrame: frame, reason: 'silence', voicedRatio: 0.1 },
      },
      {
        t: 'seg',
        epoch: oldEpoch,
        ev: { kind: 'end', frame, lastSpeechFrame: frame, reason: 'maxLength', voicedRatio: 0.1 },
      },
      { t: 'seg', epoch: oldEpoch, ev: { kind: 'misfire', frame } },
      { t: 'seg', epoch: oldEpoch, ev: { kind: 'misfire', frame, reason: 'maxLength', voicedRatio: 0 } }, // #289
      { t: 'armed', epoch: oldEpoch, armFrame: frame },
      { t: 'floorSnapshot', epoch: oldEpoch, floorDb: -50 },
      { t: 'clipReady', epoch: oldEpoch, id: s.takeId },
      { t: 'clipReady', epoch: s.epoch, id: oldId },
      { t: 'clipReady', epoch: oldEpoch, id: oldId },
      { t: 'takeFailed', epoch: oldEpoch, id: s.takeId },
      { t: 'takeFailed', epoch: s.epoch, id: oldId },
      { t: 'takeFailed', epoch: oldEpoch, id: oldId },
      { t: 'processed', id: oldId, durationSec: 1, clipped: false },
      { t: 'fxError', id: oldId },
    ];
    // An older request, and the current one once closeMic has cancelled it unanswered.
    const reqs = [s.micReq - 1, ...(this.cancelledMic.has(s.micReq) ? [s.micReq] : [])];
    for (const req of reqs)
      out.push({ t: 'micGranted', req }, { t: 'micDenied', req }, { t: 'noDevice', req });
    return out;
  }

  /** The dispatched events with their transitions, one per line (the last `max` of them). */
  formatTrace(max = 200): string {
    const shown = this.log.slice(-max);
    const lines = shown.map((t) => {
      const to = t.next === t.prev ? `${t.prev.name} (same object)` : `${t.prev.name} -> ${t.next.name}`;
      const fx = t.effects.map(formatEffect).join(', ');
      const ev = `${formatEvent(t.event)}${t.stale ? ' (stale)' : ''}`;
      return `  #${t.index} t=${t.at.toFixed(1)}ms ${t.source} ${ev}: ${to} [${fx}]`;
    });
    const skipped = this.log.length - shown.length;
    return [
      `trace (${this.log.length} events${skipped > 0 ? `, first ${skipped} omitted` : ''}):`,
      ...lines,
    ].join('\n');
  }

  // ---- internals ---------------------------------------------------------------------------------------

  private isStale(e: SessionEvent, s: SessionState): boolean {
    switch (e.t) {
      case 'seg':
      case 'armed':
      case 'floorSnapshot':
        return e.epoch !== s.epoch;
      case 'clipReady':
      case 'takeFailed':
        return e.epoch !== s.epoch || e.id !== s.takeId;
      case 'processed':
      case 'fxError':
        return e.id !== s.takeId;
      case 'micGranted':
      case 'micDenied':
      case 'noDevice':
        return e.req !== s.micReq || !this.outstandingMic.has(e.req);
      default:
        return false;
    }
  }

  private apply(fx: Effect, arms: ArmCheck[]): void {
    switch (fx.k) {
      case 'timer':
        this.timers.delete(fx.name); // re-insert, so insertion order breaks ties by scheduling order
        this.timers.set(fx.name, this.now + fx.ms);
        if (fx.name === 'recording') this.noisyCap();
        break;
      case 'cancelTimer':
        if (fx.name === '*') this.timers.clear();
        else this.timers.delete(fx.name);
        break;
      case 'openMic': {
        if (this.micOpen) this.openWhileOpen++;
        this.outstandingMic.add(fx.req);
        const answer = this.micAnswer();
        if (this.lost()) break;
        this.schedule(this.now + MIC_RESULT_MS, { t: answer, req: fx.req });
        break;
      }
      case 'closeMic':
        // Pending answers are still delivered, as stale events.
        this.micOpen = false;
        this.armed = false;
        for (const req of this.outstandingMic) this.cancelledMic.add(req);
        this.outstandingMic.clear();
        break;
      case 'resumeCtx':
        this.schedule(this.now + CTX_RUNNING_MS, { t: 'ctxRunning', sampleRate: SIM_SAMPLE_RATE });
        break;
      case 'take': {
        if (this.lost()) break;
        const waitMs = Math.max(0, fx.toFrame - this.nowFrame()) / FRAMES_PER_MS;
        this.schedule(this.now + waitMs + CLIP_READY_EXTRA_MS, {
          t: 'clipReady',
          epoch: fx.epoch,
          id: fx.id,
        });
        break;
      }
      case 'process': {
        if (this.lost()) break;
        const durationSec = MIN_DURATION_SEC + this.rng() * (MAX_DURATION_SEC - MIN_DURATION_SEC);
        // #117: every other take is clipped, by id (no rng draw), so row 28 runs with and without lastClipped.
        this.schedule(this.now + PROCESSED_MS, {
          t: 'processed',
          id: fx.id,
          durationSec,
          clipped: fx.id % 2 === 0,
        });
        break;
      }
      case 'play': {
        const durationSec = this.durations.get(fx.id);
        if (durationSec === undefined) throw new Error(`sim: play{${fx.id}} without a processed event`);
        this.audibleVoiceUntil = this.now + durationSec * 1000 + PLAYBACK_TAIL_MS;
        this.schedule(this.audibleVoiceUntil, { t: 'playbackAtSpeakerEnded', id: fx.id });
        break;
      }
      case 'stopPlayback':
        this.audibleVoiceUntil = Math.min(this.audibleVoiceUntil, this.now);
        this.audibleSfxUntil = Math.min(this.audibleSfxUntil, this.now);
        this.cancel('playbackAtSpeakerEnded');
        this.cancel('sfxAtSpeakerEnded');
        break;
      case 'sfx':
        this.latestSfxSeq = fx.seq;
        this.audibleSfxUntil = Math.max(this.audibleSfxUntil, this.now + SFX_MS);
        this.cancel('sfxAtSpeakerEnded');
        this.schedule(this.audibleSfxUntil, { t: 'sfxAtSpeakerEnded', seq: fx.seq });
        break;
      case 'arm':
        arms.push({ at: this.now, voiceUntil: this.audibleVoiceUntil, sfxUntil: this.audibleSfxUntil });
        this.armed = true;
        this.armFrame = this.nowFrame();
        this.noisyOnset(fx.epoch);
        break;
      case 'disarm':
        this.armed = false;
        break;
      default: // suspendCtx, restartWorker, wakeLock, anim, reselectInput, ui, applyUpdate: recorded only
        break;
    }
    this.effectsLog.push({ at: this.now, fx });
  }

  /**
   * #116: in a noisy room the worker caps a take that the VAD started, with a low voiced ratio, after
   * maxUtteranceMs: before the recording watchdog (maxUtteranceMs + 2 s). On the energy backend the cap is the
   * voicing rule's capped misfire, which carries its reason and voiced ratio (#289). Not in hold-to-talk mode,
   * where the timer is the cap itself. A take that ends earlier leaves the end stale or ignored.
   */
  private noisyCap(): void {
    const s = this.state;
    if (!this.noisy || s.name !== 'Recording' || s.holdToTalk) return;
    const frame = this.nowFrame() + this.cfg.maxUtteranceMs * FRAMES_PER_MS;
    this.schedule(this.now + this.cfg.maxUtteranceMs, {
      t: 'seg',
      epoch: s.epoch,
      ev:
        this.backend === 'energy'
          ? { kind: 'misfire', frame, reason: 'maxLength', voicedRatio: 0 }
          : { kind: 'end', frame, lastSpeechFrame: frame, reason: 'maxLength', voicedRatio: 0.1 },
    });
  }

  /** #116: in hold-to-talk mode the VAD still segments the noise: an onset 300 ms after each arm (ignored). */
  private noisyOnset(epoch: number): void {
    if (!this.noisy || !this.state.holdToTalk) return;
    this.schedule(this.now + NOISY_ONSET_MS, {
      t: 'seg',
      epoch,
      ev: { kind: 'start', frame: this.nowFrame() + NOISY_ONSET_MS * FRAMES_PER_MS },
    });
  }

  private lost(): boolean {
    return this.lossRate > 0 && this.rng() < this.lossRate;
  }

  private micAnswer(): 'micGranted' | 'micDenied' | 'noDevice' {
    switch (this.mic) {
      case 'granted':
        return 'micGranted';
      case 'denied':
        return 'micDenied';
      case 'noDevice':
        return 'noDevice';
      default: {
        const r = this.rng();
        return r < 0.8 ? 'micGranted' : r < 0.9 ? 'micDenied' : 'noDevice';
      }
    }
  }

  private schedule(due: number, event: SessionEvent): void {
    const item: Pending = { due, order: this.order++, event };
    let i = this.queue.length;
    while (i > 0) {
      const before = this.queue[i - 1];
      if (before === undefined || before.due <= due) break;
      i--;
    }
    this.queue.splice(i, 0, item);
  }

  private cancel(t: 'playbackAtSpeakerEnded' | 'sfxAtSpeakerEnded'): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.event.t === t) this.queue.splice(i, 1);
    }
  }

  /** The earliest pending timer: [name, due]; ties go to the one set first. */
  private nextTimer(): [TimerName, number] | null {
    let best: [TimerName, number] | null = null;
    for (const [name, due] of this.timers) if (best === null || due < best[1]) best = [name, due];
    return best;
  }

  private nextDue(): number | null {
    const timer = this.nextTimer();
    const env = this.queue[0];
    if (timer === null) return env === undefined ? null : env.due;
    return env === undefined ? timer[1] : Math.min(env.due, timer[1]);
  }

  /** Delivers the earliest due item (an environment callback wins a tie with a timer). */
  private deliver(): Transition {
    const timer = this.nextTimer();
    const env = this.queue[0];
    if (env !== undefined && (timer === null || env.due <= timer[1])) {
      this.queue.shift();
      this.now = Math.max(this.now, env.due);
      return this.dispatch(env.event, 'deliver');
    }
    if (timer === null) throw new Error('sim: nothing to deliver');
    this.timers.delete(timer[0]);
    this.now = Math.max(this.now, timer[1]);
    return this.dispatch({ t: 'timer', name: timer[0] }, 'deliver');
  }

  /** A state-appropriate event that moves the session along, or null where only deliveries do. */
  private progressEvent(rng: SimRng): SessionEvent | null {
    const s = this.state;
    switch (s.name) {
      case 'Asleep':
      case 'Error':
        return { t: 'tapBear' };
      case 'NeedsParent':
        return { t: 'parentContinue' };
      case 'Paused':
        return { t: 'visible' };
      case 'MicDenied':
        return rng() < 0.5 ? { t: 'settingsRetry' } : this.reaction(rng);
      case 'Listening':
        // #116: in hold-to-talk mode the hold button starts a take; seg events would be ignored.
        if (rng() >= 0.75) return this.reaction(rng);
        return s.holdToTalk ? { t: 'holdStart', frame: this.nowFrame() } : this.seg(rng, s.epoch, 'start');
      case 'Recording':
        if (s.holdToTalk) return { t: 'holdEnd', frame: this.nowFrame() };
        return this.seg(rng, s.epoch, rng() < 0.8 ? 'end' : 'misfire');
      case 'Playing':
      case 'SfxGated':
      case 'Cooldown':
        return rng() < 0.25 ? { t: 'inputsChanged' } : this.reaction(rng);
      default: // Waking, Processing: deliveries move them along
        return null;
    }
  }

  /** A random event from the pool, with a current or a stale payload. Half the time a progress event. */
  private randomEvent(rng: SimRng): SessionEvent {
    if (rng() < 0.5) {
      const e = this.progressEvent(rng);
      if (e !== null) return e;
    }
    const kind = pick(rng, POOL_KINDS);
    const stale = rng() >= 0.6;
    return this.make(kind, rng, stale);
  }

  /** A stale epoch/id variant (the only injections of the liveness phase). */
  private randomStaleEvent(rng: SimRng): SessionEvent {
    return this.make(pick(rng, STALE_KINDS), rng, true);
  }

  private make(kind: PoolKind, rng: SimRng, stale: boolean): SessionEvent {
    const s = this.state;
    const older = (v: number): number => v - 1 - Math.floor(rng() * 3);
    switch (kind) {
      case 'permissionChanged':
        return { t: kind, state: pick(rng, PERMISSIONS) };
      case 'ctxRunning':
        return { t: kind, sampleRate: SIM_SAMPLE_RATE };
      case 'reaction':
        return this.reaction(rng);
      case 'armed':
        return stale
          ? { t: kind, epoch: older(s.epoch), armFrame: Math.max(0, this.nowFrame() - SIM_SAMPLE_RATE) }
          : { t: kind, epoch: s.epoch, armFrame: this.armFrame ?? this.nowFrame() };
      case 'seg':
        return this.seg(rng, stale ? older(s.epoch) : s.epoch, pick(rng, SEG_KINDS));
      case 'floorSnapshot':
        return { t: kind, epoch: stale ? older(s.epoch) : s.epoch, floorDb: -70 + rng() * 40 };
      case 'clipReady':
      case 'takeFailed': {
        if (!stale) return { t: kind, epoch: s.epoch, id: s.takeId };
        const v = Math.floor(rng() * 3); // 0: stale epoch, 1: stale id, 2: both
        return {
          t: kind,
          epoch: v === 1 ? s.epoch : older(s.epoch),
          id: v === 0 ? s.takeId : older(s.takeId),
        };
      }
      case 'processed': {
        const id = stale ? older(s.takeId) : s.takeId;
        // #117: clipped by id parity, with no rng draw, so every existing sequence is unchanged.
        return {
          t: kind,
          id,
          durationSec: MIN_DURATION_SEC + rng() * (MAX_DURATION_SEC - MIN_DURATION_SEC),
          clipped: id % 2 === 0,
        };
      }
      case 'fxError':
        return { t: kind, id: stale ? older(s.takeId) : s.takeId };
      case 'settingsChanged':
        return { t: kind, preset: settingsPreset(rng) };
      case 'noiseFloor':
        return { t: kind, floorDb: -70 + rng() * 50 }; // −70 … −20 dBFS: about 30 % above −35
      case 'holdStart':
      case 'holdEnd':
        return { t: kind, frame: this.nowFrame() };
      default:
        return { t: kind };
    }
  }

  private reaction(rng: SimRng): SessionEvent {
    return {
      t: 'reaction',
      name: pick(rng, REACTION_NAMES),
      priority: pick(rng, PRIORITIES),
      sfx: rng() < 0.5 ? null : pick(rng, SFX_IDS),
    };
  }

  /**
   * A `seg` event with plausible ctx frames: an onset at least 100 ms after the latest arm (the worker blocks
   * earlier ones) and at most 100 ms old, and an end no earlier than its onset. Right after an arm, the onset
   * frame may lie up to 100 ms ahead of `now`; the reducer treats frames as opaque apart from the take range.
   */
  private seg(rng: SimRng, epoch: number, kind: SegEvent['kind']): SessionEvent {
    const now = this.nowFrame();
    const earliestOnset = (this.armFrame ?? 0) + ONSET_AFTER_ARM_MS * FRAMES_PER_MS;
    switch (kind) {
      case 'start':
        return {
          t: 'seg',
          epoch,
          ev: {
            kind,
            frame: Math.max(earliestOnset, now - Math.floor(rng() * MAX_ONSET_AGE_MS * FRAMES_PER_MS)),
          },
        };
      case 'end': {
        const onset = this.state.onsetFrame ?? earliestOnset;
        const lastSpeechFrame = Math.max(onset, now - Math.floor(rng() * MAX_HANGOVER_MS * FRAMES_PER_MS));
        // The same two draws either way (#116): a noisy room caps every take with a low voiced ratio.
        const r = rng();
        const v = rng();
        const reason = this.noisy || r >= 0.8 ? 'maxLength' : 'silence';
        const voicedRatio = this.noisy ? v * 0.3 : v;
        return {
          t: 'seg',
          epoch,
          ev: { kind, frame: Math.max(now, lastSpeechFrame), lastSpeechFrame, reason, voicedRatio },
        };
      }
      default: // misfire
        return { t: 'seg', epoch, ev: { kind, frame: now } };
    }
  }
}

/**
 * The preset of a random `settingsChanged`: half the time a named preset, otherwise Custom at a slider value,
 * built as the app builds it (the store validates the setting, then `presetFor` turns it into a preset).
 */
function settingsPreset(rng: SimRng): VoicePreset {
  if (rng() < 0.5) return pick(rng, NAMED_PRESETS);
  return presetFor(parseSettings({ voice: 'custom', customPitch: pick(rng, CUSTOM_PITCH_GRID) }));
}

function formatEvent(e: SessionEvent): string {
  const { t, ...rest } = e;
  return Object.keys(rest).length === 0 ? t : `${t}${JSON.stringify(rest)}`;
}

function formatEffect(fx: Effect): string {
  switch (fx.k) {
    case 'process':
      return `process{id:${fx.id}}`; // the preset is a large object
    case 'timer':
      return `timer ${fx.name} ${fx.ms}`;
    case 'cancelTimer':
      return `cancelTimer ${fx.name}`;
    case 'anim':
      return `anim ${fx.ev.e}`;
    default: {
      const { k, ...rest } = fx;
      return Object.keys(rest).length === 0 ? k : `${k}${JSON.stringify(rest)}`;
    }
  }
}
