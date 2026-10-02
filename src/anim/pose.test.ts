import { describe, expect, it } from 'vitest';

import { Ch, CH_COUNT, addPose, createPose, lerpPose } from './pose.ts';
import type { Pose } from './pose.ts';

/**
 * The channel table exactly as issue #74 specifies it, plus `IrisConverge` appended by #222; later tasks index
 * poses by these numbers.
 */
const SPEC_CHANNELS = {
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
};

function poseFrom(value: (i: number) => number): Pose {
  const p = createPose();
  for (let i = 0; i < CH_COUNT; i++) p[i] = value(i);
  return p;
}

type Constructor = new (...args: never[]) => object;

/**
 * Wraps `original` so that every `new` of it, including those inside its static `from` and `of`,
 * calls `onNew`.
 */
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

/** The globals and methods `countAllocations` patches, in a fixed order. */
function patchedValues(): unknown[] {
  const globals = [Array, ArrayBuffer, Float32Array, Float64Array];
  const constructors = [Float32Array.prototype, Float64Array.prototype].map((proto): unknown =>
    Reflect.get(proto, 'constructor'),
  );
  return [
    ...globals,
    ...constructors,
    ...TYPED_ARRAY_METHODS.map((name): unknown => Reflect.get(TYPED_ARRAY_PROTOTYPE, name)),
  ];
}

/**
 * Runs `fn` and counts the allocations it makes through the array globals: every `new` of `Array`,
 * `ArrayBuffer`, `Float32Array` or `Float64Array` (static `from` and `of` included, and `new` through a
 * typed array's `constructor`), and every call of an allocating `%TypedArray%.prototype` method.
 * Everything is restored afterwards. Array and object literals, spreads and closures don't go through
 * these globals: they are out of reach without heap sampling and are left to review and X-A4.
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
  // `new (a.constructor)(n)` and the species lookup inside the typed array methods resolve through here.
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

describe('Ch and CH_COUNT', () => {
  it('match the channel table of the spec exactly', () => {
    expect(Ch).toEqual(SPEC_CHANNELS);
  });

  it('number the CH_COUNT = 36 channels 0 … 35, each exactly once', () => {
    expect(CH_COUNT).toBe(36);
    const values = Object.values(Ch).toSorted((x, y) => x - y);
    expect(values).toEqual(Array.from({ length: CH_COUNT }, (_, i) => i));
  });
});

describe('createPose', () => {
  it('returns a new neutral Float32Array of length CH_COUNT', () => {
    const p = createPose();
    expect(p).toBeInstanceOf(Float32Array);
    expect(p).toHaveLength(CH_COUNT);
    expect(Array.from(p)).toEqual(Array.from({ length: CH_COUNT }, () => 0));
    expect(createPose()).not.toBe(p);
  });
});

describe('lerpPose', () => {
  const a = poseFrom((i) => i);
  const b = poseFrom((i) => i + 4 * ((i % 3) - 1));

  it('returns a at t = 0, b at t = 1 and a + (b − a)·t between', () => {
    const out = createPose();
    expect(Array.from(lerpPose(a, b, 0, out))).toEqual(Array.from(a));
    expect(Array.from(lerpPose(a, b, 1, out))).toEqual(Array.from(b));
    expect(Array.from(lerpPose(a, b, 0.25, out))).toEqual(Array.from(poseFrom((i) => i + ((i % 3) - 1))));
  });

  it('may write into a or b', () => {
    const expected = Array.from(lerpPose(a, b, 0.75, createPose()));
    expect(Array.from(lerpPose(a.slice(), b, 0.75, a.slice()))).toEqual(expected);
    const inA = a.slice();
    expect(lerpPose(inA, b, 0.75, inA)).toBe(inA);
    expect(Array.from(inA)).toEqual(expected);
    const inB = b.slice();
    expect(lerpPose(a, inB, 0.75, inB)).toBe(inB);
    expect(Array.from(inB)).toEqual(expected);
  });

  it('returns out and never allocates', () => {
    const out = createPose();
    const buffer = out.buffer;
    const results: unknown[] = Array.from({ length: 100 });
    const allocations = countAllocations(() => {
      for (let r = 0; r < 100; r++) results[r] = lerpPose(a, b, r / 100, out);
    });
    expect(allocations).toBe(0);
    for (const result of results) expect(result).toBe(out);
    expect(out.buffer).toBe(buffer);
  });
});

describe('addPose', () => {
  const base = poseFrom((i) => i);
  const delta = poseFrom((i) => (i % 5) - 2);

  it('returns base + delta·w', () => {
    const out = createPose();
    expect(Array.from(addPose(base, delta, 0.5, out))).toEqual(
      Array.from(poseFrom((i) => i + ((i % 5) - 2) / 2)),
    );
    expect(Array.from(addPose(base, delta, 0, out))).toEqual(Array.from(base));
    expect(Array.from(addPose(base, delta, -2, out))).toEqual(
      Array.from(poseFrom((i) => i - 2 * ((i % 5) - 2))),
    );
  });

  it('accumulates in place when out is base', () => {
    const acc = base.slice();
    expect(addPose(acc, delta, 0.25, acc)).toBe(acc);
    addPose(acc, delta, 0.25, acc);
    expect(Array.from(acc)).toEqual(Array.from(poseFrom((i) => i + ((i % 5) - 2) / 2)));
  });

  it('returns out and never allocates', () => {
    const out = createPose();
    const buffer = out.buffer;
    const results: unknown[] = Array.from({ length: 100 });
    const allocations = countAllocations(() => {
      for (let r = 0; r < 100; r++) results[r] = addPose(base, delta, r / 100, out);
    });
    expect(allocations).toBe(0);
    for (const result of results) expect(result).toBe(out);
    expect(out.buffer).toBe(buffer);
  });
});

describe('countAllocations (the check above has teeth)', () => {
  const p = createPose();
  it.each<[string, () => unknown]>([
    ['new Float32Array', () => new Float32Array(CH_COUNT)],
    ['createPose', () => createPose()],
    ['Float32Array.from', () => Float32Array.from(p)],
    ['typed array slice', () => p.slice()],
    ['typed array map', () => p.map((v) => v)],
    ['typed array subarray', () => p.subarray(1)],
    ['new (a.constructor)(n)', () => Reflect.construct(p.constructor, [CH_COUNT])],
    ['Array.from', () => Array.from(p)],
    ['new ArrayBuffer', () => new ArrayBuffer(4)],
  ])('counts %s', (_name, allocate) => {
    expect(
      countAllocations(() => {
        allocate();
      }),
    ).toBeGreaterThan(0);
  });

  it('restores the globals afterwards', () => {
    const before = patchedValues();
    countAllocations(() => undefined);
    const after = patchedValues();
    expect(after).toHaveLength(before.length);
    after.forEach((value, i) => expect(value).toBe(before[i]));
  });
});
