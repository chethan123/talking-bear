/**
 * The always-running additive layers of plan §3.5 and §4.6.5: blink, breathing, gaze (with head follow), ear
 * twitch and mood.
 *
 * Contract shared by every layer:
 * - `update(dt, pose, ctx)` both advances the layer's own state by `dt` seconds and **adds** its
 *   contribution for the new time to `pose`, scaled by its weight in `ctx.weights` (mood has no weight: see
 *   mood.ts). It never overwrites a channel. So call it exactly once per substep, on a pose the caller has
 *   reseeded for that substep (base pose, clips, …): calling it twice advances time twice, and skipping the
 *   reseed adds the layers up twice.
 * - Timing is exact for any `dt` sequence: the clocks carry the remainder from step to step (an event due
 *   inside a step is dated to its exact time), decays use exp(−dt/τ) and phases accumulate `dt`. Only the
 *   blink lid is sampled per step, and spring motion is discretised by `SpringBank` itself.
 * - Every random choice comes from `ctx.rng`, so the same seed and the same `dt` sequence give the same pose
 *   sequence. No layer calls `Math.random`.
 * - No layer allocates per update: no object or array literals, closures, spreads or array destructuring
 *   in any `update`.
 * - Spring-driven layers (gaze, ear twitch) write targets or impulses to `ctx.springs` and read the springs'
 *   positions. They neither configure (`set`) nor `step` the bank: its owner (#81) configures each spring
 *   from the layer's exported constants (`GAZE_SPRING`, `EAR_SPRING`; reduced motion may raise ζ) and steps
 *   the bank once per substep, before the layers.
 * - The gaze and ear-twitch layers are the **only** writers of their springs' positions into `HeadRot`,
 *   `HeadTilt` and `EarRotL`/`EarRotR` (scaled by their weights). The bank's owner must not add those
 *   springs' positions to the pose again.
 */
import type { Pose } from '../pose.ts';
import type { SpringBank } from '../springs.ts';

/** Per-layer weights in [0, 1] (0 = the layer adds nothing, 1 = its full amount); the director sets them. */
export interface LayerWeights {
  blink: number;
  breathing: number;
  gaze: number;
  ears: number;
}

/** A point to look at, in design units (the 1000 × 1400 design box of plan §4.6.5, y down). */
export interface LookAt {
  x: number;
  y: number;
}

export interface AnimContext {
  /** Uniform source on [0, 1); seeded (`mulberry32`, ../rng.ts) so runs are reproducible. */
  rng: () => number;
  weights: LayerWeights;
  /** When set, the gaze looks toward this point instead of making random saccades. */
  lookAt?: LookAt | null;
  springs: SpringBank;
}

export interface Layer {
  update(dt: number, pose: Pose, ctx: AnimContext): void;
}
