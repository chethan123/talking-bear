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

/** Lid of one blink `t` seconds after its onset: 0 before it and after it ends. */
function singleLid(t: number): number {
  if (t < 0 || t >= SINGLE) return 0;
  if (t < BLINK_CLOSE) return t / BLINK_CLOSE;
  if (t < BLINK_CLOSE + BLINK_HOLD) return 1;
  return 1 - (t - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
}

export interface BlinkLayer extends Layer {
  /** Blink events started so far; a double counts once. */
  readonly count: number;
  /** How many of those events were doubles. */
  readonly doubles: number;
  /** Seconds from the latest event's exact onset to the end of the last update; `Infinity` before the first. */
  readonly sinceOnset: number;
}

class Blink implements BlinkLayer {
  #primed = false;
  /** Seconds until the next onset. */
  #wait = 0;
  /** Seconds since the latest onset. */
  #t = Number.POSITIVE_INFINITY;
  #double = false;
  #count = 0;
  #doubles = 0;

  get count(): number {
    return this.#count;
  }

  get doubles(): number {
    return this.#doubles;
  }

  get sinceOnset(): number {
    return this.#t;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    if (!this.#primed) {
      this.#primed = true;
      this.#wait = exponential(ctx.rng, BLINK_MEAN_INTERVAL);
    }
    this.#t += dt;
    this.#wait -= dt;
    if (this.#wait <= 0) {
      // The onset fell inside this step, −wait seconds before its end: start the lid there, not at the step.
      this.#t = -this.#wait;
      this.#double = ctx.rng() < BLINK_DOUBLE_RATIO;
      this.#count++;
      if (this.#double) this.#doubles++;
      // The next onset is an exponential interval after this one, but never before this event has ended.
      this.#wait += Math.max(exponential(ctx.rng, BLINK_MEAN_INTERVAL), this.#double ? DOUBLE : SINGLE);
    }
    const t = this.#t;
    const lid =
      this.#double && t >= SINGLE + BLINK_DOUBLE_GAP
        ? singleLid(t - SINGLE - BLINK_DOUBLE_GAP)
        : singleLid(t);
    const v = ctx.weights.blink * lid;
    pose[Ch.LidL] = pose[Ch.LidL]! + v;
    pose[Ch.LidR] = pose[Ch.LidR]! + v;
  }
}

/** A new blink layer. Its first onset is an exponential interval after its first update. */
export function createBlink(): BlinkLayer {
  return new Blink();
}
