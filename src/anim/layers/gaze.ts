/**
 * Gaze layer (plan §4.6.5 "Look-around"): a saccade every U(1.5, 4) s to a random iris offset of magnitude
 * ≤ 10, or, while `ctx.lookAt` is set (and finite), a gaze toward that point. The head follows the iris at
 * 30 % through two springs (f = 2 Hz, ζ = 0.8) in `ctx.springs`, whose targets are
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
/**
 * Distance from the eyes' centre (the `eyesCenter` of `createGaze`, the character's `spec.eyesCenter`), in design
 * units, at which a `lookAt` point turns the iris fully.
 */
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

/** Throws a RangeError unless both coordinates of the eyes' centre are finite. */
export function checkCenter(c: Readonly<LookAt>): void {
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) throw new RangeError('eyesCenter must be finite');
}

// The doubles kept between updates live in a `Float64Array`, one slot each: V8's mid tier boxes a double written to
// a class field as a new heap number on every write (#214).
/** Seconds until the next saccade. */
const WAIT = 0;
/** Seconds since the latest saccade's scheduled time. */
const SINCE = 1;
/** Target of the latest random saccade. */
const TX = 2;
const TY = 3;
/** Current iris offset. */
const IX = 4;
const IY = 5;
/** The midpoint between the eyes, design units (`createGaze`'s `eyesCenter`). */
const CX = 6;
const CY = 7;

class Gaze implements GazeLayer {
  readonly #rot: number;
  readonly #tilt: number;
  #primed = false;
  /** The doubles kept between updates, by slot. */
  readonly #s = new Float64Array(8);
  #count = 0;

  constructor(springs: GazeSprings, eyesCenter: Readonly<LookAt>) {
    checkIndex(springs.headRot, 'headRot');
    checkIndex(springs.headTilt, 'headTilt');
    checkCenter(eyesCenter);
    this.#rot = springs.headRot;
    this.#tilt = springs.headTilt;
    this.#s[SINCE] = Number.POSITIVE_INFINITY;
    this.#s[CX] = eyesCenter.x;
    this.#s[CY] = eyesCenter.y;
  }

  get count(): number {
    return this.#count;
  }

  get sinceSaccade(): number {
    return this.#s[SINCE]!;
  }

  get irisX(): number {
    return this.#s[IX]!;
  }

  get irisY(): number {
    return this.#s[IY]!;
  }

  update(dt: number, pose: Pose, ctx: AnimContext): void {
    const rng = ctx.rng;
    const springs = ctx.springs;
    const st = this.#s;
    if (this.#rot >= springs.pos.length || this.#tilt >= springs.pos.length) {
      throw new RangeError('gaze spring index out of range');
    }
    if (!this.#primed) {
      this.#primed = true;
      st[WAIT] = uniform(rng, SACCADE_MIN, SACCADE_MAX);
    }
    st[SINCE] = st[SINCE]! + dt;
    st[WAIT] = st[WAIT]! - dt;
    if (st[WAIT] <= 0) {
      st[SINCE] = -st[WAIT];
      this.#count++;
      st[WAIT] = st[WAIT] + uniform(rng, SACCADE_MIN, SACCADE_MAX);
      // Uniform over the disc of radius GAZE_MAX (u < 1, so the magnitude stays below it).
      const r = GAZE_MAX * Math.sqrt(rng());
      const a = 2 * Math.PI * rng();
      st[TX] = r * Math.cos(a);
      st[TY] = r * Math.sin(a);
    }
    let tx = st[TX]!;
    let ty = st[TY]!;
    const look = ctx.lookAt;
    // A point with a non-finite coordinate (e.g. from a zero-size layout) counts as unset, so it can never
    // poison the iris or the springs. Finite is tested as `v − v === 0` (NaN and ±∞ give NaN) and the
    // `min(1, …)` is written out: V8's mid tier calls Number.isFinite and Math.min with boxed arguments.
    if (look != null) {
      const lx = look.x;
      const ly = look.y;
      if (lx - lx === 0 && ly - ly === 0) {
        // Toward the point: full offset at LOOK_SATURATE or farther, proportional closer in.
        const dx = lx - st[CX]!;
        const dy = ly - st[CY]!;
        const d = Math.sqrt(dx * dx + dy * dy);
        const near = d / LOOK_SATURATE;
        const s = d > 0 ? (GAZE_MAX * (near < 1 ? near : 1)) / d : 0;
        tx = dx * s;
        ty = dy * s;
      }
    }
    // A convex step toward the target: the iris stays inside the disc.
    const k = 1 - Math.exp(-dt / IRIS_TAU);
    st[IX] = st[IX]! + (tx - st[IX]!) * k;
    st[IY] = st[IY]! + (ty - st[IY]!) * k;
    const ix = st[IX];
    const iy = st[IY];
    springs.target[this.#rot] = HEAD_FOLLOW * (ix / GAZE_MAX) * HEAD_FULL_ANGLE;
    springs.target[this.#tilt] = HEAD_FOLLOW * (iy / GAZE_MAX) * HEAD_FULL_ANGLE;
    const w = ctx.weights.gaze;
    pose[Ch.IrisX] = pose[Ch.IrisX]! + w * ix;
    pose[Ch.IrisY] = pose[Ch.IrisY]! + w * iy;
    pose[Ch.HeadRot] = pose[Ch.HeadRot]! + w * springs.pos[this.#rot]!;
    pose[Ch.HeadTilt] = pose[Ch.HeadTilt]! + w * springs.pos[this.#tilt]!;
  }
}

/**
 * A new gaze layer driving the head-follow springs at the given `ctx.springs` indices (configure them with
 * `GAZE_SPRING`), looking at `ctx.lookAt` from `eyesCenter` (design units: the character's `spec.eyesCenter`, Juni's
 * (500, 385)). Its first saccade is U(1.5, 4) s after its first update.
 * @throws RangeError unless both indices are integers ≥ 0 and `eyesCenter` is finite; `update` throws if an index is
 * outside the bank.
 */
export function createGaze(springs: GazeSprings, eyesCenter: Readonly<LookAt>): GazeLayer {
  return new Gaze(springs, eyesCenter);
}
