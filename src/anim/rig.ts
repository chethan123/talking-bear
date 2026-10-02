/**
 * The rig: pose channels → one 2D affine matrix per bone (plan §4.6.5, §4.6.6; issue #75).
 *
 * A bone's matrix maps **rest-pose design coordinates** (the 1000 × 1400 design box of `art/bear.svg`,
 * y down) to posed design coordinates. It is `parent × translate(pivot + offset) × rotate(θ) × scale(sx, sy)
 * × translate(−pivot)`, so the neutral pose (every channel 0) gives the identity for every bone. The view
 * transform (design units → canvas pixels) is not part of it: the renderer multiplies it in front.
 *
 * **Output layout** (`boneMatrices`): 6 floats per bone, in `BONES` order. Bone `i` is
 * `out[6i … 6i + 5] = [a, b, c, d, e, f]`, in `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)` order:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 *
 * **Signs.** Rotations are radians, **clockwise-positive on screen** (y down), with the same sign on both
 * sides: there is no L/R sign mirroring (ORCH-ANSWER on #75). A `mirror: true` part is a path copy drawn
 * under `translate(1000, 0) scale(−1, 1)`, right-multiplied, so the mirror applies to the part only: `partMatrix`
 * gives `bone × part-level × mirror`. So "both arms up" is `ArmRotL = +θ`, `ArmRotR = −θ`.
 */
import { BONE, BONES, PART, PARTS } from '../art/bear-parts.gen.ts';
import { Ch } from './pose.ts';
import type { Pose } from './pose.ts';

/** Floats per matrix: `[a, b, c, d, e, f]`. */
export const MAT = 6;

/** A `mirror: true` part is drawn under `translate(MIRROR_X, 0) scale(−1, 1)`: mirrored about x = 500. */
export const MIRROR_X = 1000;

/** Number of bones: `boneMatrices` needs `out.length ≥ BONE_COUNT · MAT`. */
export const BONE_COUNT = BONES.length;

/** Part kinds (`Rig.kind`): how the renderer treats a part beyond `bone × fill`. */
export const PartKind = {
  /** Drawn under its bone matrix [× mirror], with its own fill and opacity. */
  plain: 0,
  /**
   * `iris*`, `pupil*`, `highlight*`: translated by (`IrisX` ± `IrisConverge`, `IrisY`) in eye-bone space (+ for the
   * left eye, − for the right); clipped to the sclera.
   */
  gaze: 1,
  /** `lidUpperL`: scaled in y about its bbox top by `LidL`. */
  lidL: 2,
  /** `lidUpperR`: scaled in y about its bbox top by `LidR`. */
  lidR: 3,
  /** `blushL`, `blushR`: alpha `0.35·Blush` instead of the file's opacity 0. */
  blush: 4,
} as const;

export interface Rig {
  /** One `Path2D` per part, in `PARTS` order, built once from `PARTS[i].d`. Parts with the same `d` (a mirrored copy and its source) share one. */
  readonly paths: readonly Path2D[];
  /** `PartKind` per part, in `PARTS` order. */
  readonly kind: Uint8Array;
  /** The mouth draws right before `PARTS[mouthSlot]` (after the last part of the `muzzle` subtree; `PARTS.length` = after every part). */
  readonly mouthSlot: number;
  /** The preallocated matrix stack: each bone's world matrix in double precision, 6 per bone, `BONES` order. */
  readonly stack: Float64Array;
}

/** One term `k · pose[ch]`. */
type Term = readonly [ch: number, k: number];

/** What drives a bone. Rotation `k·v` rad; translation `k·v` design units in the parent's space; scale `1 + k·v`. */
interface Drive {
  readonly rot?: Term;
  readonly tx?: Term;
  readonly ty?: Term;
  readonly sx?: Term;
  readonly sy?: Term;
}

/**
 * Issue #75's channel → bone table. `IrisX/Y`, `IrisConverge` and `LidL/R` are part-level (`partMatrix`); `Blush` is
 * the renderer's alpha.
 */
const DRIVES: Readonly<Record<string, Drive>> = {
  head: {
    rot: [Ch.HeadRot, 1],
    tx: [Ch.HeadX, 1],
    ty: [Ch.HeadY, 1],
    sx: [Ch.HeadSquishX, 1],
    sy: [Ch.HeadSquishY, 1],
  },
  neck: { rot: [Ch.HeadTilt, 1] },
  earL: { rot: [Ch.EarRotL, 1], sy: [Ch.EarFoldL, -0.5] },
  earR: { rot: [Ch.EarRotR, 1], sy: [Ch.EarFoldR, -0.5] },
  tuft: { rot: [Ch.TuftRot, 1] },
  body: { rot: [Ch.BodyLean, 1], sx: [Ch.BodySquash, -0.5], sy: [Ch.BodySquash, 1] },
  belly: { sx: [Ch.BellyJiggle, 1], sy: [Ch.BellyJiggle, 1] },
  armL: { rot: [Ch.ArmRotL, 1] },
  armR: { rot: [Ch.ArmRotR, 1] },
  footL: { tx: [Ch.FootL, -30] },
  footR: { tx: [Ch.FootR, 30] },
  tailA: { rot: [Ch.KerchiefA, 1] },
  tailB: { rot: [Ch.KerchiefB, 1] },
  nose: { ty: [Ch.NoseY, 1], sy: [Ch.NoseWrinkle, -0.15] },
  cheekBlushL: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  cheekBlushR: { sx: [Ch.CheekPuff, 1], sy: [Ch.CheekPuff, 1] },
  browL: { ty: [Ch.BrowL, -1] },
  browR: { ty: [Ch.BrowR, -1] },
};

/** Terms per bone in the compiled tables: rot, tx, ty, sx, sy. */
const TERMS = 5;
/** Channel of each term, `BONES` order × TERMS; −1 = none. */
const DRIVE_CH = new Int8Array(BONE_COUNT * TERMS).fill(-1);
/** Gain of each term. */
const DRIVE_K = new Float64Array(BONE_COUNT * TERMS);
const PARENT = new Int32Array(BONE_COUNT);
const PIVOT_X = new Float64Array(BONE_COUNT);
const PIVOT_Y = new Float64Array(BONE_COUNT);

for (let i = 0; i < BONE_COUNT; i++) {
  const bone = BONES[i]!;
  if (bone.parent >= i) throw new Error(`BONES must list parents before children: ${bone.id}`);
  PARENT[i] = bone.parent;
  PIVOT_X[i] = bone.pivot[0];
  PIVOT_Y[i] = bone.pivot[1];
}
for (const [id, drive] of Object.entries(DRIVES)) {
  const i = boneIndex(id);
  const terms = [drive.rot, drive.tx, drive.ty, drive.sx, drive.sy];
  for (let t = 0; t < TERMS; t++) {
    const entry = terms[t];
    if (entry === undefined) continue;
    DRIVE_CH[i * TERMS + t] = entry[0];
    DRIVE_K[i * TERMS + t] = entry[1];
  }
}

const GAZE_PARTS = ['irisL', 'pupilL', 'highlightL', 'irisR', 'pupilR', 'highlightR'] as const;
/**
 * Per part, `PARTS` order: the sign `IrisConverge` moves a gaze part with in eye-bone x. +1 for the eye whose
 * bone pivot is left of the mirror axis at rest (`eyeL`), −1 for the one right of it (`eyeR`), 0 for every
 * other part. So + moves both irises toward the face's centre line (#222).
 */
const IRIS_SIDE = new Int8Array(PARTS.length);
for (const id of GAZE_PARTS) {
  const i = partIndex(id);
  const x = BONES[PARTS[i]!.bone]!.pivot[0];
  if (x === MIRROR_X / 2) throw new Error(`gaze part ${id}: its eye bone sits on the centre line`);
  IRIS_SIDE[i] = x < MIRROR_X / 2 ? 1 : -1;
}
const BLUSH_PARTS = ['blushL', 'blushR'] as const;
const LID_L = partIndex('lidUpperL');
const LID_R = partIndex('lidUpperR');
const MUZZLE = boneIndex('muzzle');

/** `BONE[id]`, or throws: a missing bone means the art and the rig disagree. */
export function boneIndex(id: string): number {
  const i = BONE[id];
  if (i === undefined) throw new Error(`no bone ${id} in bear-parts.gen.ts`);
  return i;
}

/** `PART[id]`, or throws. */
export function partIndex(id: string): number {
  const i = PART[id];
  if (i === undefined) throw new Error(`no part ${id} in bear-parts.gen.ts`);
  return i;
}

/** True if bone `b` is `ancestor` or one of its descendants. */
function inSubtree(b: number, ancestor: number): boolean {
  for (let i = b; i >= 0; i = PARENT[i]!) if (i === ancestor) return true;
  return false;
}

/** Builds the rig: the `Path2D` objects (once), the part kinds and the matrix stack. Allocates: call it at setup. */
export function createRig(): Rig {
  const byD = new Map<string, Path2D>();
  const paths: Path2D[] = [];
  let mouthSlot = 0;
  for (let i = 0; i < PARTS.length; i++) {
    const part = PARTS[i]!;
    let path = byD.get(part.d);
    if (path === undefined) {
      path = new Path2D(part.d);
      byD.set(part.d, path);
    }
    paths.push(path);
    if (inSubtree(part.bone, MUZZLE)) mouthSlot = i + 1;
  }
  const kind = new Uint8Array(PARTS.length);
  for (const id of GAZE_PARTS) kind[partIndex(id)] = PartKind.gaze;
  for (const id of BLUSH_PARTS) kind[partIndex(id)] = PartKind.blush;
  kind[LID_L] = PartKind.lidL;
  kind[LID_R] = PartKind.lidR;
  return { paths, kind, mouthSlot, stack: new Float64Array(BONE_COUNT * MAT) };
}

/**
 * Writes every bone's matrix (layout: see the module doc) to `out` and returns it. Never allocates: it works
 * in the rig's preallocated matrix stack (`rig.stack`) and copies each result to `out`.
 */
export function boneMatrices(rig: Rig, pose: Pose, out: Float32Array): Float32Array {
  if (out.length < BONE_COUNT * MAT) throw new RangeError('boneMatrices: out needs 6 floats per bone');
  const w = rig.stack;
  for (let i = 0; i < BONE_COUNT; i++) {
    // Each term is k·pose[ch], or 0 without a channel. Written out, not a helper: a call that TurboFan
    // doesn't inline boxes its double result, which would allocate.
    const t = i * TERMS;
    let ch = DRIVE_CH[t]!;
    const rot = ch < 0 ? 0 : DRIVE_K[t]! * pose[ch]!;
    ch = DRIVE_CH[t + 1]!;
    const tx = ch < 0 ? 0 : DRIVE_K[t + 1]! * pose[ch]!;
    ch = DRIVE_CH[t + 2]!;
    const ty = ch < 0 ? 0 : DRIVE_K[t + 2]! * pose[ch]!;
    ch = DRIVE_CH[t + 3]!;
    const sx = ch < 0 ? 1 : 1 + DRIVE_K[t + 3]! * pose[ch]!;
    ch = DRIVE_CH[t + 4]!;
    const sy = ch < 0 ? 1 : 1 + DRIVE_K[t + 4]! * pose[ch]!;
    const px = PIVOT_X[i]!;
    const py = PIVOT_Y[i]!;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    // Local = translate(pivot + offset) × rotate × scale × translate(−pivot). `0 − …` keeps zeros positive.
    const a = cs * sx;
    const b = sn * sx;
    const c = 0 - sn * sy;
    const d = cs * sy;
    const e = px + tx - (a * px + c * py);
    const f = py + ty - (b * px + d * py);
    const o = i * MAT;
    const p = PARENT[i]!;
    if (p < 0) {
      w[o] = a;
      w[o + 1] = b;
      w[o + 2] = c;
      w[o + 3] = d;
      w[o + 4] = e;
      w[o + 5] = f;
    } else {
      const q = p * MAT;
      const pa = w[q]!;
      const pb = w[q + 1]!;
      const pc = w[q + 2]!;
      const pd = w[q + 3]!;
      w[o] = pa * a + pc * b;
      w[o + 1] = pb * a + pd * b;
      w[o + 2] = pa * c + pc * d;
      w[o + 3] = pb * c + pd * d;
      w[o + 4] = pa * e + pc * f + w[q + 4]!;
      w[o + 5] = pb * e + pd * f + w[q + 5]!;
    }
    for (let k = 0; k < MAT; k++) out[o + k] = w[o + k]!;
  }
  return out;
}

/**
 * Writes the draw matrix of `PARTS[part]` to `out[o … o + 5]`: its bone's matrix from `bones` (the output of
 * `boneMatrices`) × the part-level transform × the mirror for a `mirror: true` copy. Part-level:
 * - `gaze` parts: `translate(IrisX + side·IrisConverge, IrisY)`, in eye-bone space, with side +1 for the left eye
 *   and −1 for the right (toward the face's centre line);
 * - `lidL` / `lidR`: `scaleY = LidL / LidR` clamped to [0, 1], about the bbox top (`y = minY`);
 * - mirror: `translate(MIRROR_X, 0) scale(−1, 1)`, right-most, so it applies to the part only.
 * Never allocates.
 */
export function partMatrix(
  rig: Rig,
  pose: Pose,
  bones: Float32Array,
  part: number,
  out: Float32Array | Float64Array,
  o = 0,
): void {
  const p = PARTS[part]!;
  const q = p.bone * MAT;
  let a = bones[q]!;
  let b = bones[q + 1]!;
  let c = bones[q + 2]!;
  let d = bones[q + 3]!;
  let e = bones[q + 4]!;
  let f = bones[q + 5]!;
  const kind = rig.kind[part]!;
  if (kind === PartKind.gaze) {
    const ix = pose[Ch.IrisX]! + IRIS_SIDE[part]! * pose[Ch.IrisConverge]!;
    const iy = pose[Ch.IrisY]!;
    e += a * ix + c * iy;
    f += b * ix + d * iy;
  } else if (kind === PartKind.lidL || kind === PartKind.lidR) {
    const raw = pose[kind === PartKind.lidL ? Ch.LidL : Ch.LidR]!;
    const v = raw < 0 ? 0 : raw > 1 ? 1 : raw; // clamped inline: see boneMatrices
    const ty = p.bbox[1] * (1 - v);
    e += c * ty;
    f += d * ty;
    c *= v;
    d *= v;
  }
  if (p.mirror) {
    e += MIRROR_X * a;
    f += MIRROR_X * b;
    a = 0 - a;
    b = 0 - b;
  }
  out[o] = a;
  out[o + 1] = b;
  out[o + 2] = c;
  out[o + 3] = d;
  out[o + 4] = e;
  out[o + 5] = f;
}
