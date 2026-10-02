import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BONES, PART, PARTS } from '../art/bear-parts.gen.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';
import type { Pose } from './pose.ts';
import {
  BONE_COUNT,
  boneIndex,
  boneMatrices,
  createRig,
  MAT,
  PartKind,
  partIndex,
  partMatrix,
} from './rig.ts';

/** Stands in for the DOM's `Path2D` in Node: records the path data it was built from. */
class FakePath2D {
  static built = 0;
  readonly d: string;
  constructor(d: string) {
    FakePath2D.built++;
    this.d = d;
  }
}

// At import time, before any describe body builds a rig.
vi.stubGlobal('Path2D', FakePath2D);
afterAll(() => {
  vi.unstubAllGlobals();
});

type Mat = readonly [number, number, number, number, number, number];

/** Reference affine product `m × n`, in `setTransform` order `[a, b, c, d, e, f]`. */
function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const T = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const R = (a: number): Mat => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const S = (x: number, y: number): Mat => [x, 0, 0, y, 0, 0];
const I: Mat = [1, 0, 0, 1, 0, 0];
const MIRROR: Mat = [-1, 0, 0, 1, 1000, 0];

/** The spec's local matrix: translate(pivot + offset) × rotate × scale × translate(−pivot). */
function local(bone: string, rot = 0, sx = 1, sy = 1, ox = 0, oy = 0): Mat {
  const [px, py] = BONES[boneIndex(bone)]!.pivot;
  return mul(mul(mul(T(px + ox, py + oy), R(rot)), S(sx, sy)), T(-px, -py));
}

/** Applies matrix `m` (at offset `o`) to the point (x, y). */
function apply(m: ArrayLike<number>, o: number, x: number, y: number): [number, number] {
  return [m[o]! * x + m[o + 2]! * y + m[o + 4]!, m[o + 1]! * x + m[o + 3]! * y + m[o + 5]!];
}

/** Bone `b`'s 6 floats, with −0 turned into +0. */
function boneMat(out: Float32Array, b: number): number[] {
  return Array.from(out.subarray(b * MAT, b * MAT + MAT), (x) => x + 0);
}

function expectClose(actual: ArrayLike<number>, expected: Mat, digits = 3): void {
  for (let k = 0; k < MAT; k++) expect(actual[k]).toBeCloseTo(expected[k]!, digits);
}

function expectPoint(p: [number, number], x: number, y: number): void {
  expect(p[0]).toBeCloseTo(x, 3);
  expect(p[1]).toBeCloseTo(y, 3);
}

function withChannels(values: readonly (readonly [number, number])[]): Pose {
  const p = createPose();
  for (const [ch, v] of values) p[ch] = v;
  return p;
}

/** True if bone `b` is `ancestor` or one of its descendants. */
function inSubtree(b: number, ancestor: number): boolean {
  for (let i = b; i >= 0; i = BONES[i]!.parent) if (i === ancestor) return true;
  return false;
}

function bonesOf(pose: Pose): Float32Array {
  return boneMatrices(createRig(), pose, new Float32Array(BONE_COUNT * MAT));
}

function partOf(pose: Pose, part: string): Float64Array {
  const rig = createRig();
  const m = new Float64Array(MAT);
  partMatrix(rig, pose, boneMatrices(rig, pose, new Float32Array(BONE_COUNT * MAT)), partIndex(part), m);
  return m;
}

describe('createRig', () => {
  it('builds one Path2D per distinct PARTS[i].d, once; a mirrored copy shares its source path', () => {
    const before = FakePath2D.built;
    const rig = createRig();
    expect(FakePath2D.built - before).toBe(new Set(PARTS.map((p) => p.d)).size);
    expect(rig.paths).toHaveLength(PARTS.length);
    for (let i = 0; i < PARTS.length; i++) {
      const path: unknown = rig.paths[i];
      if (!(path instanceof FakePath2D)) throw new Error(`paths[${i}] is not a Path2D`);
      expect(path.d).toBe(PARTS[i]!.d);
      if (PARTS[i]!.mirror) expect(rig.paths[i]).toBe(rig.paths[i - 1]);
    }
    const built = FakePath2D.built;
    const out = new Float32Array(BONE_COUNT * MAT);
    const m = new Float64Array(MAT);
    boneMatrices(rig, createPose(), out);
    for (let i = 0; i < PARTS.length; i++) partMatrix(rig, createPose(), out, i, m);
    expect(FakePath2D.built).toBe(built);
  });

  it('classifies the gaze, lid and blush parts, and puts the mouth after the muzzle subtree', () => {
    const rig = createRig();
    const expected = new Map<string, number>([
      ['irisL', PartKind.gaze],
      ['pupilL', PartKind.gaze],
      ['highlightL', PartKind.gaze],
      ['irisR', PartKind.gaze],
      ['pupilR', PartKind.gaze],
      ['highlightR', PartKind.gaze],
      ['lidUpperL', PartKind.lidL],
      ['lidUpperR', PartKind.lidR],
      ['blushL', PartKind.blush],
      ['blushR', PartKind.blush],
    ]);
    for (let i = 0; i < PARTS.length; i++) {
      expect(rig.kind[i], PARTS[i]!.id).toBe(expected.get(PARTS[i]!.id) ?? PartKind.plain);
    }
    expect(rig.mouthSlot).toBe(PART.upperLipLine! + 1);
    expect(PARTS[rig.mouthSlot]!.id).toBe('scleraL');
  });
});

describe('boneMatrices', () => {
  it('neutral pose → every bone matrix is the identity', () => {
    const out = bonesOf(createPose());
    for (let b = 0; b < BONE_COUNT; b++) expect(boneMat(out, b), BONES[b]!.id).toEqual([...I]);
  });

  it('HeadRot = π/2 turns the head (and its children) clockwise about the head pivot (500, 600)', () => {
    const out = bonesOf(withChannels([[Ch.HeadRot, Math.PI / 2]]));
    const head = boneIndex('head') * MAT;
    const eyeL = boneIndex('eyeL') * MAT;
    expectPoint(apply(out, head, 500, 600), 500, 600); // the pivot stays put
    expectPoint(apply(out, head, 500, 165), 935, 600); // the head top (435 above the pivot) goes to 435 right of it
    expectPoint(apply(out, head, 790, 400), 700, 890); // the right cheek edge swings down
    expectPoint(apply(out, eyeL, 405, 385), 715, 505); // eyeL's pivot follows its parent
    expect(boneMat(out, boneIndex('armL'))).toEqual([...I]);
    expect(boneMat(out, boneIndex('neck'))).toEqual([...I]);
  });

  it('composes parent × translate(pivot + offset) × rotate × scale × translate(−pivot) down the chain', () => {
    const pose = withChannels([
      [Ch.BodyLean, 0.05],
      [Ch.BodySquash, 0.08],
      [Ch.HeadTilt, 0.2],
      [Ch.HeadRot, -0.3],
      [Ch.HeadX, 12],
      [Ch.HeadY, -7],
      [Ch.HeadSquishX, 0.1],
      [Ch.HeadSquishY, -0.05],
      [Ch.EarRotL, 0.4],
      [Ch.EarFoldL, 0.5],
    ]);
    const out = bonesOf(pose);
    const body = local('body', 0.05, 1 - 0.5 * 0.08, 1 + 0.08);
    const neck = mul(body, local('neck', 0.2));
    const head = mul(neck, local('head', -0.3, 1.1, 0.95, 12, -7));
    const earL = mul(head, local('earL', 0.4, 1, 1 - 0.5 * 0.5));
    expectClose(boneMat(out, boneIndex('body')), body);
    expectClose(boneMat(out, boneIndex('neck')), neck);
    expectClose(boneMat(out, boneIndex('head')), head);
    expectClose(boneMat(out, boneIndex('eyeL')), head);
    expectClose(boneMat(out, boneIndex('earL')), earL);
    expectClose(boneMat(out, boneIndex('innerEarL')), earL);
    expectClose(boneMat(out, boneIndex('armL')), body);
  });

  // Issue #75's channel → bone table, one channel at a time: the bone gets `local`, its subtree follows, and
  // every other bone stays the identity.
  const rows: readonly (readonly [
    name: string,
    ch: number,
    v: number,
    bones: readonly string[],
    m: (b: string) => Mat,
  ])[] = [
    ['HeadRot', Ch.HeadRot, 0.4, ['head'], (b) => local(b, 0.4)],
    ['HeadTilt', Ch.HeadTilt, 0.4, ['neck'], (b) => local(b, 0.4)],
    ['HeadX', Ch.HeadX, 15, ['head'], () => T(15, 0)],
    ['HeadY', Ch.HeadY, -9, ['head'], () => T(0, -9)],
    ['HeadSquishX', Ch.HeadSquishX, 0.2, ['head'], (b) => local(b, 0, 1.2, 1)],
    ['HeadSquishY', Ch.HeadSquishY, -0.1, ['head'], (b) => local(b, 0, 1, 0.9)],
    ['EarRotL', Ch.EarRotL, 0.3, ['earL'], (b) => local(b, 0.3)],
    ['EarRotR', Ch.EarRotR, -0.3, ['earR'], (b) => local(b, -0.3)],
    ['EarFoldL', Ch.EarFoldL, 0.6, ['earL'], (b) => local(b, 0, 1, 0.7)],
    ['EarFoldR', Ch.EarFoldR, 0.6, ['earR'], (b) => local(b, 0, 1, 0.7)],
    ['TuftRot', Ch.TuftRot, 0.25, ['tuft'], (b) => local(b, 0.25)],
    ['BodySquash', Ch.BodySquash, 0.1, ['body'], (b) => local(b, 0, 0.95, 1.1)],
    ['BodyLean', Ch.BodyLean, 0.05, ['body'], (b) => local(b, 0.05)],
    ['BellyJiggle', Ch.BellyJiggle, 0.1, ['belly'], (b) => local(b, 0, 1.1, 1.1)],
    ['ArmRotL', Ch.ArmRotL, 0.5, ['armL'], (b) => local(b, 0.5)],
    ['ArmRotR', Ch.ArmRotR, -0.5, ['armR'], (b) => local(b, -0.5)],
    ['FootL', Ch.FootL, 0.5, ['footL'], () => T(-15, 0)],
    ['FootR', Ch.FootR, 0.5, ['footR'], () => T(15, 0)],
    ['KerchiefA', Ch.KerchiefA, 0.3, ['tailA'], (b) => local(b, 0.3)],
    ['KerchiefB', Ch.KerchiefB, -0.3, ['tailB'], (b) => local(b, -0.3)],
    ['NoseY', Ch.NoseY, 4, ['nose'], () => T(0, 4)],
    ['NoseWrinkle', Ch.NoseWrinkle, 1, ['nose'], (b) => local(b, 0, 1, 0.85)],
    ['CheekPuff', Ch.CheekPuff, 0.3, ['cheekBlushL', 'cheekBlushR'], (b) => local(b, 0, 1.3, 1.3)],
    ['BrowL', Ch.BrowL, 6, ['browL'], () => T(0, -6)],
    ['BrowR', Ch.BrowR, 6, ['browR'], () => T(0, -6)],
  ];
  for (const [name, ch, v, driven, m] of rows) {
    it(`${name} = ${v} drives ${driven.join(' and ')} only`, () => {
      const out = bonesOf(withChannels([[ch, v]]));
      for (let b = 0; b < BONE_COUNT; b++) {
        const owner = driven.find((d) => inSubtree(b, boneIndex(d)));
        expectClose(boneMat(out, b), owner === undefined ? I : m(owner), 4);
      }
    });
  }

  it('the channels without a bone (mouth, lids, iris, blush, stars) leave every bone the identity', () => {
    const pose = withChannels(
      [
        Ch.Jaw,
        Ch.MouthW,
        Ch.MouthRound,
        Ch.Teeth,
        Ch.LidL,
        Ch.LidR,
        Ch.IrisX,
        Ch.IrisY,
        Ch.IrisConverge,
        Ch.Blush,
        Ch.Stars,
      ].map((ch) => [ch, 0.7] as const),
    );
    const out = bonesOf(pose);
    for (let b = 0; b < BONE_COUNT; b++) expect(boneMat(out, b)).toEqual([...I]);
  });

  it('returns out, and throws a RangeError when out has fewer than 6 floats per bone', () => {
    const rig = createRig();
    const out = new Float32Array(BONE_COUNT * MAT);
    expect(boneMatrices(rig, createPose(), out)).toBe(out);
    expect(() => boneMatrices(rig, createPose(), new Float32Array(BONE_COUNT * MAT - 1))).toThrow(RangeError);
  });
});

describe('partMatrix', () => {
  it('IrisX / IrisY translate the iris, pupil and highlight in eye-bone space; other eye parts stay', () => {
    const pose = withChannels([
      [Ch.IrisX, 6],
      [Ch.IrisY, -4],
    ]);
    for (const id of ['irisL', 'pupilL', 'highlightL', 'irisR', 'pupilR', 'highlightR'])
      expectClose(partOf(pose, id), T(6, -4));
    for (const id of ['scleraL', 'lidLowerL', 'scleraR', 'lidLowerR', 'noseTip'])
      expectClose(partOf(pose, id), I);
    // With the head turned π/2, the offset turns with it: the gaze moves in eye-bone space.
    const turned = withChannels([
      [Ch.HeadRot, Math.PI / 2],
      [Ch.IrisX, 10],
    ]);
    const head = local('head', Math.PI / 2);
    expectClose(partOf(turned, 'irisL'), mul(head, T(10, 0)));
  });

  it('IrisConverge moves the left eye’s iris, pupil and highlight +v and the right eye’s −v in eye-bone x (#222)', () => {
    const pose = withChannels([[Ch.IrisConverge, 6]]);
    for (const id of ['irisL', 'pupilL', 'highlightL']) expectClose(partOf(pose, id), T(6, 0));
    for (const id of ['irisR', 'pupilR', 'highlightR']) expectClose(partOf(pose, id), T(-6, 0));
    for (const id of ['scleraL', 'lidUpperL', 'lidLowerL', 'scleraR', 'lidUpperR', 'lidLowerR', 'noseTip'])
      expect(Array.from(partOf(pose, id)), id).toEqual(Array.from(partOf(createPose(), id)));
    // It adds to the gaze offset: IrisX 4, IrisY −2, IrisConverge 6 → left (10, −2), right (−2, −2).
    const both = withChannels([
      [Ch.IrisX, 4],
      [Ch.IrisY, -2],
      [Ch.IrisConverge, 6],
    ]);
    expectClose(partOf(both, 'irisL'), T(10, -2));
    expectClose(partOf(both, 'irisR'), T(-2, -2));
    // Negative values move the irises apart.
    expectClose(partOf(withChannels([[Ch.IrisConverge, -3]]), 'pupilL'), T(-3, 0));
    expectClose(partOf(withChannels([[Ch.IrisConverge, -3]]), 'pupilR'), T(3, 0));
    // In eye-bone space: with the head turned π/2 the offset turns with the face.
    const turned = withChannels([
      [Ch.HeadRot, Math.PI / 2],
      [Ch.IrisConverge, 6],
    ]);
    const head = local('head', Math.PI / 2);
    expectClose(partOf(turned, 'irisL'), mul(head, T(6, 0)));
    expectClose(partOf(turned, 'irisR'), mul(head, T(-6, 0)));
  });

  it('LidL / LidR scale the upper lids in y about their bbox top, clamped to [0, 1]', () => {
    const top = PARTS[partIndex('lidUpperL')]!.bbox[1];
    expect(top).toBe(335);
    const quarter = partOf(withChannels([[Ch.LidL, 0.25]]), 'lidUpperL');
    expectClose(quarter, [1, 0, 0, 0.25, 0, top * 0.75]);
    expect(apply(quarter, 0, 400, top)[1]).toBeCloseTo(top, 6); // the top edge stays put
    expect(apply(quarter, 0, 400, 433)[1]).toBeCloseTo(top + 0.25 * (433 - top), 6);
    // LidR stays 0 (hidden): lidUpperR collapses onto its top edge (the renderer skips drawing it).
    expect(PARTS[partIndex('lidUpperR')]!.bbox[1]).toBe(top);
    expectClose(partOf(withChannels([[Ch.LidL, 0.25]]), 'lidUpperR'), [1, 0, 0, 0, 0, top]);
    expectClose(partOf(withChannels([[Ch.LidR, 0.6]]), 'lidUpperR'), [1, 0, 0, 0.6, 0, top * 0.4]);
    expectClose(partOf(withChannels([[Ch.LidL, 1]]), 'lidUpperL'), I);
    expectClose(partOf(withChannels([[Ch.LidL, 1.5]]), 'lidUpperL'), I);
    expectClose(partOf(withChannels([[Ch.LidL, -0.5]]), 'lidUpperL'), [1, 0, 0, 0, 0, top]);
    expectClose(partOf(withChannels([[Ch.LidL, 0.5]]), 'lidLowerL'), I);
  });
});

describe('mirror handling (rotation channels are clockwise-positive with the same sign on both sides)', () => {
  it('at neutral, a mirrored copy draws its source path under translate(1000, 0) scale(−1, 1)', () => {
    const mirrored = PARTS.filter((p) => p.mirror).map((p) => p.id);
    expect(mirrored).toHaveLength(11);
    for (const id of mirrored) expectClose(partOf(createPose(), id), MIRROR);
    const [minX, minY] = PARTS[partIndex('armFurR')]!.bbox;
    const p = apply(partOf(createPose(), 'armFurR'), 0, minX, minY);
    expect(p[0]).toBeCloseTo(1000 - minX, 6);
    expect(p[1]).toBeCloseTo(minY, 6);
  });

  it('ArmRotL = +π/2 moves pawL toward −x; ArmRotR = −π/2 moves pawR toward +x (arms up)', () => {
    // armL pivot (300, 700), pawL pivot (326.6, 867.9): the offset (26.6, 167.9) turns to (−167.9, 26.6).
    const left = bonesOf(withChannels([[Ch.ArmRotL, Math.PI / 2]]));
    const pawL = apply(left, boneIndex('pawL') * MAT, 326.6, 867.9);
    expect(pawL[0]).toBeCloseTo(132.1, 3);
    expect(pawL[1]).toBeCloseTo(726.6, 3);
    // armR pivot (700, 700), pawR pivot (673.4, 867.9): the offset (−26.6, 167.9) turns to (167.9, 26.6).
    const right = bonesOf(withChannels([[Ch.ArmRotR, -Math.PI / 2]]));
    const pawR = apply(right, boneIndex('pawR') * MAT, 673.4, 867.9);
    expect(pawR[0]).toBeCloseTo(867.9, 3);
    expect(pawR[1]).toBeCloseTo(726.6, 3);
    // The same sign turns both arms the same way on screen: +π/2 swings pawR toward −x too.
    const same = bonesOf(withChannels([[Ch.ArmRotR, Math.PI / 2]]));
    expect(apply(same, boneIndex('pawR') * MAT, 673.4, 867.9)[0]).toBeCloseTo(700 - 167.9, 3);
  });

  it('under a left/right-symmetric pose (ArmRotR = −ArmRotL, …) every mirrored copy is the mirror image of its source', () => {
    const pose = withChannels([
      [Ch.ArmRotL, 0.7],
      [Ch.ArmRotR, -0.7],
      [Ch.FootL, 0.5],
      [Ch.FootR, 0.5],
      [Ch.BrowL, 5],
      [Ch.BrowR, 5],
      [Ch.CheekPuff, 0.4],
      [Ch.HeadSquishX, 0.1],
      [Ch.BodySquash, 0.05],
      [Ch.Blush, 1],
    ]);
    for (let i = 0; i < PARTS.length; i++) {
      const part = PARTS[i]!;
      if (!part.mirror) continue;
      const copy = partOf(pose, part.id);
      const source = partOf(pose, PARTS[i - 1]!.id);
      const [x0, y0, x1, y1] = part.bbox;
      for (const [x, y] of [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ] as const) {
        const c = apply(copy, 0, x, y);
        const s = apply(source, 0, x, y);
        expect(c[0], `${part.id} x`).toBeCloseTo(1000 - s[0], 3);
        expect(c[1], `${part.id} y`).toBeCloseTo(s[1], 3);
      }
    }
  });
});

type Constructor = new (...args: never[]) => object;

/** Wraps `original` so that every `new` of it, including those inside its static `from` and `of`, calls `onNew`. */
function countingConstructor<C extends Constructor>(original: C, onNew: () => void): C {
  return new Proxy(original, {
    construct(target, args: never[], newTarget: Constructor): object {
      onNew();
      return Reflect.construct(target, args, newTarget);
    },
  });
}

/** `%TypedArray%.prototype`, which every typed array class inherits its methods from. */
const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Float32Array.prototype) ?? Float32Array.prototype;
/** Its methods that return a new typed array. */
const TYPED_ARRAY_METHODS = ['slice', 'map', 'filter', 'subarray', 'toReversed', 'toSorted', 'with'] as const;

/**
 * Runs `fn` and counts the allocations it makes through the array globals (the pattern of
 * src/dsp/voicing.test.ts): every `new` of `Array`, `ArrayBuffer`, `Float32Array` or `Float64Array` (static
 * `from` and `of` included, and `new` through a typed array's `constructor`), and every call of an allocating
 * `%TypedArray%.prototype` method. Everything is restored afterwards.
 */
function countAllocations(fn: () => void): number {
  let count = 0;
  const onNew = (): void => {
    count++;
  };
  const saved: { obj: object; key: string; desc: PropertyDescriptor }[] = [];
  const patch = (obj: object, key: string, value: unknown): void => {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined) throw new Error(`nothing to patch at ${key}`);
    saved.push({ obj, key, desc });
    Object.defineProperty(obj, key, { ...desc, value });
  };
  const float32 = countingConstructor(Float32Array, onNew);
  const float64 = countingConstructor(Float64Array, onNew);
  patch(Float32Array.prototype, 'constructor', float32);
  patch(Float64Array.prototype, 'constructor', float64);
  patch(globalThis, 'Array', countingConstructor(Array, onNew));
  patch(globalThis, 'ArrayBuffer', countingConstructor(ArrayBuffer, onNew));
  patch(globalThis, 'Float32Array', float32);
  patch(globalThis, 'Float64Array', float64);
  for (const name of TYPED_ARRAY_METHODS) {
    const original: unknown = Reflect.get(TYPED_ARRAY_PROTOTYPE, name);
    if (typeof original !== 'function') throw new Error(`no %TypedArray%.prototype.${name}`);
    patch(TYPED_ARRAY_PROTOTYPE, name, function (this: unknown, ...args: unknown[]): unknown {
      count++;
      return Reflect.apply(original, this, args);
    });
  }
  try {
    fn();
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { obj, key, desc } = saved[i]!;
      Object.defineProperty(obj, key, desc);
    }
  }
  return count;
}

/** The `gc` function, exposed once at runtime with Node built-ins only (the technique of src/anim/clip.test.ts). */
let exposedGc: (() => void) | undefined;

/** Runs a full garbage collection. */
function forceGc(): void {
  if (exposedGc === undefined) {
    setFlagsFromString('--expose-gc');
    const gc: unknown = runInNewContext('gc');
    if (typeof gc !== 'function') throw new Error('gc() is not available');
    exposedGc = (): void => {
      gc();
    };
  }
  exposedGc();
}

/**
 * `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. If any GC ran during `fn`,
 * the reading is meaningless (a scavenge frees the garbage it should count), so it returns +Infinity.
 */
function heapGrowth(fn: () => void): number {
  forceGc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = process.memoryUsage().heapUsed;
  fn();
  const growth = process.memoryUsage().heapUsed - before;
  return profiler.stop().statistics.length > 0 ? Number.POSITIVE_INFINITY : growth;
}

describe('boneMatrices and partMatrix: no allocation', () => {
  const rig = createRig();
  // Every channel non-zero, so every code path runs (and gets optimised) before the measurement.
  const pose = createPose();
  for (let i = 0; i < CH_COUNT; i++) pose[i] = 0.1 + 0.01 * i;
  const out = new Float32Array(BONE_COUNT * MAT);
  const m = new Float64Array(MAT);

  it('the counter sees typed-array allocations (positive control)', () => {
    expect(countAllocations(() => void new Float64Array(4))).toBe(1);
    expect(countAllocations(() => void out.subarray(1))).toBeGreaterThan(0);
  });

  it('1 000 frames of boneMatrices + partMatrix for every part allocate nothing (countAllocations)', () => {
    let sum = 0;
    const count = countAllocations(() => {
      for (let k = 0; k < 1000; k++) {
        boneMatrices(rig, pose, out);
        for (let p = 0; p < PARTS.length; p++) {
          partMatrix(rig, pose, out, p, m);
          sum += m[4]!;
        }
      }
    });
    expect(count).toBe(0);
    expect(sum).not.toBe(0);
  });

  /** 10 000 `boneMatrices` calls. */
  const tenThousand = (): void => {
    for (let k = 0; k < 10_000; k++) boneMatrices(rig, pose, out);
  };

  it('10 000 boneMatrices calls grow heapUsed by < 1 MB, once V8 has optimised it', () => {
    // Until V8's optimising compilers take over, the interpreter boxes every double, so warm up first. V8 can
    // still re-tier after the warm-up (background compiles land late under load, forced GCs deopt), and a run
    // caught in a lower tier grows the heap by boxed doubles. So take the best of up to 20 runs, each from a
    // collected heap, with any run during which a GC ran counted as +Infinity (as in src/anim/clip.test.ts).
    // A real allocation shows in every run: a literal array per bone gave 2.8 to 7.0 MB.
    const LIMIT = 1_048_576;
    forceGc();
    for (let w = 0; w < 10; w++) tenThousand();
    let best = heapGrowth(tenThousand);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(tenThousand));
    expect(best).toBeLessThan(LIMIT);
  });

  it('the heap meter sees retained allocations (positive control, with a GC-free reading)', () => {
    // A run with a GC reads +Infinity, which would pass `≥ 1 MB` without proving anything, so retry until a
    // reading is finite. 2 500 arrays of 64 doubles read about 5.6 MB here, on the second trial (the first
    // one usually sees a GC).
    let kept: number[][] = [];
    let growth = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 20 && !Number.isFinite(growth); trial++) {
      kept = [];
      growth = heapGrowth(() => {
        for (let k = 0; k < 2500; k++) kept.push(Array.from({ length: 64 }, (_, j) => j + 0.5));
      });
    }
    expect(kept).toHaveLength(2500);
    expect(Number.isFinite(growth)).toBe(true);
    expect(growth).toBeGreaterThanOrEqual(1_048_576);
  });
});
