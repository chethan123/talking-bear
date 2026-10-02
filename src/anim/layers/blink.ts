/**
 * Blink layer (plan §4.6.5): blinks start as a Poisson process with a mean interval of 3.5 s, 15 % of them
 * are doubles, and each blink closes over 60 ms, holds 40 ms and opens over 80 ms, driving `LidL` and `LidR`
 * together from 0 (open) to 1 (closed).
 */
import { exponential } from '../rng.ts';
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import type { AnimContext, Layer } from './index.ts';

/** Mean interval between blink onsets, in seconds: the intervals are exponentially distributed. */
export const BLINK_MEAN_INTERVAL = 3.5;
/** Share of blinks that are doubles. */
export const BLINK_DOUBLE_RATIO = 0.15;
/** Lid closing time, in seconds (lid 0 → 1, linear). */
export const BLINK_CLOSE = 0.06;
/** Time the lid stays shut, in seconds. */
export const BLINK_HOLD = 0.04;
/** Lid opening time, in seconds (lid 1 → 0, linear). */
export const BLINK_OPEN = 0.08;
/** Open time between the two blinks of a double, in seconds. */
export const BLINK_DOUBLE_GAP = 0.08;

/** One blink: close + hold + open = 0.18 s. */
const SINGLE = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
/** A double: blink, gap, blink = 0.44 s. */
const DOUBLE = 2 * SINGLE + BLINK_DOUBLE_GAP;

export interface BlinkLayer extends Layer {
  /** Blink events started so far; a double counts once. */
  readonly count: number;
  /** How many of those events were doubles. */
  readonly doubles: number;
  /**
   * Seconds from the latest event's exact onset to the end of the last update; `Infinity` before the first.
   */
  readonly sinceOnset: number;
}

// The doubles kept between updates live in a `Float64Array`, one slot each: V8's mid tier boxes a double written to
// a class field as a new heap number on every write (#214).
/** Seconds until the next onset. */
const WAIT = 0;
/** Seconds since the latest onset. */
const SINCE = 1;

class Blink implements BlinkLayer {
  #primed = false;
  /** The doubles kept between updates, by slot. */
  readonly #s = new Float64Array(2);
  #double = false;
  #count = 0;
  #doubles = 0;

  constructor() {
    this.#s[SINCE] = Number.POSITIVE_INFINITY;
  }

  get count(): number {
    return this.#count;
  }

  get doubles(): number {
    return this.#doubles;
  }

  get sinceOnset(): number {
    return this.#s[SINCE]!;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const s = this.#s;
    if (!this.#primed) {
      this.#primed = true;
      s[WAIT] = exponential(ctx.rng, BLINK_MEAN_INTERVAL);
    }
    s[SINCE] = s[SINCE]! + dt;
    s[WAIT] = s[WAIT]! - dt;
    if (s[WAIT] <= 0) {
      // The onset fell inside this step, −wait seconds before its end: start the lid there, not at the step.
      s[SINCE] = -s[WAIT];
      this.#double = ctx.rng() < BLINK_DOUBLE_RATIO;
      this.#count++;
      if (this.#double) this.#doubles++;
      // The next onset is an exponential interval after this one, but never before this event has ended.
      s[WAIT] = s[WAIT] + Math.max(exponential(ctx.rng, BLINK_MEAN_INTERVAL), this.#double ? DOUBLE : SINGLE);
    }
    const t = s[SINCE];
    // Time into the current single blink: a double's second blink starts SINGLE + BLINK_DOUBLE_GAP after the onset.
    const u = this.#double && t >= SINGLE + BLINK_DOUBLE_GAP ? t - SINGLE - BLINK_DOUBLE_GAP : t;
    // The lid of one blink `u` seconds after its onset, 0 before and after it; written out rather than a helper,
    // since a call V8 does not inline boxes the double it returns.
    let lid: number;
    if (u < 0 || u >= SINGLE) lid = 0;
    else if (u < BLINK_CLOSE) lid = u / BLINK_CLOSE;
    else if (u < BLINK_CLOSE + BLINK_HOLD) lid = 1;
    else lid = 1 - (u - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
    const v = ctx.weights.blink * lid;
    pose[Ch.LidL] = pose[Ch.LidL]! + v;
    pose[Ch.LidR] = pose[Ch.LidR]! + v;
  }
}

/** A new blink layer. Its first onset is an exponential interval after its first update. */
export function createBlink(): BlinkLayer {
  return new Blink();
}
