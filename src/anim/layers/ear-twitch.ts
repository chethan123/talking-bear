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
 * **Orientation toward a background touch** (plan §4.6.4 "Background: gaze to the point; ears orient", #255): the
 * ear layer also reads `ctx.lookAt`, as the gaze does. While it is set (and finite), both ears turn toward the point's
 * side by the same angle, `EAR_ORIENT_MAX · clamp((lookAt.x − eyesCenter.x) / LOOK_SATURATE, −1, 1)`: the horizontal
 * offset from the head's centre line, saturating at the gaze's distance, so a point left of the head turns both ears
 * counter-clockwise (tips left, −) and a point right of it clockwise (+); the vertical offset is ignored. A point
 * with a non-finite coordinate counts as unset. The orientation eases toward that target, and back to 0 once
 * `lookAt` clears, with the gaze iris's exponential step, time constant `EAR_ORIENT_TAU` (95 % in 150 ms, frame-rate
 * independent, no overshoot, so `EAR_ORIENT_MAX` is a hard bound). It is no spring: the ear springs, their twitches
 * and the reaction clips' kicks on them are exactly as without a touch, and the clips' own ear keys are added by the
 * director's pose, so all of them play on top of the orientation. While `lookAt` has never been set the
 * orientation stays +0, and the ear channels are bit for bit what they were before #255 (unless the incoming channel
 * is −0: `pos + 0` maps a −0 spring position to +0; the app's layer buffer is +0-filled).
 *
 * The layer adds `w·(pos + orientation)` for each ear to `EarRotL`/`EarRotR`, w = `ctx.weights.ears` (0 while
 * Asleep, so the orientation is scaled and ramped like the twitch); the springs rest at target 0, which the layer
 * never changes.
 */
import { uniform } from '../rng.ts';
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import { checkCenter, LOOK_SATURATE } from './gaze.ts';
import type { AnimContext, Layer, LookAt } from './index.ts';

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
/**
 * Largest turn of the ears toward a `ctx.lookAt` point, in radians (8°). Both ear pivots lie inside the head and
 * inside their own ear, which is drawn behind the head, so no angle can detach an ear (#255).
 */
export const EAR_ORIENT_MAX = (8 * Math.PI) / 180;
/** Time constant of the ears easing toward their orientation and back after `lookAt` clears, in seconds. */
export const EAR_ORIENT_TAU = 0.05;

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

// The doubles kept between updates live in a `Float64Array`, one slot each: V8's mid tier boxes a double written to
// a class field as a new heap number on every write (#214).
/** Seconds until the next twitch. */
const WAIT = 0;
/** Seconds since the latest twitch's scheduled time. */
const SINCE = 1;
/** The ears' current orientation toward `ctx.lookAt`, in radians (+0 at rest). */
const ORIENT = 2;
/** The orientation's target this update, in radians. */
const TARGET = 3;
/** The x of the midpoint between the eyes, design units (`createEarTwitch`'s `eyesCenter`). */
const CX = 4;

class EarTwitch implements EarTwitchLayer {
  readonly #earL: number;
  readonly #earR: number;
  #primed = false;
  /** The doubles kept between updates, by slot. */
  readonly #s = new Float64Array(5);
  #count = 0;
  #right = 0;

  constructor(springs: EarTwitchSprings, eyesCenter: Readonly<LookAt>) {
    checkIndex(springs.earL, 'earL');
    checkIndex(springs.earR, 'earR');
    checkCenter(eyesCenter);
    this.#earL = springs.earL;
    this.#earR = springs.earR;
    this.#s[SINCE] = Number.POSITIVE_INFINITY;
    this.#s[CX] = eyesCenter.x;
  }

  get count(): number {
    return this.#count;
  }

  get right(): number {
    return this.#right;
  }

  get sinceTwitch(): number {
    return this.#s[SINCE]!;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const rng = ctx.rng;
    const springs = ctx.springs;
    const s = this.#s;
    if (this.#earL >= springs.pos.length || this.#earR >= springs.pos.length) {
      throw new RangeError('ear spring index out of range');
    }
    if (!this.#primed) {
      this.#primed = true;
      s[WAIT] = uniform(rng, EAR_TWITCH_MIN, EAR_TWITCH_MAX);
    }
    s[SINCE] = s[SINCE]! + dt;
    s[WAIT] = s[WAIT]! - dt;
    if (s[WAIT] <= 0) {
      s[SINCE] = -s[WAIT];
      this.#count++;
      s[WAIT] = s[WAIT] + uniform(rng, EAR_TWITCH_MIN, EAR_TWITCH_MAX);
      if (rng() < 0.5) {
        this.#right++;
        springs.impulse(this.#earR, EAR_TWITCH_DV);
      } else {
        springs.impulse(this.#earL, -EAR_TWITCH_DV);
      }
    }
    // The orientation toward a background touch (#255). Its doubles stay in slots, finite is tested as `v − v === 0`
    // and the clamp assigns literals: no double crosses a call or a `?:` with an imported constant (#229).
    s[TARGET] = 0;
    const look = ctx.lookAt;
    if (look != null) {
      const lx = look.x;
      const ly = look.y;
      if (lx - lx === 0 && ly - ly === 0) {
        let u = (lx - s[CX]!) / LOOK_SATURATE;
        if (u > 1) u = 1;
        else if (u < -1) u = -1;
        s[TARGET] = EAR_ORIENT_MAX * u;
      }
    }
    s[ORIENT] = s[ORIENT]! + (s[TARGET] - s[ORIENT]!) * (1 - Math.exp(-dt / EAR_ORIENT_TAU));
    const o = s[ORIENT];
    const w = ctx.weights.ears;
    pose[Ch.EarRotL] = pose[Ch.EarRotL]! + w * (springs.pos[this.#earL]! + o);
    pose[Ch.EarRotR] = pose[Ch.EarRotR]! + w * (springs.pos[this.#earR]! + o);
  }
}

/**
 * A new ear-twitch layer kicking the springs at the given `ctx.springs` indices (configure them with
 * `EAR_SPRING`), orienting toward `ctx.lookAt` relative to `eyesCenter` (design units: the character's
 * `spec.eyesCenter`, as the gaze's). Its first twitch is U(6, 15) s after its first update.
 * @throws RangeError unless both indices are integers ≥ 0 and `eyesCenter` is finite; `update` throws if an index is
 * outside the bank.
 */
export function createEarTwitch(springs: EarTwitchSprings, eyesCenter: Readonly<LookAt>): EarTwitchLayer {
  return new EarTwitch(springs, eyesCenter);
}
