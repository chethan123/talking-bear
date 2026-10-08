/**
 * Mood layer (plan §3.5): `joy` and `annoy` scalars in [0, 1] that decay exponentially with τ = 8 s. M5's
 * reactions `bump` them. For M4, `joy` adds `Blush` ×0.3 and `annoy` adds `BrowL`/`BrowR` ×(−3) (brows
 * down, in design units).
 *
 * Mood has no entry in `ctx.weights`: it adds its full amount in every state, and the director shapes it
 * through `bump` instead.
 */
import { Ch } from '../pose.ts';
import type { Pose } from '../pose.ts';
import type { Layer } from './index.ts';

/** Decay time constant of `joy` and `annoy`, in seconds: each falls to 1/e of its value in 8 s. */
export const MOOD_TAU = 8;
/** `Blush` per unit of `joy`. */
export const MOOD_BLUSH = 0.3;
/** `BrowL`/`BrowR` per unit of `annoy`, in design units. */
export const MOOD_BROW = -3;

export type MoodKind = 'joy' | 'annoy';

export interface MoodLayer extends Layer {
  readonly joy: number;
  readonly annoy: number;
  /**
   * Adds `amount` to `kind`, clamped to [0, 1].
   * @throws RangeError unless `amount` is finite.
   */
  bump(kind: MoodKind, amount: number): void;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Slots of the mood's doubles.
const JOY = 0;
const ANNOY = 1;

class Mood implements MoodLayer {
  /**
   * `joy` and `annoy`, by slot (`JOY`, `ANNOY`): a `Float64Array`, not class fields, because V8's mid tier boxes a
   * double written to a class field as a new heap number on every write, every substep once a mood is bumped (#229).
   */
  readonly #s = new Float64Array(2);

  get joy(): number {
    return this.#s[JOY]!;
  }

  get annoy(): number {
    return this.#s[ANNOY]!;
  }

  bump(kind: MoodKind, amount: number): void {
    if (!Number.isFinite(amount)) throw new RangeError('amount must be finite');
    const s = this.#s;
    if (kind === 'joy') s[JOY] = clamp01(s[JOY]! + amount);
    else s[ANNOY] = clamp01(s[ANNOY]! + amount);
  }

  update(dt: number, pose: Pose): void {
    const s = this.#s;
    const decay = Math.exp(-dt / MOOD_TAU);
    s[JOY] = s[JOY]! * decay;
    s[ANNOY] = s[ANNOY]! * decay;
    const brow = MOOD_BROW * s[ANNOY];
    pose[Ch.Blush] = pose[Ch.Blush]! + MOOD_BLUSH * s[JOY];
    pose[Ch.BrowL] = pose[Ch.BrowL]! + brow;
    pose[Ch.BrowR] = pose[Ch.BrowR]! + brow;
  }
}

/** A new mood layer, with `joy` = `annoy` = 0. */
export function createMood(): MoodLayer {
  return new Mood();
}
