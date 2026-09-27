import { minEndWaitMs, outputContextTimeNow, type OutputClockCtx } from './output-clock.ts';
import type { SfxId } from './sfx-ids.ts';
import { SYNTHS } from './sfx-synths.ts';

/** Schedules one sound effect's nodes at context time `when`, connected to `out`; returns its exact duration (s). */
export type SfxSynth = (ctx: BaseAudioContext, out: AudioNode, when: number) => number;

/** One scheduled sfx: its own gain into `out` (so `stopAll` can cut it) and a silent end marker. */
interface Voice {
  gain: GainNode;
  marker: ConstantSourceNode;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

const SCHEDULE_AHEAD_SEC = 0.02;
const POLL_MS = 10;
/**
 * How long an sfx's gain stays connected after its `ended` event. A synth may ring a little past the
 * duration it returns (#88 allows 10 ms), so cutting it right at that duration could click.
 */
const RING_OUT_MS = 50;

/**
 * The sound-effect scheduler (plan §4.4 point 5, §3.4 row 34). `allEnded()` resolves when every sfx has
 * left the speaker, judged like the player: the output clock has passed the latest end, every sfx's
 * `ended` event has fired, and at least `max(outputLatency, 50 ms)` has passed since the last of them.
 * The condition is re-read on every 10 ms poll, so an sfx scheduled while it waits extends the wait.
 *
 * A synth's own nodes are not visible here, so each sfx gets a silent `ConstantSourceNode` (offset 0)
 * that starts and stops with it; that marker's `ended` event is the sfx's `ended` event. The sfx's gain
 * is disconnected `RING_OUT_MS` after that event, or at once by `stopAll()`.
 */
export function createSfx(
  ctx: BaseAudioContext & OutputClockCtx, // an AudioContext in the app
  out: AudioNode,
  synths: Record<SfxId, SfxSynth>,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): {
  /** Schedules `id` at `ctx.currentTime + 0.02`. */
  play(id: SfxId): { endCtxTime: number };
  /** Cuts every scheduled sfx (the cut counts as their end) and rejects every pending `allEnded()` with `'stopped'`. */
  stopAll(): void;
  /** Resolves when every sfx has left the speaker, including sfx scheduled while it waits (same predicate and min wait as the player). Rejects with 'stopped' after stopAll(). */
  allEnded(): Promise<void>;
} {
  const voices = new Set<Voice>(); // scheduled, `ended` not fired yet
  const ringingOut = new Set<Voice>(); // ended, gain still connected for RING_OUT_MS
  const waiters = new Set<Waiter>();
  let latestEnd = -Infinity; // context time at which the latest scheduled sfx ends
  let lastEndedAt = -Infinity; // performance.now() of the most recent `ended` event

  const disconnectAfterRingOut = async (v: Voice): Promise<void> => {
    await sleep(RING_OUT_MS);
    if (ringingOut.delete(v)) v.gain.disconnect(); // unless stopAll already cut it
  };

  const play = (id: SfxId): { endCtxTime: number } => {
    const when = ctx.currentTime + SCHEDULE_AHEAD_SEC;
    const gain = new GainNode(ctx);
    gain.connect(out);
    const duration = synths[id](ctx, gain, when);
    const endCtxTime = when + duration;
    latestEnd = Math.max(latestEnd, endCtxTime);
    const marker = new ConstantSourceNode(ctx, { offset: 0 });
    marker.connect(gain);
    const v: Voice = { gain, marker };
    marker.addEventListener(
      'ended',
      () => {
        if (!voices.delete(v)) return; // already cut by stopAll
        marker.disconnect();
        lastEndedAt = performance.now();
        ringingOut.add(v);
        disconnectAfterRingOut(v).catch((err: unknown) => {
          console.error('sfx: ring-out disconnect failed', err);
        });
      },
      { once: true },
    );
    marker.start(when);
    marker.stop(endCtxTime);
    voices.add(v);
    return { endCtxTime };
  };

  const stopAll = (): void => {
    for (const v of ringingOut) v.gain.disconnect();
    ringingOut.clear();
    if (voices.size > 0) {
      for (const v of voices) {
        v.marker.stop();
        v.marker.disconnect();
        v.gain.disconnect();
      }
      voices.clear();
      // The cut is where these sfx end: audio rendered up to now still has to leave the speaker.
      latestEnd = Math.min(latestEnd, ctx.currentTime);
      lastEndedAt = performance.now();
    }
    const pending = [...waiters];
    waiters.clear();
    for (const w of pending) w.reject('stopped');
  };

  const leftSpeaker = (): boolean =>
    voices.size === 0 &&
    outputContextTimeNow(ctx) >= latestEnd &&
    performance.now() - lastEndedAt >= minEndWaitMs(ctx);

  const allEnded = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      waiters.add(w);
      const poll = async (): Promise<void> => {
        for (;;) {
          if (!waiters.has(w)) return; // rejected by stopAll
          if (leftSpeaker()) {
            waiters.delete(w);
            resolve();
            return;
          }
          await sleep(POLL_MS);
        }
      };
      poll().catch((err: unknown) => {
        waiters.delete(w);
        reject(err);
      });
    });

  return { play, stopAll, allEnded };
}

/** Kept as an alias of `SYNTHS` (`sfx-synths.ts`) for existing callers. */
export const M1_SYNTHS: Record<SfxId, SfxSynth> = SYNTHS;
