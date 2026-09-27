/**
 * Gaze layer (plan §4.6.5 "Look-around"): a saccade every U(1.5, 4) s to a random iris offset of magnitude
 * ≤ 10, or, while `ctx.lookAt` is set, a gaze toward that point. The head follows the iris at 30 % through
 * two springs (f = 2 Hz, ζ = 0.8) in `ctx.springs`, whose targets are
 *
 *     HeadRot  = 0.3·(IrisX / 10)·0.12 rad
 *     HeadTilt = 0.3·(IrisY / 10)·0.12 rad
 *
 * (10 is the iris limit and 0.12 rad the full-follow head angle, so the head turns at most 0.036 rad ≈ 2.1°).
 *
 * Signs (rotations are clockwise-positive on screen, y down, on both sides): looking right (IrisX > 0) rolls
 * the head clockwise, its crown toward the gaze, as in the `thinking` base pose (IrisX +4, HeadRot +4°);
 * looking down (IrisY > 0, y down) turns the neck clockwise, looking up counter-clockwise.
 *
 * The iris moves to each new target with a time constant of 15 ms (a quick dart that stays inside the
 * ≤ 10 disc). The layer adds `w·iris` to `IrisX`/`IrisY` and `w·pos` of its two springs to
 * `HeadRot`/`HeadTilt`, w = `ctx.weights.gaze`.
 */
import { uniform } from '../rng.ts';
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import type { AnimContext, Layer, LookAt } from './index.ts';

/** Spring constants of the head-follow springs; the bank's owner configures both indices with them. */
export const GAZE_SPRING = { freqHz: 2, zeta: 0.8 } as const;
/** Largest iris offset, in design units. */
export const GAZE_MAX = 10;
/** Share of the gaze the head follows. */
export const HEAD_FOLLOW = 0.3;
/** Head angle of a full follow (iris at `GAZE_MAX`), in radians. */
export const HEAD_FULL_ANGLE = 0.12;
/** Shortest interval between saccades, in seconds. */
export const SACCADE_MIN = 1.5;
/** Longest interval between saccades, in seconds. */
export const SACCADE_MAX = 4;
/** Time constant of the iris moving to a new target, in seconds. */
export const IRIS_TAU = 0.015;
/** Midpoint between the eyes (plan §4.6.5: eyes at (405/595, 385)), in design units. */
export const EYES_CENTER: Readonly<LookAt> = { x: 500, y: 385 };
/** Distance from `EYES_CENTER`, in design units, at which a `lookAt` point turns the iris fully. */
export const LOOK_SATURATE = 200;

/** SpringBank indices of the head-follow springs. */
export interface GazeSprings {
  headRot: number;
  headTilt: number;
}

export interface GazeLayer extends Layer {
  /** Random saccades so far (they are scheduled while `lookAt` is set too, but not looked at). */
  readonly count: number;
  /** Seconds from the latest saccade's scheduled time to the end of the last update; `Infinity` before it. */
  readonly sinceSaccade: number;
  /** Current iris offset, in design units. */
  readonly irisX: number;
  readonly irisY: number;
}

function checkIndex(i: number, name: string): void {
  if (!Number.isInteger(i) || i < 0) throw new RangeError(`${name} must be an integer >= 0`);
}

class Gaze implements GazeLayer {
  readonly #rot: number;
  readonly #tilt: number;
  #primed = false;
  /** Seconds until the next saccade. */
  #wait = 0;
  #since = Number.POSITIVE_INFINITY;
  #count = 0;
  /** Target of the latest random saccade. */
  #tx = 0;
  #ty = 0;
  #ix = 0;
  #iy = 0;

  constructor(springs: GazeSprings) {
    checkIndex(springs.headRot, 'headRot');
    checkIndex(springs.headTilt, 'headTilt');
    this.#rot = springs.headRot;
    this.#tilt = springs.headTilt;
  }

  get count(): number {
    return this.#count;
  }

  get sinceSaccade(): number {
    return this.#since;
  }

  get irisX(): number {
    return this.#ix;
  }

  get irisY(): number {
    return this.#iy;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const rng = ctx.rng;
    const springs = ctx.springs;
    if (this.#rot >= springs.pos.length || this.#tilt >= springs.pos.length) {
      throw new RangeError('gaze spring index out of range');
    }
    if (!this.#primed) {
      this.#primed = true;
      this.#wait = uniform(rng, SACCADE_MIN, SACCADE_MAX);
    }
    this.#since += dt;
    this.#wait -= dt;
    if (this.#wait <= 0) {
      this.#since = -this.#wait;
      this.#count++;
      this.#wait += uniform(rng, SACCADE_MIN, SACCADE_MAX);
      // Uniform over the disc of radius GAZE_MAX (u < 1, so the magnitude stays below it).
      const r = GAZE_MAX * Math.sqrt(rng());
      const a = 2 * Math.PI * rng();
      this.#tx = r * Math.cos(a);
      this.#ty = r * Math.sin(a);
    }
    let tx = this.#tx;
    let ty = this.#ty;
    const look = ctx.lookAt;
    if (look != null) {
      // Toward the point: full offset at LOOK_SATURATE or farther, proportional closer in.
      const dx = look.x - EYES_CENTER.x;
      const dy = look.y - EYES_CENTER.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const s = d > 0 ? (GAZE_MAX * Math.min(1, d / LOOK_SATURATE)) / d : 0;
      tx = dx * s;
      ty = dy * s;
    }
    // A convex step toward the target: the iris stays inside the disc.
    const k = 1 - Math.exp(-dt / IRIS_TAU);
    this.#ix += (tx - this.#ix) * k;
    this.#iy += (ty - this.#iy) * k;
    springs.target[this.#rot] = HEAD_FOLLOW * (this.#ix / GAZE_MAX) * HEAD_FULL_ANGLE;
    springs.target[this.#tilt] = HEAD_FOLLOW * (this.#iy / GAZE_MAX) * HEAD_FULL_ANGLE;
    const w = ctx.weights.gaze;
    pose[Ch.IrisX] = pose[Ch.IrisX]! + w * this.#ix;
    pose[Ch.IrisY] = pose[Ch.IrisY]! + w * this.#iy;
    pose[Ch.HeadRot] = pose[Ch.HeadRot]! + w * springs.pos[this.#rot]!;
    pose[Ch.HeadTilt] = pose[Ch.HeadTilt]! + w * springs.pos[this.#tilt]!;
  }
}

/**
 * A new gaze layer driving the head-follow springs at the given `ctx.springs` indices (configure them with
 * `GAZE_SPRING`). Its first saccade is U(1.5, 4) s after its first update.
 * @throws RangeError unless both indices are integers ≥ 0; `update` throws if one is outside the bank.
 */
export function createGaze(springs: GazeSprings): GazeLayer {
  return new Gaze(springs);
}
