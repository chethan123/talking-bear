/**
 * The talking mouth layer (plan §4.6.2 "Sync", §4.6.5 "Talking"): each rAF frame samples the processed clip's
 * mouth envelope at `clipTimeNow(ctx, start) + L` and maps it to the mouth channels, a head bob and a brow lift.
 *
 * **Sampling.** Envelope frame i is centred at clip time i·10 ms (#63: `hopMs: 10`). The frame position of a
 * clip time t is x = t / 0.010, snapped to the nearest integer when it is within `SNAP_FRAMES` of one: ctx-time
 * differences carry rounding error (10.0 − 9.9 + 0.04 = 0.13999999999999965, which must read as frame 14). With
 * k = floor(x) and u = x − k, a track v reads
 *
 *     v(t) = v[k] + (v[k+1] − v[k])·u     while k ≤ len − 2,
 *     v(t) = v[len − 1]                   in the last partial frame, len − 1 ≤ x < len,
 *
 * so every track passes through its frame values exactly at the frame centres (u = 0). Outside the clip, x < 0
 * or x ≥ len (`envelopeIndex` −1, including t = len·0.010 exactly), the mouth channels are 0 and the jaw counts
 * as 0 for the head bob and the brow lift.
 *
 * **Mapping.**
 * - `Jaw = jaw`, `MouthW = width`, `MouthRound = round`, `Teeth = teeth`.
 * - Head bob: `HeadY += −6 · clamp(d(jaw)/dt / 20, −1, 1)`, with d(jaw)/dt = (jaw(t) − jaw(t − 30 ms)) / 30 ms
 *   read from the envelope itself, so it does not depend on the frame rate. HeadY is in design units, y down:
 *   an opening mouth lifts the head.
 * - Brow lift: every upward crossing of 0.8 by the (interpolated) jaw adds an impulse of +5 design units at the
 *   crossing's exact clip time, decaying with τ = 150 ms; impulses superpose. The jaw is 0 before the clip, so a
 *   first frame at or above 0.8 crosses at t = 0. Crossings are found on the envelope between the furthest
 *   sample so far and the current one, so each fires exactly once whatever the frame times: a long frame
 *   misses none, and clock jitter that steps back never re-fires one.
 *
 * Known property of `teeth` (#63): it ignores level, so hiss in a pause can read as sibilant while the mouth is
 * shut (jaw = 0, teeth ≈ 0.85). `Teeth` passes it through as specified; the renderer draws no mouth at all while
 * its opening (110·Jaw) is below 0.5, so those teeth never show. Any sliver of teeth at a small jaw is left to
 * the by-eye check (X-A3, #76).
 *
 * **Channel contract (#81).**
 * - `update` *sets* `Jaw`, `MouthW`, `MouthRound` and `Teeth` (nothing else writes them: the director's
 *   `evaluate` never does), and *adds* the head bob to `HeadY` and the brow lift to `BrowL` and `BrowR`. It
 *   touches no other channel.
 * - Call it once per rAF frame, after `evaluate` has re-seeded the pose for that frame, or the additions
 *   accumulate; then scale the four mouth channels by the director's `mouthCloseScale`.
 * - `setClip(null)` and `setClip(nextEnv)` zero the brow lift at once. At talkEnd (≥ 50 ms after the clip's
 *   end) a crossing in the clip's last ~200 ms can still leave 1–2 units, which then drop in one frame.
 *
 * **Time.** Everything the layer computes runs on clip time t: the interpolation, the 30 ms derivative window
 * and the brow decay. `now` (milliseconds, `performance.now()` by default) is only passed to `clipTimeNow`,
 * which extrapolates the context's last output timestamp to the present.
 *
 * **Allocation.** Nothing here allocates per call: no object or array literals, closures or spreads. Doubles
 * reach the helpers that V8 may not inline (`writeMouth`, `#fireCrossings`) through preallocated slots instead
 * of arguments, since a double passed to a call that is not inlined is boxed on the heap on every call.
 */
import { clipTimeNow } from '../../audio/output-clock.ts';
import type { OutputClockCtx } from '../../audio/output-clock.ts';
import type { Envelope } from '../../dsp/types.ts';
import { DISPLAY_LATENCY_MS } from '../constants.ts';
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';

/** Envelope hop in seconds: frame i is centred at clip time i·HOP_SEC. */
const HOP_SEC = 0.01;
/**
 * Snap tolerance in frames (10 ps): a frame position this close to an integer is that integer. It absorbs the
 * rounding error of ctx-time differences (about 2e-11 frames at a context time of one hour, 7e-10 at a day) and
 * of decimal clip times (29 · 0.01 / 0.01 = 28.999999999999996). Beyond about a day of context time a frame
 * centre may no longer snap; only the exact pass-through at frame centres degrades, by far less than a float32
 * step.
 */
const SNAP_FRAMES = 1e-9;

/** Head bob at full rate, in design units (applied upward: `HeadY` decreases). */
export const HEAD_BOB = 6;
/** Jaw rate (per second) that gives the full head bob. */
export const HEAD_BOB_RATE = 20;
/** Window of the jaw derivative, in seconds. */
export const HEAD_BOB_WINDOW = 0.03;
/** Jaw level whose upward crossing lifts the brows. */
export const BROW_THRESHOLD = 0.8;
/** Brow impulse per crossing, in design units (positive is up). */
export const BROW_LIFT = 5;
/** Decay time constant of the brow impulse, in seconds. */
export const BROW_TAU = 0.15;

/** `performance.now`, wrapped once: `clipTimeNow`'s own default would allocate a closure on every call. */
const performanceNow = (): number => performance.now();

/** The frame position `writeMouth` reads (see **Allocation** in the module comment). */
const mouthPos = new Float64Array(1);

/** Frame position t / HOP_SEC, snapped to an integer within `SNAP_FRAMES`; NaN and ±Infinity pass through. */
function framePos(clipTimeSec: number): number {
  const x = clipTimeSec / HOP_SEC;
  const r = Math.round(x);
  // `+ 0` turns −0 (a tiny negative snapped to 0) into +0.
  return Math.abs(x - r) <= SNAP_FRAMES ? r + 0 : x;
}

/** Track `v` at frame position `x`, interpolated as in the module comment, or 0 outside [0, v.length). */
function trackAt(v: Float32Array, x: number): number {
  const len = v.length;
  if (!(x >= 0 && x < len)) return 0;
  const k = Math.floor(x);
  const a = v[k]!;
  return k === len - 1 ? a : a + (v[k + 1]! - a) * (x - k);
}

function zeroMouth(out: Pose): void {
  out[Ch.Jaw] = 0;
  out[Ch.MouthW] = 0;
  out[Ch.MouthRound] = 0;
  out[Ch.Teeth] = 0;
}

/**
 * Writes the four mouth channels of `out` for the frame position in `mouthPos[0]`: interpolated inside the
 * clip, 0 outside it.
 */
function writeMouth(env: Envelope, out: Pose): void {
  const x = mouthPos[0]!;
  const len = env.jaw.length;
  if (!(x >= 0 && x < len)) {
    zeroMouth(out);
    return;
  }
  // Inline rather than four `trackAt` calls: a call V8 does not inline boxes the double it returns.
  const k = Math.floor(x);
  const k1 = k === len - 1 ? k : k + 1; // the last partial frame holds: v[k] + (v[k] − v[k])·u = v[k]
  const u = x - k;
  const j0 = env.jaw[k]!;
  const w0 = env.width[k]!;
  const r0 = env.round[k]!;
  const t0 = env.teeth[k]!;
  out[Ch.Jaw] = j0 + (env.jaw[k1]! - j0) * u;
  out[Ch.MouthW] = w0 + (env.width[k1]! - w0) * u;
  out[Ch.MouthRound] = r0 + (env.round[k1]! - r0) * u;
  out[Ch.Teeth] = t0 + (env.teeth[k1]! - t0) * u;
}

/**
 * Index of the envelope frame at or before clip time `clipTimeSec`: floor(t / 0.010) with t snapped to the
 * frame grid (see the module comment), in [0, len − 1]; −1 when t < 0, t ≥ len·0.010 or t is NaN. It is the
 * left node of the interpolation. `len` is the length of the tracks (all four are equal).
 */
export function envelopeIndex(env: Envelope, clipTimeSec: number): number {
  const x = framePos(clipTimeSec);
  return x >= 0 && x < env.jaw.length ? Math.floor(x) : -1;
}

/**
 * Writes `Jaw`, `MouthW`, `MouthRound` and `Teeth` for clip time `clipTimeSec` (linear interpolation between
 * frame centres; 0 outside the clip) and returns `out`. No other channel is touched. Never allocates.
 */
export function mouthFromEnvelope(env: Envelope, clipTimeSec: number, out: Pose): Pose {
  mouthPos[0] = framePos(clipTimeSec);
  writeMouth(env, out);
  return out;
}

export class MouthLayer {
  /** L, the display-latency compensation in milliseconds: the layer samples at clipTimeNow + L / 1000. */
  latencyMs: number;

  /** The playing clip's envelope; the layer holds this reference until the next `setClip`. */
  #env: Envelope | null = null;
  #start = 0;
  #clipTime = Number.NaN;
  #envIndex = -1;
  /** Frame position of the furthest sample of this clip so far (−∞ before the first); crossings up to it have fired. */
  #lastX = Number.NEGATIVE_INFINITY;
  /** Frame position of the current sample, which `#fireCrossings` reads (see **Allocation**). */
  #x = Number.NaN;
  /** The brow lift is #browAmp at clip time #browT, decaying with `BROW_TAU`. */
  #browAmp = 0;
  #browT = 0;

  constructor(latencyMs: number = DISPLAY_LATENCY_MS) {
    this.latencyMs = latencyMs;
  }

  /** Clip time (s, L included) of the last `update`; NaN before the first update of a clip and without a clip. */
  get clipTime(): number {
    return this.#clipTime;
  }

  /** `envelopeIndex` at the last `update`'s clip time; −1 outside the clip and without a clip. */
  get envIndex(): number {
    return this.#envIndex;
  }

  /**
   * Starts sampling `env`, whose first sample is scheduled at context time `startCtxTime` (the player's
   * `PlayHandle.startCtxTime`), or stops with `null`. The layer keeps its own reference to `env`, so the clip keeps
   * animating after the session releases the engine's processed result. Resets the crossing state and zeroes the
   * brow lift at once; from then on, `null` makes `update` write a closed mouth and add nothing.
   */
  setClip(env: Envelope | null, startCtxTime: number): void {
    this.#env = env;
    this.#start = startCtxTime;
    this.#clipTime = Number.NaN;
    this.#envIndex = -1;
    this.#lastX = Number.NEGATIVE_INFINITY;
    this.#x = Number.NaN;
    this.#browAmp = 0;
    this.#browT = 0;
  }

  /**
   * Samples the clip at t = clipTimeNow(ctx, start, now) + latencyMs / 1000: sets the mouth channels of `pose`
   * and adds the head bob and the brow lift (see the module comment). Without a clip, or when t is not finite,
   * it sets the mouth channels to 0 and adds nothing. Never allocates.
   */
  update(pose: Pose, ctx: OutputClockCtx, now?: () => number): void {
    const env = this.#env;
    if (env === null) {
      zeroMouth(pose);
      return;
    }
    const t = clipTimeNow(ctx, this.#start, now ?? performanceNow) + this.latencyMs / 1000;
    const x = framePos(t);
    const jaw = env.jaw;
    mouthPos[0] = x;
    writeMouth(env, pose);
    this.#clipTime = t;
    this.#envIndex = x >= 0 && x < jaw.length ? Math.floor(x) : -1; // envelopeIndex(env, t), from the same x
    if (!Number.isFinite(t)) return;

    const rate = (trackAt(jaw, x) - trackAt(jaw, framePos(t - HEAD_BOB_WINDOW))) / HEAD_BOB_WINDOW;
    pose[Ch.HeadY] = pose[Ch.HeadY]! - HEAD_BOB * Math.max(-1, Math.min(1, rate / HEAD_BOB_RATE));

    this.#x = x;
    this.#fireCrossings(jaw);
    if (this.#browAmp > 0) {
      const age = t - this.#browT;
      const lift = this.#browAmp * Math.exp(-(age > 0 ? age : 0) / BROW_TAU);
      pose[Ch.BrowL] = pose[Ch.BrowL]! + lift;
      pose[Ch.BrowR] = pose[Ch.BrowR]! + lift;
    }
  }

  /**
   * Fires every upward crossing of `BROW_THRESHOLD` in (#lastX, #x], in order, then advances #lastX to #x.
   * Segment s runs from frame s to frame s + 1; segment −1 is the jump from the jaw of 0 before the clip to
   * frame 0, which crosses at x = 0. Each crossing adds `BROW_LIFT` at its clip time to the decayed lift.
   */
  #fireCrossings(jaw: Float32Array): void {
    const x = this.#x;
    const lastX = this.#lastX;
    if (!(x > lastX)) return;
    const last = Math.min(jaw.length - 2, Math.floor(x));
    for (let s = Math.max(-1, Math.floor(lastX)); s <= last; s++) {
      const j0 = s < 0 ? 0 : jaw[s]!;
      const j1 = jaw[s + 1]!;
      if (j0 < BROW_THRESHOLD && j1 >= BROW_THRESHOLD) {
        const xc = s < 0 ? 0 : s + (BROW_THRESHOLD - j0) / (j1 - j0);
        if (xc > lastX && xc <= x) {
          const tc = xc * HOP_SEC;
          const age = tc - this.#browT;
          this.#browAmp = this.#browAmp * Math.exp(-(age > 0 ? age : 0) / BROW_TAU) + BROW_LIFT;
          this.#browT = tc;
        }
      }
    }
    this.#lastX = x;
  }
}
