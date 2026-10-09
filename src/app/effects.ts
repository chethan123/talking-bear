// The effect interpreter (plan §3.3, §3.4): runs the reducer's effects against the engine, the voice player, the
// sfx scheduler, the wake lock, the injected clock and the UI callbacks. The session (session.ts) owns the loop and
// calls `run` for each effect in order; events an effect produces go back through `io.dispatch`, which queues them
// while a dispatch is running. Named timers use the injected `Clock`, never the global timers; the cooldown also
// waits on the context clock (#286, see `setTimer`).
//
// Noisy room (plan §4.1.1, §7 M8, #113): each `openMic` reads the settings, and with `noisyRoomNs` on passes
// `NOISY_ROOM_CONSTRAINTS` as the engine's `extra`, so a change applies at the next mic open.
//
// Too noisy (#116, plan §4.4, and the ORCH-NOTE on #116): the session hands every engine `level` to `level()`, which
// turns them into at most one `noiseFloor` per second: over a window of at least NOISE_FLOOR_WINDOW_MS of Listening
// levels of the current epoch, the larger of the gate floor N and the minimum hop level (digital silence counts at
// the gate's `ignoreBelowDb`, so a silent input clears the flag). The gate floor alone absorbs a loud steady noise
// only with its 20 s in-speech time constant. Levels outside Listening (speech is Recording) never count, and a
// new epoch starts a new window. The window lives in closure scalars: nothing is allocated per level.

import { DEFAULT_ENERGY_PARAMS } from '../dsp/energy-gate.ts';
import type { Effect, SessionEvent, SessionState, TimerName } from './events.ts';
import type { Player, SessionDeps, Sfx, SfxScheduled } from './session.ts';

/** The parts of the session's dependencies that effects use. */
export type EffectDeps = Pick<
  SessionDeps,
  | 'engine'
  | 'makePlayer'
  | 'makeSfx'
  | 'wakeLock'
  | 'clock'
  | 'onAnim'
  | 'onPlayStarted'
  | 'onUi'
  | 'onApplyUpdate'
  | 'settings'
>;

/** The noisy-room toggle's `extra` for `engine.openMic`: software NS only, nothing else changes (plan §4.1.1). */
export const NOISY_ROOM_CONSTRAINTS: Readonly<MediaTrackConstraints> = Object.freeze({
  noiseSuppression: true,
});

/** #116: a `noiseFloor` is dispatched once a window of Listening levels spans at least this long. */
export const NOISE_FLOOR_WINDOW_MS = 1000;

/**
 * #286: the longest the cooldown waits on the context clock beyond its wall-clock `ms`. A render stall longer
 * than 0.5 s is a capture gap the worklet re-anchors over (plan §3.1), and a context can report `running`
 * while its clock is frozen, so past this the wall clock decides and Cooldown can never hang.
 */
export const COOLDOWN_CTX_WAIT_MAX_MS = 500;

/** The parts of an engine `level` event the noise floor estimate reads. */
export interface LevelSample {
  epoch: number;
  db: number;
  floorDb: number;
}

/** How effects talk back to the session. */
export interface EffectIo {
  /** Queues an event while a dispatch is running (re-entrancy), else runs it at once. */
  dispatch(e: SessionEvent): void;
  /** The session's current state (already the new state while a transition's effects run). */
  state(): SessionState;
  /** An `sfx` effect was scheduled: its seq, id and the context time its sound ends (`sfx.play`'s `endCtxTime`). */
  sfxScheduled?(e: SfxScheduled): void;
}

export interface EffectRunner {
  /** Runs one effect. An effect that throws is logged, never rethrown, so the loop continues. */
  run(fx: Effect): void;
  /** An engine `level` event (#116): feeds the noise floor estimate, which dispatches `noiseFloor` (see above). */
  level(e: LevelSample): void;
}

type SfxEffect = Extract<Effect, { k: 'sfx' }>;
type PlayResult = 'ended' | 'stopped';

export function createEffectRunner(deps: EffectDeps, io: EffectIo): EffectRunner {
  const { engine, clock } = deps;
  const timers = new Map<TimerName, number>();
  let player: Player | null = null;
  let sfx: Sfx | null = null;
  /** The highest sfx seq scheduled so far. */
  let sfxHighest = 0;
  /** The highest seq reported as `sfxAtSpeakerEnded`; reports strictly increase. */
  let sfxSent = 0;
  /** Bumped by every sfx effect and every stopPlayback: only the newest `allEnded()` wait may report. */
  let sfxToken = 0;

  // ---- output (lazy: the context and bus exist once the engine's first resume() has built the graph) --------

  function output(): { ctx: AudioContext; bus: AudioNode } | null {
    const ctx = engine.context();
    const bus = engine.masterBus();
    return ctx !== null && bus !== null ? { ctx, bus } : null;
  }

  /** The voice player, created once from the engine's context and master bus; null until they exist. */
  function playerOf(): Player | null {
    if (player !== null) return player;
    const out = output();
    if (out === null) return null;
    player = deps.makePlayer(out.ctx, out.bus);
    return player;
  }

  /** The sfx scheduler, created once like the player; null until the output exists. */
  function sfxOf(): Sfx | null {
    if (sfx !== null) return sfx;
    const out = output();
    if (out === null) return null;
    sfx = deps.makeSfx(out.ctx, out.bus);
    return sfx;
  }

  // ---- play ------------------------------------------------------------------------------------------------

  /** Builds the clip's AudioBuffer and starts it; null when there is nothing to play or no output yet. */
  function startClip(id: number): Promise<PlayResult> | null {
    const p = engine.getProcessed(id);
    if (p === undefined) return null;
    const out = output();
    const pl = playerOf();
    if (out === null || pl === null) return null;
    const buffer = out.ctx.createBuffer(1, p.pcm.length, p.sampleRate);
    // getChannelData().set() copies from any Float32Array; copyToChannel wants a Float32Array<ArrayBuffer>.
    buffer.getChannelData(0).set(p.pcm);
    // The voice chain already pitched the clip (plan §4.3.4): it plays at rate 1.
    const handle = pl.play(buffer, 1);
    // The mouth (#81) samples the envelope against this start. A throwing listener must not end a replay that
    // is already audible.
    try {
      deps.onPlayStarted?.(id, handle.startCtxTime);
    } catch (err) {
      console.error('effects: onPlayStarted failed', err);
    }
    return handle.done;
  }

  /**
   * The processed result stays in the engine until this playback settles (M4 reads its envelope while Playing),
   * then it is released: plan §2, captured audio is discarded after each replay (ORCH-ANSWER on #34).
   */
  function playClip(id: number): void {
    let done: Promise<PlayResult> | null = null;
    try {
      done = startClip(id);
    } catch (err) {
      console.error('effects: play failed', err);
    }
    if (done === null) {
      // Nothing was started, so nothing is audible. End the replay now: Playing has no timer and would hang.
      engine.releaseProcessed(id);
      io.dispatch({ t: 'playbackAtSpeakerEnded', id });
      return;
    }
    done.then(
      (r) => {
        engine.releaseProcessed(id);
        if (r === 'ended') io.dispatch({ t: 'playbackAtSpeakerEnded', id });
      },
      (err: unknown) => {
        // The player never rejects; if it did, the clip's end is unknown. End the replay rather than hang Playing.
        engine.releaseProcessed(id);
        console.error('effects: playback failed', err);
        io.dispatch({ t: 'playbackAtSpeakerEnded', id });
      },
    );
  }

  // ---- sfx -------------------------------------------------------------------------------------------------

  /** Reports every sfx scheduled so far as having left the speaker, once per seq, in increasing order. */
  function reportSfx(): void {
    if (sfxHighest <= sfxSent) return;
    sfxSent = sfxHighest;
    io.dispatch({ t: 'sfxAtSpeakerEnded', seq: sfxHighest });
  }

  /**
   * `allEnded()` covers every sfx scheduled before it resolves, but its callback can't tell whether an sfx
   * scheduled in the gap between that resolution and the callback was covered. The newest wait started after
   * the newest play(), so only it may report: an older resolution (overtaken by a newer sfx or a stopAll) can
   * never report a seq that is still audible, or a lower seq after a higher one.
   */
  function playSfx(fx: SfxEffect): void {
    sfxHighest = Math.max(sfxHighest, fx.seq);
    const token = ++sfxToken;
    let s: Sfx | null = null;
    try {
      s = sfxOf();
    } catch (err) {
      console.error('effects: sfx setup failed', err);
    }
    if (s === null) {
      // No output: nothing can be audible. Report now, or SfxGated (which has no timer) would hang.
      reportSfx();
      return;
    }
    try {
      const { endCtxTime } = s.play(fx.id);
      io.sfxScheduled?.({ seq: fx.seq, id: fx.id, endCtxTime });
    } catch (err) {
      console.error('effects: sfx failed', err); // earlier sfx may still be audible: wait for them below
    }
    s.allEnded().then(
      () => {
        if (token === sfxToken) reportSfx();
      },
      (err: unknown) => {
        if (err === 'stopped') return; // stopAll() from stopPlayback: the reducer already counts them as ended
        console.error('effects: sfx wait failed', err);
        if (token === sfxToken) reportSfx();
      },
    );
  }

  // ---- timers ----------------------------------------------------------------------------------------------

  function clearTimer(name: TimerName): void {
    const id = timers.get(name);
    if (id === undefined) return;
    timers.delete(name);
    clock.clearTimeout(id);
  }

  /**
   * Replaces any pending timer with that name; when it fires it deletes itself and dispatches `timer{name}`.
   *
   * The cooldown is audio timing (plan §4.4 point 5; §3.1 keeps the wall clock for UI timers only), so it also
   * waits until the context clock, which the capture frames and `arm` run on, has advanced `ms` (#286). If the
   * audio thread stalled, so `currentTime` fell behind the wall clock, the wall-clock timeout is re-armed for the
   * rest under the same map entry, so `cancelTimer` and `clearAllTimers` still stop it. With no context yet, one
   * not `running` when the timeout fires, or once `ms + COOLDOWN_CTX_WAIT_MAX_MS` of wall time has passed, the wall
   * clock alone decides, so it never hangs (ORCH-NOTE on #286).
   */
  function setTimer(name: TimerName, ms: number): void {
    clearTimer(name);
    const ctx = name === 'cooldown' ? engine.context() : null;
    const ctxDue = ctx === null ? 0 : ctx.currentTime + ms / 1000;
    const wallCap = clock.now() + ms + COOLDOWN_CTX_WAIT_MAX_MS;
    const wait = (delay: number): void => {
      const id = clock.setTimeout(() => {
        if (timers.get(name) !== id) return;
        const left = wallCap - clock.now();
        if (ctx !== null && ctx.state === 'running' && ctx.currentTime < ctxDue && left > 0) {
          wait(Math.max(1, Math.min((ctxDue - ctx.currentTime) * 1000, left)));
          return;
        }
        timers.delete(name);
        io.dispatch({ t: 'timer', name });
      }, delay);
      timers.set(name, id);
    };
    wait(ms);
  }

  function clearAllTimers(): void {
    for (const id of timers.values()) clock.clearTimeout(id);
    timers.clear();
  }

  // ---- noise floor (#116) ------------------------------------------------------------------------------------

  let winOpen = false;
  let winEpoch = 0;
  let winStart = 0;
  let winMin = 0;
  let winFloor = Number.NaN;

  function level(e: LevelSample): void {
    const s = io.state();
    if (s.name !== 'Listening' || e.epoch !== s.epoch) {
      winOpen = false;
      return;
    }
    const silent = DEFAULT_ENERGY_PARAMS.ignoreBelowDb;
    const db = e.db >= silent ? e.db : silent; // digital silence (and NaN) reads as the gate's silence level
    const now = clock.now();
    if (!winOpen || winEpoch !== e.epoch) {
      winOpen = true;
      winEpoch = e.epoch;
      winStart = now;
      winMin = db;
    } else if (db < winMin) {
      winMin = db;
    }
    winFloor = e.floorDb;
    if (now - winStart < NOISE_FLOOR_WINDOW_MS) return;
    winOpen = false;
    io.dispatch({
      t: 'noiseFloor',
      floorDb: Number.isFinite(winFloor) ? Math.max(winMin, winFloor) : winMin,
    });
  }

  // ---- the interpreter -------------------------------------------------------------------------------------

  function exec(fx: Effect): void {
    switch (fx.k) {
      case 'openMic':
        if (deps.settings?.().noisyRoomNs === true) engine.openMic(fx.req, NOISY_ROOM_CONSTRAINTS);
        else engine.openMic(fx.req);
        return;
      case 'closeMic':
        engine.closeMic();
        return;
      case 'resumeCtx':
        void engine.resume().catch((err: unknown) => {
          console.error('effects: resume failed', err);
        });
        return;
      case 'suspendCtx':
        void engine.suspend().catch((err: unknown) => {
          console.error('effects: suspend failed', err);
        });
        return;
      case 'restartWorker':
        engine.restartWorker();
        return;
      case 'arm':
        engine.arm(fx.epoch, fx.restoreFloorDb, fx.marginBoostDb);
        return;
      case 'disarm':
        engine.disarm(fx.epoch);
        return;
      case 'take':
        engine.take(fx.epoch, fx.id, fx.fromFrame, fx.toFrame);
        return;
      case 'process':
        engine.process(fx.id, fx.preset);
        return;
      case 'reselectInput':
        engine.reselectInput();
        return;
      case 'play':
        playClip(fx.id);
        return;
      case 'stopPlayback':
        sfxToken++; // waits started before the cut never report
        player?.stop();
        sfx?.stopAll();
        return;
      case 'timer':
        setTimer(fx.name, fx.ms);
        return;
      case 'cancelTimer':
        if (fx.name === '*') clearAllTimers();
        else clearTimer(fx.name);
        return;
      case 'wakeLock':
        deps.wakeLock.set(fx.on);
        return;
      case 'anim':
        deps.onAnim?.(fx.ev);
        return;
      case 'sfx':
        playSfx(fx);
        return;
      case 'ui':
        deps.onUi?.(fx.show);
        return;
      case 'applyUpdate':
        deps.onApplyUpdate?.();
        return;
      default: {
        const unknown: never = fx;
        throw new Error(`unknown effect ${JSON.stringify(unknown)}`);
      }
    }
  }

  return {
    run(fx) {
      try {
        exec(fx);
      } catch (err) {
        console.error(`effects: ${fx.k} failed`, err);
      }
    },
    level,
  };
}
