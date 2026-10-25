/**
 * The rig: pose channels → one 2D affine matrix per bone (plan §4.6.5, §4.6.6; issue #75).
 *
 * The rig is built per character (duck plan §4.1): `createRig(spec)` compiles a `CharacterSpec`'s art and drives into
 * typed tables on the `Rig`, so this module holds no character data.
 *
 * A bone's matrix maps **rest-pose design coordinates** (the 1000 × 1400 design box of the character's art, e.g.
 * `art/bear.svg`, y down) to posed design coordinates. It is `parent × translate(pivot + offset) × rotate(θ) × scale(sx, sy)
 * × translate(−pivot)`, so the neutral pose (every channel 0) gives the identity for every bone. The view
 * transform (design units → canvas pixels) is not part of it: the renderer multiplies it in front.
 *
 * **Output layout** (`boneMatrices`): 6 floats per bone, in the art's `BONES` order. Bone `i` is
 * `out[6i … 6i + 5] = [a, b, c, d, e, f]`, in `CanvasRenderingContext2D.setTransform(a, b, c, d, e, f)` order:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 *
 * **Signs.** Rotations are radians, **clockwise-positive on screen** (y down), with the same sign on both
 * sides: there is no L/R sign mirroring (ORCH-ANSWER on #75). A `mirror: true` part is a path copy drawn
 * under `translate(1000, 0) scale(−1, 1)`, right-multiplied, so the mirror applies to the part only: `partMatrix`
 * gives `bone × part-level × mirror`. So "both arms up" is `ArmRotL = +θ`, `ArmRotR = −θ`.
 */
import { Ch } from './pose.ts';
import type { Pose } from './pose.ts';
import type { CharacterSpec } from '../characters/types.ts';

/** Floats per matrix: `[a, b, c, d, e, f]`. */
export const MAT = 6;

/** A `mirror: true` part is drawn under `translate(MIRROR_X, 0) scale(−1, 1)`: mirrored about x = 500. */
export const MIRROR_X = 1000;

/** Part kinds (`Rig.kind`): how the renderer treats a part beyond `bone × fill`. */
export const PartKind = {
  /** Drawn under its bone matrix [× mirror], with its own fill and opacity. */
  plain: 0,
  /**
   * `spec.gazeParts` (Juni: `iris*`, `pupil*`, `highlight*`): translated by (`IrisX` ± `IrisConverge`, `IrisY`) in
   * eye-bone space (+ for the left eye, − for the right); clipped to the sclera.
   */
  gaze: 1,
  /** `spec.lidParts.L` (Juni: `lidUpperL`): scaled in y about its bbox top by `LidL`. */
  lidL: 2,
  /** `spec.lidParts.R` (Juni: `lidUpperR`): scaled in y about its bbox top by `LidR`. */
  lidR: 3,
  /** `spec.blushParts` (Juni: `blushL`, `blushR`): alpha `0.35·Blush` instead of the file's opacity 0. */
  blush: 4,
} as const;

/**
 * A character's rig: the tables `boneMatrices`, `partMatrix` and the renderer read, built once from its spec by
 * `createRig`. Every rig is built by that one factory, so every rig has the same object shape (one hidden class).
 */
export interface Rig {
  /** The character. */
  readonly spec: CharacterSpec;
  /** Number of bones: `boneMatrices` needs `out.length ≥ boneCount · MAT`. */
  readonly boneCount: number;
  /**
   * One `Path2D` per part, in `PARTS` order, built once from `PARTS[i].d`. Parts with the same `d` (a mirrored copy
   * and its source) share one. Empty for a rig built with `paths: false`.
   */
  readonly paths: readonly Path2D[];
  /** `PartKind` per part, in `PARTS` order. */
  readonly kind: Uint8Array;
  /**
   * The mouth draws right before `PARTS[mouthSlot]` (after the last part of the `mouth.afterSubtree` subtree;
   * `PARTS.length` = after every part); −1 for mouth kind `'parts'`, so the renderer's slot test is never true.
   */
  readonly mouthSlot: number;
  /** The mouth's bone (`mouth.bone`), −1 for mouth kind `'parts'`. */
  readonly jaw: number;
  /** The stars' bone (`stars.bone`). */
  readonly head: number;
  /** Parent bone index per bone, `BONES` order; −1 for the root. */
  readonly parent: Int32Array;
  /** Pivot per bone, design units. */
  readonly pivotX: Float64Array;
  readonly pivotY: Float64Array;
  /** Channel of each term, `BONES` order × `TERMS` (rot, tx, ty, sx, sy); −1 = none. */
  readonly driveCh: Int8Array;
  /** Gain of each term. */
  readonly driveK: Float64Array;
  /**
   * Per part, `PARTS` order: the sign `IrisConverge` moves a gaze part with in eye-bone x. +1 for the eye whose
   * bone pivot is left of the mirror axis at rest (`eyeL`), −1 for the one right of it (`eyeR`), 0 for every
   * other part. So + moves both irises toward the face's centre line (#222).
   */
  readonly irisSide: Int8Array;
  /** The preallocated matrix stack: each bone's world matrix in double precision, 6 per bone, `BONES` order. */
  readonly stack: Float64Array;
  /** The renderer's per-frame scratch: `boneMatrices` output for the frame being drawn. */
  readonly boneBuf: Float32Array;
}

/** Terms per bone in the compiled tables: rot, tx, ty, sx, sy. */
const TERMS = 5;

/** `spec.art.BONE[id]`, or throws: a missing bone means the art and the spec disagree. */
function boneOf(spec: CharacterSpec, id: string): number {
  const i = spec.art.BONE[id];
  if (i === undefined) throw new Error(`no bone ${id} in ${spec.id}'s art`);
  return i;
}

/** `spec.art.PART[id]`, or throws. */
function partOf(spec: CharacterSpec, id: string): number {
  const i = spec.art.PART[id];
  if (i === undefined) throw new Error(`no part ${id} in ${spec.id}'s art`);
  return i;
}

/** The index of bone `id` in the rig's `BONES`, or throws: a missing bone means the art and the rig disagree. */
export function boneIndex(rig: Rig, id: string): number {
  return boneOf(rig.spec, id);
}

/** The index of part `id` in the rig's `PARTS`, or throws. */
export function partIndex(rig: Rig, id: string): number {
  return partOf(rig.spec, id);
}

/** True if bone `b` is `ancestor` or one of its descendants. */
function inSubtree(parent: Int32Array, b: number, ancestor: number): boolean {
  for (let i = b; i >= 0; i = parent[i]!) if (i === ancestor) return true;
  return false;
}

/**
 * Builds `spec`'s rig: the bone and drive tables, the `Path2D` objects (once), the part kinds, the matrix stack and
 * the renderer's bone buffer. `paths: false` leaves `paths` empty (no `Path2D`, for Node: scripts/gesture-eval.ts);
 * every other field is built. Allocates: call it at setup.
 * @throws Error if the spec names a bone or part its art lacks, or the art lists a child before its parent.
 */
export function createRig(spec: CharacterSpec, opts?: { paths?: boolean }): Rig {
  const { BONES, PARTS } = spec.art;
  const boneCount = BONES.length;
  const parent = new Int32Array(boneCount);
  const pivotX = new Float64Array(boneCount);
  const pivotY = new Float64Array(boneCount);
  for (let i = 0; i < boneCount; i++) {
    const bone = BONES[i]!;
    if (bone.parent >= i) throw new Error(`BONES must list parents before children: ${bone.id}`);
    parent[i] = bone.parent;
    pivotX[i] = bone.pivot[0];
    pivotY[i] = bone.pivot[1];
  }
  const driveCh = new Int8Array(boneCount * TERMS).fill(-1);
  const driveK = new Float64Array(boneCount * TERMS);
  for (const [id, drive] of Object.entries(spec.drives)) {
    const i = boneOf(spec, id);
    const terms = [drive.rot, drive.tx, drive.ty, drive.sx, drive.sy];
    for (let t = 0; t < TERMS; t++) {
      const entry = terms[t];
      if (entry === undefined) continue;
      driveCh[i * TERMS + t] = entry[0];
      driveK[i * TERMS + t] = entry[1];
    }
  }

  const irisSide = new Int8Array(PARTS.length);
  for (const id of spec.gazeParts) {
    const i = partOf(spec, id);
    const x = BONES[PARTS[i]!.bone]!.pivot[0];
    if (x === MIRROR_X / 2) throw new Error(`gaze part ${id}: its eye bone sits on the centre line`);
    irisSide[i] = x < MIRROR_X / 2 ? 1 : -1;
  }

  const kind = new Uint8Array(PARTS.length);
  for (const id of spec.gazeParts) kind[partOf(spec, id)] = PartKind.gaze;
  for (const id of spec.blushParts) kind[partOf(spec, id)] = PartKind.blush;
  kind[partOf(spec, spec.lidParts.L)] = PartKind.lidL;
  kind[partOf(spec, spec.lidParts.R)] = PartKind.lidR;

  const mouth = spec.mouth;
  const after = mouth.kind === 'lips' ? boneOf(spec, mouth.afterSubtree) : -1;
  const jaw = mouth.kind === 'lips' ? boneOf(spec, mouth.bone) : -1;
  const head = boneOf(spec, spec.stars.bone);

  const build = opts?.paths ?? true;
  const byD = new Map<string, Path2D>();
  const paths: Path2D[] = [];
  let mouthSlot = mouth.kind === 'lips' ? 0 : -1;
  for (let i = 0; i < PARTS.length; i++) {
    const part = PARTS[i]!;
    if (build) {
      let path = byD.get(part.d);
      if (path === undefined) {
        path = new Path2D(part.d);
        byD.set(part.d, path);
      }
      paths.push(path);
    }
    if (after >= 0 && inSubtree(parent, part.bone, after)) mouthSlot = i + 1;
  }

  return {
    spec,
    boneCount,
    paths,
    kind,
    mouthSlot,
    jaw,
    head,
    parent,
    pivotX,
    pivotY,
    driveCh,
    driveK,
    irisSide,
    stack: new Float64Array(boneCount * MAT),
    boneBuf: new Float32Array(boneCount * MAT),
  };
}

/**
 * Writes every bone's matrix (layout: see the module doc) to `out` and returns it. Never allocates: it works
 * in the rig's preallocated matrix stack (`rig.stack`) and copies each result to `out`.
 */
export function boneMatrices(rig: Rig, pose: Pose, out: Float32Array): Float32Array {
  const count = rig.boneCount;
  if (out.length < count * MAT) throw new RangeError('boneMatrices: out needs 6 floats per bone');
  const w = rig.stack;
  const driveCh = rig.driveCh;
  const driveK = rig.driveK;
  const pivotX = rig.pivotX;
  const pivotY = rig.pivotY;
  const parent = rig.parent;
  for (let i = 0; i < count; i++) {
    // Each term is k·pose[ch], or 0 without a channel. Written out, not a helper: a call that TurboFan
    // doesn't inline boxes its double result, which would allocate.
    const t = i * TERMS;
    let ch = driveCh[t]!;
    const rot = ch < 0 ? 0 : driveK[t]! * pose[ch]!;
    ch = driveCh[t + 1]!;
    const tx = ch < 0 ? 0 : driveK[t + 1]! * pose[ch]!;
    ch = driveCh[t + 2]!;
    const ty = ch < 0 ? 0 : driveK[t + 2]! * pose[ch]!;
    ch = driveCh[t + 3]!;
    const sx = ch < 0 ? 1 : 1 + driveK[t + 3]! * pose[ch]!;
    ch = driveCh[t + 4]!;
    const sy = ch < 0 ? 1 : 1 + driveK[t + 4]! * pose[ch]!;
    const px = pivotX[i]!;
    const py = pivotY[i]!;
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
    const p = parent[i]!;
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
  const p = rig.spec.art.PARTS[part]!;
  const q = p.bone * MAT;
  let a = bones[q]!;
  let b = bones[q + 1]!;
  let c = bones[q + 2]!;
  let d = bones[q + 3]!;
  let e = bones[q + 4]!;
  let f = bones[q + 5]!;
  const kind = rig.kind[part]!;
  if (kind === PartKind.gaze) {
    const ix = pose[Ch.IrisX]! + rig.irisSide[part]! * pose[Ch.IrisConverge]!;
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
