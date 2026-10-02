/**
 * Pose channels: the one flat `Float32Array` the animation core writes and the renderer reads (plan §4.6.6).
 *
 * Neutral is 0 for every channel. Units:
 * - rotations and tilts (`HeadRot`, `HeadTilt`, `EarRot*`, `TuftRot`, `BodyLean`, `ArmRot*`, …) are radians;
 * - `HeadX` / `HeadY` are offsets in design units;
 * - squish, squash and jiggle (`HeadSquishX/Y`, `BodySquash`, `BellyJiggle`) are multiplicative deltas:
 *   scale = 1 + value;
 * - `Jaw`, `MouthW`, `MouthRound`, `Teeth`, the lids (0 open, 1 closed), `EarFold*`, `NoseWrinkle`,
 *   `CheekPuff`, `Blush` and `Stars` run from 0 to 1;
 * - `IrisX` / `IrisY` are design units, at most 10;
 * - `IrisConverge` is design units: + moves each iris toward the face's centre line (the left eye's +x, the right
 *   eye's −x, in eye-bone space), − apart (#222);
 * - brows are design units, positive is up.
 *
 * `Ch` is a const object rather than a TS `enum`, so the module stays erasable syntax only.
 */
export const Ch = {
  HeadRot: 0,
  HeadTilt: 1,
  HeadX: 2,
  HeadY: 3,
  HeadSquishX: 4,
  HeadSquishY: 5,
  Jaw: 6,
  MouthW: 7,
  MouthRound: 8,
  Teeth: 9,
  LidL: 10,
  LidR: 11,
  IrisX: 12,
  IrisY: 13,
  BrowL: 14,
  BrowR: 15,
  EarRotL: 16,
  EarRotR: 17,
  EarFoldL: 18,
  EarFoldR: 19,
  NoseY: 20,
  NoseWrinkle: 21,
  CheekPuff: 22,
  Blush: 23,
  TuftRot: 24,
  BodySquash: 25,
  BodyLean: 26,
  BellyJiggle: 27,
  ArmRotL: 28,
  ArmRotR: 29,
  FootL: 30,
  FootR: 31,
  KerchiefA: 32,
  KerchiefB: 33,
  Stars: 34,
  IrisConverge: 35,
} as const;

/** Number of pose channels: the length of every `Pose`. */
export const CH_COUNT = 36;

/** One value per channel, indexed by `Ch`; length `CH_COUNT`. */
export type Pose = Float32Array;

/** A new neutral pose: all channels 0. Allocates, so call it at setup, never per frame. */
export function createPose(): Pose {
  return new Float32Array(CH_COUNT);
}

/**
 * `out[i] = a[i] + (b[i] − a[i])·t` for every channel; returns `out`. `t` is not clamped.
 * Never allocates. `out` may be `a` or `b`: each channel reads its inputs before it writes.
 */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  for (let i = 0; i < CH_COUNT; i++) {
    const ai = a[i]!;
    out[i] = ai + (b[i]! - ai) * t;
  }
  return out;
}

/**
 * `out[i] = base[i] + delta[i]·w` for every channel; returns `out`.
 * Never allocates. `out` may be `base` or `delta`, so a layer can accumulate in place.
 */
export function addPose(base: Pose, delta: Pose, w: number, out: Pose): Pose {
  for (let i = 0; i < CH_COUNT; i++) {
    out[i] = base[i]! + delta[i]! * w;
  }
  return out;
}
