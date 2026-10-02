// The effect interpreter (plan §3.3, §3.4): runs the reducer's effects against the engine, the voice player, the
// sfx scheduler, the wake lock, the injected clock and the UI callbacks. The session (session.ts) owns the loop and
// calls `run` for each effect in order; events an effect produces go back through `io.dispatch`, which queues them
// while a dispatch is running. Named timers use the injected `Clock` only, never the global timers.

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
>;

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

  /** Replaces any pending timer with that name; when it fires it deletes itself and dispatches `timer{name}`. */
  function setTimer(name: TimerName, ms: number): void {
    clearTimer(name);
    const id = clock.setTimeout(() => {
      if (timers.get(name) !== id) return;
      timers.delete(name);
      io.dispatch({ t: 'timer', name });
    }, ms);
    timers.set(name, id);
  }

  function clearAllTimers(): void {
    for (const id of timers.values()) clock.clearTimeout(id);
    timers.clear();
  }

  // ---- the interpreter -------------------------------------------------------------------------------------

  function exec(fx: Effect): void {
    switch (fx.k) {
      case 'openMic':
        engine.openMic(fx.req);
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
        engine.arm(fx.epoch, fx.restoreFloorDb);
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
  };
}
