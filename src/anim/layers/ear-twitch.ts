/**
 * Ear-twitch layer (plan §3.5): one random twitch every U(6, 15) s, as a velocity impulse on one ear's spring
 * (f = 6 Hz, ζ = 0.35) in `ctx.springs`.
 *
 * Each twitch flicks one ear, left or right with equal odds, outward (away from the head's centre line).
 * Rotations are clockwise-positive on screen on both sides, so outward is `EarRotR` +, `EarRotL` −: the same
 * direction and size as the first swing of the `earTwitch` session clip (#77, `EarRotR` +12°), which the
 * director plays on session events on top of this always-running layer. `EAR_TWITCH_DV` is calibrated on
 * `SpringBank` at the app's substep (`SUBSTEP` = 1/120 s): from rest, the ear peaks at ≈ 12° about 33 ms
 * later. (The explicit damping term takes part of the kick in the first step, so the same impulse peaks
 * lower at coarser steps: ≈ 9.4° at 1/60 s.)
 *
 * The layer adds `w·pos` of its two springs to `EarRotL`/`EarRotR`, w = `ctx.weights.ears`; the springs rest
 * at target 0, which the layer never changes.
 */
import { uniform } from '../rng.ts';
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import type { AnimContext, Layer } from './index.ts';

/** Spring constants of the ear springs; the bank's owner configures both indices with them. */
export const EAR_SPRING = { freqHz: 6, zeta: 0.35 } as const;
/** Shortest interval between twitches, in seconds. */
export const EAR_TWITCH_MIN = 6;
/** Longest interval between twitches, in seconds. */
export const EAR_TWITCH_MAX = 15;
/**
 * Size of a twitch's velocity impulse, in rad/s (`EarRotR` gets +, `EarRotL` −): a ≈ 12° flick at 1/120 s.
 */
export const EAR_TWITCH_DV = 15.1;

/** SpringBank indices of the ear springs. */
export interface EarTwitchSprings {
  earL: number;
  earR: number;
}

export interface EarTwitchLayer extends Layer {
  /** Twitches so far. */
  readonly count: number;
  /** How many of them flicked the right ear. */
  readonly right: number;
  /** Seconds from the latest twitch's scheduled time to the end of the last update; `Infinity` before it. */
  readonly sinceTwitch: number;
}

function checkIndex(i: number, name: string): void {
  if (!Number.isInteger(i) || i < 0) throw new RangeError(`${name} must be an integer >= 0`);
}

class EarTwitch implements EarTwitchLayer {
  readonly #earL: number;
  readonly #earR: number;
  #primed = false;
  /** Seconds until the next twitch. */
  #wait = 0;
  #since = Number.POSITIVE_INFINITY;
  #count = 0;
  #right = 0;

  constructor(springs: EarTwitchSprings) {
    checkIndex(springs.earL, 'earL');
    checkIndex(springs.earR, 'earR');
    this.#earL = springs.earL;
    this.#earR = springs.earR;
  }

  get count(): number {
    return this.#count;
  }

  get right(): number {
    return this.#right;
  }

  get sinceTwitch(): number {
    return this.#since;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const rng = ctx.rng;
    const springs = ctx.springs;
    if (this.#earL >= springs.pos.length || this.#earR >= springs.pos.length) {
      throw new RangeError('ear spring index out of range');
    }
    if (!this.#primed) {
      this.#primed = true;
      this.#wait = uniform(rng, EAR_TWITCH_MIN, EAR_TWITCH_MAX);
    }
    this.#since += dt;
    this.#wait -= dt;
    if (this.#wait <= 0) {
      this.#since = -this.#wait;
      this.#count++;
      this.#wait += uniform(rng, EAR_TWITCH_MIN, EAR_TWITCH_MAX);
      if (rng() < 0.5) {
        this.#right++;
        springs.impulse(this.#earR, EAR_TWITCH_DV);
      } else {
        springs.impulse(this.#earL, -EAR_TWITCH_DV);
      }
    }
    const w = ctx.weights.ears;
    pose[Ch.EarRotL] = pose[Ch.EarRotL]! + w * springs.pos[this.#earL]!;
    pose[Ch.EarRotR] = pose[Ch.EarRotR]! + w * springs.pos[this.#earR]!;
  }
}

/**
 * A new ear-twitch layer kicking the springs at the given `ctx.springs` indices (configure them with
 * `EAR_SPRING`). Its first twitch is U(6, 15) s after its first update.
 * @throws RangeError unless both indices are integers ≥ 0; `update` throws if one is outside the bank.
 */
export function createEarTwitch(springs: EarTwitchSprings): EarTwitchLayer {
  return new EarTwitch(springs);
}
