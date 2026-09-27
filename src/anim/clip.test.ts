import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BASE } from './base-poses.ts';
import type { BaseName } from './base-poses.ts';
import { sampleClip } from './clip.ts';
import type { Clip, Key } from './clip.ts';
import { Ch, CH_COUNT, createPose } from './pose.ts';

type Ease = Key['ease'];
const DEG = Math.PI / 180;
/** The mouth channels, which only the mouth layer writes (#79's `evaluate` never touches them). */
const MOUTH = [Ch.Jaw, Ch.MouthW, Ch.MouthRound, Ch.Teeth] as const;
/** Every ease, including the default (`undefined` = linear). */
const EASES: readonly Ease[] = ['linear', 'inOut', 'in', 'out', undefined];

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
 * src/anim/pose.test.ts): every `new` of `Array`, `ArrayBuffer`, `Float32Array` or `Float64Array` (static
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

/** Runs a full garbage collection, via a `gc` exposed at runtime (Node built-ins only). */
function forceGc(): void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (typeof gc !== 'function') throw new Error('gc() is not available');
  gc();
}

/** `heapUsed` growth in bytes over `fn`, measured from a freshly collected heap. */
function heapGrowth(fn: () => void): number {
  forceGc();
  const before = process.memoryUsage().heapUsed;
  fn();
  return process.memoryUsage().heapUsed - before;
}

/** 1–6 (at least `minLength`) distinct key times on a 10 ms grid in [0, 5] s, ascending. */
function times(minLength: number): fc.Arbitrary<number[]> {
  return fc
    .uniqueArray(fc.integer({ min: 0, max: 500 }), { minLength, maxLength: 6 })
    .map((a) => a.toSorted((x, y) => x - y).map((i) => i / 100));
}
/** A key value on a 0.01 grid in [−10, 10]. */
const VALUE = fc.integer({ min: -1000, max: 1000 }).map((i) => i / 100);
const EASE = fc.constantFrom<Ease>(...EASES);

/** A clip with one track, on `ch`. */
function oneTrack(keys: readonly Key[], duration: number, ch: number = Ch.HeadRot): Clip {
  return { name: 'test', duration, tracks: [{ ch, keys }] };
}

/** The `ch` channel of `c` sampled at `t` into a fresh pose. */
function sampleAt(c: Clip, t: number, ch: number = Ch.HeadRot): number {
  return sampleClip(c, t, createPose())[ch]!;
}

/** Whether `xs` is monotone (non-decreasing if `up`, else non-increasing) and within [lo, hi]. */
function monotoneWithin(xs: readonly number[], up: boolean, lo: number, hi: number): boolean {
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x < lo || x > hi) return false;
    if (i > 0 && (up ? x < xs[i - 1]! : x > xs[i - 1]!)) return false;
  }
  return true;
}

describe('sampleClip: validation 1, the sample at a key time is the key value', () => {
  it.each(EASES.map((e) => [String(e), e] as const))('for ease %s', (_name, e) => {
    const keys: Key[] = [
      { t: 0, v: -1.5, ease: e },
      { t: 0.5, v: 2.25, ease: e },
      { t: 1.25, v: 0.5, ease: e },
      { t: 2, v: -3 },
    ];
    const c = oneTrack(keys, 2);
    for (const k of keys) expect(sampleAt(c, k.t)).toBe(Math.fround(k.v));
  });

  it('for random keys and eases on the 10 ms / 0.01 grids (300 runs)', () => {
    const arbitrary = times(1).chain((ts) =>
      fc.tuple(
        fc.constant(ts),
        fc.array(VALUE, { minLength: ts.length, maxLength: ts.length }),
        fc.array(EASE, { minLength: ts.length, maxLength: ts.length }),
        fc.integer({ min: 0, max: 100 }),
      ),
    );
    fc.assert(
      fc.property(arbitrary, ([ts, vs, es, extra]) => {
        const keys: Key[] = ts.map((t, i) => ({ t, v: vs[i]!, ease: es[i] }));
        const c = oneTrack(keys, ts.at(-1)! + extra / 100);
        const out = createPose();
        for (const k of keys) expect(sampleClip(c, k.t, out)[Ch.HeadRot]).toBe(Math.fround(k.v));
      }),
      { numRuns: 300 },
    );
  });

  it('holds the first value before the first key and the last value after the last key', () => {
    const c = oneTrack(
      [
        { t: 0.2, v: 1, ease: 'inOut' },
        { t: 0.6, v: 3 },
      ],
      1,
    );
    expect(sampleAt(c, 0.1)).toBe(1);
    expect(sampleAt(c, 0.9)).toBe(3);
  });
});

describe('sampleClip: validation 2, eases are monotone between monotone keys', () => {
  const shapes: readonly (readonly [string, Ease, (u: number) => number])[] = [
    ['linear', 'linear', (u) => u],
    ['default', undefined, (u) => u],
    ['inOut (smoothstep)', 'inOut', (u) => 3 * u * u - 2 * u * u * u],
    ['in (u²)', 'in', (u) => u * u],
    ['out (1 − (1 − u)²)', 'out', (u) => 1 - (1 - u) * (1 - u)],
  ];

  it.each(shapes)('%s has the specified shape', (_name, e, f) => {
    const c = oneTrack(
      [
        { t: 0, v: 0, ease: e },
        { t: 1, v: 1 },
      ],
      1,
    );
    for (const u of [0.25, 0.5, 0.75]) {
      expect(Math.abs(sampleAt(c, u) - Math.fround(f(u)))).toBeLessThanOrEqual(1e-7);
    }
  });

  it('one segment: every ease moves monotonically from v0 to v1 and stays between them (300 runs)', () => {
    fc.assert(
      fc.property(EASE, times(2), VALUE, VALUE, (e, ts, v0, v1) => {
        const t0 = ts[0]!;
        const t1 = ts[1]!;
        const c = oneTrack(
          [
            { t: t0, v: v0, ease: e },
            { t: t1, v: v1 },
          ],
          t1,
        );
        const out = createPose();
        const xs: number[] = [];
        for (let s = 0; s <= 200; s++) xs.push(sampleClip(c, t0 + ((t1 - t0) * s) / 200, out)[Ch.HeadRot]!);
        return monotoneWithin(xs, v1 >= v0, Math.fround(Math.min(v0, v1)), Math.fround(Math.max(v0, v1)));
      }),
      { numRuns: 300 },
    );
  });

  it('several segments with sorted values and mixed eases are monotone across the track (300 runs)', () => {
    const arbitrary = times(3).chain((ts) =>
      fc.tuple(
        fc.constant(ts),
        fc.array(VALUE, { minLength: ts.length, maxLength: ts.length }),
        fc.array(EASE, { minLength: ts.length, maxLength: ts.length }),
        fc.boolean(),
      ),
    );
    fc.assert(
      fc.property(arbitrary, ([ts, vs, es, up]) => {
        const sorted = vs.toSorted((a, b) => (up ? a - b : b - a));
        const keys: Key[] = ts.map((t, i) => ({ t, v: sorted[i]!, ease: es[i] }));
        const d = ts.at(-1)!;
        const c = oneTrack(keys, d);
        const out = createPose();
        const xs: number[] = [];
        for (let s = 0; s <= 400; s++) xs.push(sampleClip(c, (d * s) / 400, out)[Ch.HeadRot]!);
        return monotoneWithin(xs, up, Math.fround(Math.min(...vs)), Math.fround(Math.max(...vs)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('sampleClip: validation 3, t is clamped to [0, duration]', () => {
  // Keys outside [0, d] make the clamp observable: unclamped, the track would keep moving.
  const c = oneTrack(
    [
      { t: -1, v: -1 },
      { t: 2, v: 3 },
    ],
    1,
  );
  const at0 = sampleAt(c, 0);
  const atD = sampleAt(c, 1);

  it('samples 1/3 at 0 and 5/3 at the duration', () => {
    expect(at0).toBeCloseTo(1 / 3, 6);
    expect(atD).toBeCloseTo(5 / 3, 6);
  });

  it.each([-1e-9, -0.5, -1e9, -Infinity])('t = %s samples as t = 0', (t) => {
    expect(sampleAt(c, t)).toBe(at0);
  });

  it.each([1 + 1e-9, 1.5, 1e9, Infinity])('t = %s samples as t = duration', (t) => {
    expect(sampleAt(c, t)).toBe(atD);
  });

  it('NaN samples as t = 0', () => {
    expect(sampleAt(c, Number.NaN)).toBe(at0);
  });
});

describe('sampleClip: validation 4, channels not in the clip are 0', () => {
  it('zeroes every other channel of out, writes the track channels and returns out', () => {
    const c: Clip = {
      name: 'two',
      duration: 1,
      tracks: [
        {
          ch: Ch.BrowL,
          keys: [
            { t: 0, v: 2 },
            { t: 1, v: 6 },
          ],
        },
        {
          ch: Ch.ArmRotR,
          keys: [
            { t: 0, v: 0, ease: 'in' },
            { t: 1, v: -0.5 },
          ],
        },
      ],
    };
    const out = createPose().fill(7);
    expect(sampleClip(c, 0.5, out)).toBe(out);
    for (let i = 0; i < CH_COUNT; i++) {
      if (i === Ch.BrowL) expect(out[i]).toBe(4);
      else if (i === Ch.ArmRotR) expect(out[i]).toBe(-0.125);
      else expect(out[i], `channel ${i}`).toBe(0);
    }
  });

  it('a clip without tracks zeroes out, and a track without keys writes 0', () => {
    const out = createPose().fill(7);
    sampleClip({ name: 'empty', duration: 1, tracks: [] }, 0.5, out);
    expect(Array.from(out)).toEqual(Array.from(createPose()));
    out.fill(7);
    sampleClip({ name: 'nokeys', duration: 1, tracks: [{ ch: Ch.Stars, keys: [] }] }, 0.5, out);
    expect(Array.from(out)).toEqual(Array.from(createPose()));
  });
});

describe('sampleClip: validation 5, no allocation (10 000 samples, heap growth < 1 MB)', () => {
  /** Four tracks, one per ease; the last key of each has the default ease. */
  const clip: Clip = {
    name: 'alloc',
    duration: 2,
    tracks: (['linear', 'inOut', 'in', 'out'] as const).map((e, i) => ({
      ch: i * 3,
      keys: [
        { t: 0, v: 0, ease: e },
        { t: 0.7, v: 1, ease: e },
        { t: 1.4, v: -1, ease: e },
        { t: 2, v: 0 },
      ],
    })),
  };
  const SAMPLES = 10_000;
  /** Sample times sweeping [−0.1, duration + 0.1], so both clamps are exercised too. */
  const tAt = (i: number): number => -0.1 + (2.2 * i) / (SAMPLES - 1);

  it('makes no array or typed-array allocation over 10 000 samples, and always returns out', () => {
    const out = createPose();
    const buffer = out.buffer;
    let allOut = true;
    const allocations = countAllocations(() => {
      for (let i = 0; i < SAMPLES; i++) {
        if (sampleClip(clip, tAt(i), out) !== out) allOut = false;
      }
    });
    expect(allocations).toBe(0);
    expect(allOut).toBe(true);
    expect(out.buffer).toBe(buffer);
  });

  it('grows the heap by < 1 MB over 10 000 samples (after warm-up)', () => {
    const out = createPose();
    const run = (): void => {
      for (let i = 0; i < SAMPLES; i++) sampleClip(clip, tAt(i), out);
    };
    // Warm up until the optimising compiler has taken over; before that the sampler boxes doubles.
    for (let w = 0; w < 10; w++) run();
    expect(heapGrowth(run)).toBeLessThan(1_048_576);
  });

  it('both meters have teeth (positive controls)', () => {
    expect(countAllocations(() => void new Float32Array(CH_COUNT))).toBe(1);
    expect(countAllocations(() => void Array.from({ length: 3 }))).toBeGreaterThan(0);
    const kept: number[][] = [];
    const growth = heapGrowth(() => {
      for (let i = 0; i < SAMPLES; i++) kept.push(Array.from({ length: 64 }, (_, j) => j + 0.5));
    });
    expect(kept).toHaveLength(SAMPLES);
    expect(growth).toBeGreaterThanOrEqual(1_048_576);
  });
});

describe('BASE: the base-state poses', () => {
  const NAMES: readonly BaseName[] = ['asleep', 'idle', 'attentive', 'thinking', 'talking', 'dozing'];
  /**
   * The issue's table: [channel, value, radians?]. Radians are the issue's 4-decimal values and match
   * within 1e-4; every other value matches exactly (as float32).
   */
  const EXPECTED: Record<BaseName, readonly (readonly [ch: number, v: number, rad: boolean])[]> = {
    attentive: [
      [Ch.HeadTilt, 0.1396, true],
      [Ch.EarRotL, -0.1745, true],
      [Ch.EarRotR, -0.1745, true],
      [Ch.BrowL, 6, false],
      [Ch.BrowR, 6, false],
      [Ch.BodyLean, 0.0524, true],
    ],
    asleep: [
      [Ch.LidL, 1, false],
      [Ch.LidR, 1, false],
      [Ch.HeadTilt, -0.1047, true],
      [Ch.BodySquash, -0.02, false],
      [Ch.EarFoldL, 0.3, false],
      [Ch.EarFoldR, 0.3, false],
    ],
    dozing: [
      [Ch.LidL, 0.6, false],
      [Ch.LidR, 0.6, false],
      [Ch.HeadTilt, -0.0524, true],
    ],
    thinking: [
      [Ch.IrisY, -6, false],
      [Ch.IrisX, 4, false],
      [Ch.BrowL, 4, false],
      [Ch.HeadRot, 0.0698, true],
    ],
    idle: [],
    talking: [],
  };

  it('has exactly the six director base states', () => {
    expect(Object.keys(BASE).toSorted()).toEqual(NAMES.toSorted());
  });

  it('gives every state its own Float32Array of CH_COUNT channels', () => {
    for (const name of NAMES) {
      expect(BASE[name], name).toBeInstanceOf(Float32Array);
      expect(BASE[name], name).toHaveLength(CH_COUNT);
    }
    expect(new Set(NAMES.map((name) => BASE[name].buffer)).size).toBe(NAMES.length);
  });

  it.each(NAMES)('%s has the issue table values and 0 on every other channel', (name) => {
    const p = BASE[name];
    const listed = new Map(EXPECTED[name].map(([ch, v, rad]) => [ch, { v, rad }]));
    for (let ch = 0; ch < CH_COUNT; ch++) {
      const e = listed.get(ch);
      if (e === undefined) expect(p[ch], `${name} channel ${ch}`).toBe(0);
      else if (e.rad) expect(Math.abs(p[ch]! - e.v), `${name} channel ${ch}`).toBeLessThanOrEqual(1e-4);
      else expect(p[ch], `${name} channel ${ch}`).toBe(Math.fround(e.v));
    }
  });

  it('idle and talking are neutral', () => {
    expect(Array.from(BASE.idle)).toEqual(Array.from(createPose()));
    expect(Array.from(BASE.talking)).toEqual(Array.from(createPose()));
  });

  it('no base pose writes a mouth channel', () => {
    for (const name of NAMES) for (const ch of MOUTH) expect(BASE[name][ch], `${name} channel ${ch}`).toBe(0);
  });

  it('the radians are the issue degrees converted exactly (8°, −10°, 3°, −6°, −3°, 4°)', () => {
    expect(BASE.attentive[Ch.HeadTilt]).toBe(Math.fround(8 * DEG));
    expect(BASE.attentive[Ch.EarRotL]).toBe(Math.fround(-10 * DEG));
    expect(BASE.attentive[Ch.BodyLean]).toBe(Math.fround(3 * DEG));
    expect(BASE.asleep[Ch.HeadTilt]).toBe(Math.fround(-6 * DEG));
    expect(BASE.dozing[Ch.HeadTilt]).toBe(Math.fround(-3 * DEG));
    expect(BASE.thinking[Ch.HeadRot]).toBe(Math.fround(4 * DEG));
  });
});
