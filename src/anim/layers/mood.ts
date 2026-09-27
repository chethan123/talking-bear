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

class Mood implements MoodLayer {
  #joy = 0;
  #annoy = 0;

  get joy(): number {
    return this.#joy;
  }

  get annoy(): number {
    return this.#annoy;
  }

  bump(kind: MoodKind, amount: number): void {
    if (!Number.isFinite(amount)) throw new RangeError('amount must be finite');
    if (kind === 'joy') this.#joy = clamp01(this.#joy + amount);
    else this.#annoy = clamp01(this.#annoy + amount);
  }

  update(dt: number, pose: Pose): void {
    const decay = Math.exp(-dt / MOOD_TAU);
    this.#joy *= decay;
    this.#annoy *= decay;
    const brow = MOOD_BROW * this.#annoy;
    pose[Ch.Blush] = pose[Ch.Blush]! + MOOD_BLUSH * this.#joy;
    pose[Ch.BrowL] = pose[Ch.BrowL]! + brow;
    pose[Ch.BrowR] = pose[Ch.BrowR]! + brow;
  }
}

/** A new mood layer, with `joy` = `annoy` = 0. */
export function createMood(): MoodLayer {
  return new Mood();
}
