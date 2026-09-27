import { GCProfiler, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mulberry32 as referenceMulberry32 } from '../../../test/dsp-helpers.ts';
import { Ch, CH_COUNT, createPose } from '../pose.ts';
import type { Pose } from '../pose.ts';
import { exponential, mulberry32, uniform } from '../rng.ts';
import { SpringBank } from '../springs.ts';
import { SUBSTEP } from '../stepper.ts';
import {
  BELLY_PHASE,
  BLINK_CLOSE,
  BLINK_DOUBLE_GAP,
  BLINK_DOUBLE_RATIO,
  BLINK_HOLD,
  BLINK_MEAN_INTERVAL,
  BLINK_OPEN,
  BREATH_AMP,
  BREATH_HZ,
  EAR_SPRING,
  EAR_TWITCH_DV,
  EAR_TWITCH_MAX,
  EAR_TWITCH_MIN,
  EYES_CENTER,
  GAZE_MAX,
  GAZE_SPRING,
  HEAD_FOLLOW,
  HEAD_FULL_ANGLE,
  LOOK_SATURATE,
  MOOD_BLUSH,
  MOOD_BROW,
  MOOD_TAU,
  SACCADE_MAX,
  SACCADE_MIN,
  createBlink,
  createBreathing,
  createEarTwitch,
  createGaze,
  createMood,
} from './index.ts';
import type { AnimContext, Layer, LayerWeights, LookAt, MoodLayer } from './index.ts';

/** The issue's simulation step (#78 Validation): dt = 1/60 s. */
const DT = 1 / 60;

/**
 * The seed of the single-seed statistical tests ("T67"); fixed, so each run replays the same draws. It is
 * central, not lucky: 3.5066 s and 15.47 % doubles, where 171 of seeds 1–200 pass the issue's ±0.1 s mean
 * check (the tolerance is ≈ 1.5 standard errors); the 100-seed pooled test below doesn't depend on it.
 */
const SEED = 0x7467;

const TAU = 2 * Math.PI;

/**
 * SpringBank indices of this test's own bank: deliberately scattered, with unused springs 2 and 5, so a layer
 * that ignores its options (or hard-codes an index) is caught.
 */
const IDX = { headRot: 3, headTilt: 1, earL: 4, earR: 0 } as const;
const BANK_SIZE = 6;

function makeBank(): SpringBank {
  const bank = new SpringBank(BANK_SIZE);
  bank.set(IDX.headRot, GAZE_SPRING.freqHz, GAZE_SPRING.zeta);
  bank.set(IDX.headTilt, GAZE_SPRING.freqHz, GAZE_SPRING.zeta);
  bank.set(IDX.earL, EAR_SPRING.freqHz, EAR_SPRING.zeta);
  bank.set(IDX.earR, EAR_SPRING.freqHz, EAR_SPRING.zeta);
  return bank;
}

const FULL: LayerWeights = { blink: 1, breathing: 1, gaze: 1, ears: 1 };

function makeCtx(seed = SEED, weights: LayerWeights = { ...FULL }): AnimContext {
  return { rng: mulberry32(seed), weights, lookAt: null, springs: makeBank() };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

function diffs(xs: readonly number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!);
}

/**
 * Steps one layer the way the app's loop does (#81: `springs.step(dt)`, then the layers), `steps` times at
 * `DT`, on a cleared pose. After each step, `each(stepIndex, timeAtEndOfStep, pose)` observes it.
 */
function run(
  layer: Layer,
  ctx: AnimContext,
  steps: number,
  each: (i: number, t: number, pose: Pose) => void,
  pose: Pose = createPose(),
): void {
  for (let i = 0; i < steps; i++) {
    ctx.springs.step(DT);
    pose.fill(0);
    layer.update(DT, pose, ctx);
    each(i, (i + 1) * DT, pose);
  }
}

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

describe('rng', () => {
  it.each([0, 1, SEED, 2 ** 32 - 1, -1, 2 ** 40 + 3])(
    'mulberry32(%s) matches the reference implementation in test/dsp-helpers.ts',
    (seed) => {
      const a = mulberry32(seed);
      const b = referenceMulberry32(seed);
      for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
    },
  );

  it('mulberry32 stays in [0, 1), repeats per seed and differs across seeds', () => {
    const a = mulberry32(SEED);
    const b = mulberry32(SEED);
    const c = mulberry32(SEED + 1);
    let outside = 0;
    let differ = 0;
    let same = 0;
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = a();
      if (!(x >= 0 && x < 1)) outside++;
      if (b() !== x) differ++;
      if (c() === x) same++;
      sum += x;
    }
    expect(outside).toBe(0);
    expect(differ).toBe(0);
    expect(same).toBeLessThan(5);
    expect(Math.abs(sum / 100_000 - 0.5)).toBeLessThan(0.005);
  });

  it('uniform(rng, lo, hi) is lo + (hi − lo)·rng(), on [lo, hi) with mean (lo + hi)/2', () => {
    expect(uniform(() => 0, 1.5, 4)).toBe(1.5);
    expect(uniform(() => 0.5, 1.5, 4)).toBe(2.75);
    const rng = mulberry32(SEED);
    const xs = Array.from({ length: 100_000 }, () => uniform(rng, 6, 15));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...xs)).toBeLessThan(15);
    expect(Math.abs(mean(xs) - 10.5)).toBeLessThan(0.05);
  });

  it('exponential(rng, mean) is finite and ≥ 0, with the given mean and P(x < mean) = 1 − 1/e', () => {
    expect(exponential(() => 0, 3.5)).toBe(0);
    const last = exponential(() => 1 - 2 ** -32, 3.5);
    expect(last).toBeCloseTo(3.5 * 32 * Math.LN2, 9);
    const rng = mulberry32(SEED);
    const xs = Array.from({ length: 100_000 }, () => exponential(rng, 3.5));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(mean(xs) / 3.5 - 1)).toBeLessThan(0.02);
    expect(Math.abs(sampleStd(xs) / 3.5 - 1)).toBeLessThan(0.03);
    expect(Math.abs(xs.filter((x) => x < 3.5).length / xs.length - (1 - 1 / Math.E))).toBeLessThan(0.01);
  });
});

/** The lid of one blink `p` seconds after its onset, from the spec's numbers: close 60, hold 40, open 80 ms. */
function specSingleLid(p: number): number {
  if (p < 0 || p >= 0.18) return 0;
  if (p < 0.06) return p / 0.06;
  if (p < 0.1) return 1;
  return 1 - (p - 0.1) / 0.08;
}

/** The lid of a blink event `p` seconds after its onset: a double repeats the blink after `BLINK_DOUBLE_GAP`. */
function specLid(p: number, double: boolean): number {
  const second = 0.18 + BLINK_DOUBLE_GAP;
  return double && p >= second ? specSingleLid(p - second) : specSingleLid(p);
}

interface BlinkEvent {
  /** Exact onset time (seconds from the start of the run). */
  onset: number;
  double: boolean;
  /** Index of the step in which it started. */
  step: number;
}

/** Runs a blink layer for `steps` steps and returns its events and the per-step `LidL`/`LidR` values. */
function runBlink(
  seed: number,
  steps: number,
  weight = 1,
): { events: BlinkEvent[]; lidL: Float64Array; lidR: Float64Array; skipped: number } {
  const layer = createBlink();
  const ctx = makeCtx(seed, { ...FULL, blink: weight });
  const events: BlinkEvent[] = [];
  const lidL = new Float64Array(steps);
  const lidR = new Float64Array(steps);
  let count = 0;
  let doubles = 0;
  /** Steps in which `count` rose by more than one (events the test couldn't see). */
  let skipped = 0;
  run(layer, ctx, steps, (i, t, pose) => {
    lidL[i] = pose[Ch.LidL]!;
    lidR[i] = pose[Ch.LidR]!;
    if (layer.count !== count) {
      if (layer.count !== count + 1) skipped++;
      const double = layer.doubles !== doubles;
      events.push({ onset: t - layer.sinceOnset, double, step: i });
      count = layer.count;
      doubles = layer.doubles;
    }
  });
  return { events, lidL, lidR, skipped };
}

/**
 * A lean 10 000 s blink run at `DT` (no lid arrays): the span from the first to the last onset, the number
 * of events and of doubles.
 */
function blinkStats(seed: number): { span: number; n: number; doubles: number } {
  const layer = createBlink();
  const ctx: AnimContext = { rng: mulberry32(seed), weights: FULL, lookAt: null, springs: new SpringBank(0) };
  const pose = createPose();
  let count = 0;
  let first = 0;
  let last = 0;
  for (let i = 0; i < 600_000; i++) {
    pose.fill(0);
    layer.update(DT, pose, ctx);
    if (layer.count !== count) {
      count = layer.count;
      last = (i + 1) * DT - layer.sinceOnset;
      if (count === 1) first = last;
    }
  }
  return { span: last - first, n: count, doubles: layer.doubles };
}

describe('blink', () => {
  it('uses the spec constants: mean 3.5 s, 15 % doubles, 60/40/80 ms close/hold/open', () => {
    expect(BLINK_MEAN_INTERVAL).toBe(3.5);
    expect(BLINK_DOUBLE_RATIO).toBe(0.15);
    expect(BLINK_CLOSE).toBe(0.06);
    expect(BLINK_HOLD).toBe(0.04);
    expect(BLINK_OPEN).toBe(0.08);
    expect(BLINK_DOUBLE_GAP).toBe(0.08);
  });

  describe('over 10 000 s at dt = 1/60 (seed 0x7467)', () => {
    const { events, lidL, lidR, skipped } = runBlink(SEED, 600_000);
    const intervals = diffs(events.map((e) => e.onset));

    it('has a mean interval of 3.5 s ± 0.1, exponentially distributed', () => {
      expect(skipped).toBe(0);
      expect(events.length).toBeGreaterThan(2500);
      expect(Math.abs(mean(intervals) - 3.5)).toBeLessThanOrEqual(0.1);
      // An exponential has std = mean (CV 1) and P(x < mean) = 1 − 1/e ≈ 0.632: fixed or uniform intervals fail.
      expect(Math.abs(sampleStd(intervals) / mean(intervals) - 1)).toBeLessThanOrEqual(0.1);
      expect(
        Math.abs(intervals.filter((x) => x < 3.5).length / intervals.length - 0.632),
      ).toBeLessThanOrEqual(0.03);
    });

    it('makes 15 % ± 1.5 of the blinks doubles', () => {
      const ratio = events.filter((e) => e.double).length / events.length;
      expect(Math.abs(ratio - 0.15)).toBeLessThanOrEqual(0.015);
    });

    it('never starts an event before the previous one has ended', () => {
      for (let j = 1; j < events.length; j++) {
        const prev = events[j - 1]!;
        expect(events[j]!.onset - prev.onset).toBeGreaterThanOrEqual((prev.double ? 0.44 : 0.18) - 1e-9);
      }
    });

    it('drives LidL and LidR together, and closes the lids once per blink and twice per double', () => {
      let closures = 0;
      let wasShut = false;
      let apart = 0;
      for (let i = 0; i < lidL.length; i++) {
        if (lidR[i] !== lidL[i]) apart++;
        const shut = lidL[i]! >= 1 - 1e-6;
        if (shut && !wasShut) closures++;
        wasShut = shut;
      }
      expect(apart).toBe(0);
      expect(closures).toBe(events.length + events.filter((e) => e.double).length);
    });

    it('follows the 60/40/80 ms trajectory at every step, for singles and doubles', () => {
      let checked = 0;
      let maxErr = 0;
      for (let j = 0; j < events.length - 1; j++) {
        const e = events[j]!;
        for (let i = e.step; i < events[j + 1]!.step; i++) {
          const p = (i + 1) * DT - e.onset;
          maxErr = Math.max(maxErr, Math.abs(lidL[i]! - specLid(p, e.double)));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(590_000);
      expect(maxErr).toBeLessThanOrEqual(1e-6);
    });
  });

  it('shuts a single blink within 60 ms ± one step, and reopens it by 180 ms', () => {
    const { events, lidL } = runBlink(SEED, 6000);
    const e = events.find((ev) => !ev.double)!;
    const phase = (i: number): number => (i + 1) * DT - e.onset;
    let i = e.step;
    while (lidL[i]! < 1 - 1e-6) i++;
    expect(Math.abs(phase(i) - 0.06)).toBeLessThanOrEqual(DT);
    for (let k = e.step; k < i; k++) expect(lidL[k]).toBeGreaterThan(0);
    while (phase(i) < 0.18) {
      expect(lidL[i]).toBeGreaterThan(0);
      i++;
    }
    expect(phase(i) - 0.18).toBeLessThan(DT);
    expect(lidL[i]).toBeLessThanOrEqual(1e-6);
  });

  it('shuts a double twice: at 60 ms and at 0.18 + gap + 0.06 s, each ± one step, open from 0.44 s', () => {
    const { events, lidL } = runBlink(SEED, 60_000);
    const e = events.find((ev) => ev.double)!;
    const phase = (i: number): number => (i + 1) * DT - e.onset;
    const shutAt: number[] = [];
    let wasShut = false;
    let i = e.step;
    for (; phase(i) < 0.44; i++) {
      const shut = lidL[i]! >= 1 - 1e-6;
      if (shut && !wasShut) shutAt.push(phase(i));
      wasShut = shut;
    }
    expect(shutAt).toHaveLength(2);
    expect(Math.abs(shutAt[0]! - 0.06)).toBeLessThanOrEqual(DT);
    expect(Math.abs(shutAt[1]! - (0.18 + BLINK_DOUBLE_GAP + 0.06))).toBeLessThanOrEqual(DT);
    expect(lidL[i]).toBeLessThanOrEqual(1e-6);
  });

  it('keeps its statistics over seeds 1–100 × 10 000 s: pooled mean 3.5 s ± 0.03, doubles 15 % ± 0.5, and ≥ 70 % of the seeds pass the single-run checks', () => {
    let span = 0;
    let intervals = 0;
    let n = 0;
    let doubles = 0;
    let pass = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const r = blinkStats(seed);
      span += r.span;
      intervals += r.n - 1;
      n += r.n;
      doubles += r.doubles;
      if (Math.abs(r.span / (r.n - 1) - 3.5) <= 0.1 && Math.abs(r.doubles / r.n - 0.15) <= 0.015) pass++;
    }
    // Pooled standard errors ≈ 0.0066 s and 0.0007; the no-overlap floor adds ≈ +0.007 s to the mean.
    expect(Math.abs(span / intervals - 3.5)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(doubles / n - 0.15)).toBeLessThanOrEqual(0.005);
    // About 83 % of seeds pass both of the issue's single-run tolerances.
    expect(pass).toBeGreaterThanOrEqual(70);
  });
});

/** Direct DFT bin k of x: Σ x[n]·e^(−i·2π·k·n/N), as [re, im]. */
function dft(x: Float64Array, k: number): [number, number] {
  let re = 0;
  let im = 0;
  for (let n = 0; n < x.length; n++) {
    const a = (TAU * ((k * n) % x.length)) / x.length;
    re += x[n]! * Math.cos(a);
    im -= x[n]! * Math.sin(a);
  }
  return [re, im];
}

/** The bin in 1 … N/2 with the largest magnitude. */
function dominantBin(x: Float64Array): number {
  let best = 0;
  let bestMag = -1;
  for (let k = 1; k <= x.length / 2; k++) {
    const [re, im] = dft(x, k);
    const mag = Math.hypot(re, im);
    if (mag > bestMag) {
      bestMag = mag;
      best = k;
    }
  }
  return best;
}

describe('breathing', () => {
  it('uses the spec constants: 0.012 at 0.25 Hz, belly 0.2 cycles ahead', () => {
    expect(BREATH_AMP).toBe(0.012);
    expect(BREATH_HZ).toBe(0.25);
    expect(BELLY_PHASE).toBe(0.2);
  });

  /** 80 s at dt = 1/60: exactly 20 breaths, so 0.25 Hz falls on DFT bin 20 of N = 4800. */
  const N = 4800;
  const body = new Float64Array(N);
  const belly = new Float64Array(N);
  run(createBreathing(), makeCtx(), N, (i, _t, pose) => {
    body[i] = pose[Ch.BodySquash]!;
    belly[i] = pose[Ch.BellyJiggle]!;
  });

  it('makes 0.25 Hz the dominant frequency of BodySquash and BellyJiggle (direct DFT)', () => {
    expect(dominantBin(body) / (N * DT)).toBe(0.25);
    expect(dominantBin(belly) / (N * DT)).toBe(0.25);
  });

  it('has an amplitude of 0.012 ± 0.0005 (DFT and peak)', () => {
    for (const x of [body, belly]) {
      const [re, im] = dft(x, 20);
      expect(Math.abs((2 * Math.hypot(re, im)) / N - 0.012)).toBeLessThanOrEqual(0.0005);
      const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(Math.abs(peak - 0.012)).toBeLessThanOrEqual(0.0005);
    }
  });

  it('puts the belly 0.2 cycles ahead of the body', () => {
    const [br, bi] = dft(body, 20);
    const [lr, li] = dft(belly, 20);
    // arg(belly / body) = arg(belly · conj(body))
    const lead = Math.atan2(li * br - lr * bi, lr * br + li * bi);
    expect(Math.abs(lead - 0.2 * TAU)).toBeLessThanOrEqual(0.01);
  });

  it('follows 0.012·sin(2π·0.25·t) and 0.012·sin(2π·0.25·t + 0.2·2π) at every step', () => {
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      const t = (i + 1) * DT;
      maxErr = Math.max(
        maxErr,
        Math.abs(body[i]! - 0.012 * Math.sin(TAU * 0.25 * t)),
        Math.abs(belly[i]! - 0.012 * Math.sin(TAU * 0.25 * t + 0.2 * TAU)),
      );
    }
    expect(maxErr).toBeLessThanOrEqual(1e-7);
  });
});

/** The settled head-follow value the spec asks for: 0.3·(iris/10)·0.12 rad. */
function followOf(iris: number): number {
  return 0.3 * (iris / 10) * 0.12;
}

/** Gaze held still on `lookAt` for 5 s. */
function settle(lookAt: LookAt): { pose: Pose; layer: ReturnType<typeof createGaze> } {
  const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
  const ctx = makeCtx();
  ctx.lookAt = lookAt;
  const pose = createPose();
  run(layer, ctx, 300, () => undefined, pose);
  return { pose, layer };
}

describe('gaze', () => {
  it('uses the spec constants: iris ≤ 10, follow 30 % of 0.12 rad through f = 2 Hz, ζ = 0.8, saccades U(1.5, 4)', () => {
    expect(GAZE_SPRING).toEqual({ freqHz: 2, zeta: 0.8 });
    expect(GAZE_MAX).toBe(10);
    expect(HEAD_FOLLOW).toBe(0.3);
    expect(HEAD_FULL_ANGLE).toBe(0.12);
    expect(SACCADE_MIN).toBe(1.5);
    expect(SACCADE_MAX).toBe(4);
  });

  describe('random saccades over 10 000 s at dt = 1/60 (seed 0x7467)', () => {
    const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
    const ctx = makeCtx();
    // The bank's owner configures and steps it (#81): the layer must never call set or step.
    const setSpy = vi.spyOn(ctx.springs, 'set');
    const stepSpy = vi.spyOn(ctx.springs, 'step');
    const onsets: number[] = [];
    const moveSteps: number[] = [];
    /** |iris| settled on each random target (read on the step before the next saccade). */
    const radii: number[] = [];
    let count = 0;
    let skipped = 0;
    let maxIris = 0;
    let maxPoseIris = 0;
    let lastX = 0;
    let lastY = 0;
    let quietSince = 0;
    /** Head-follow ratios on the step before each saccade (1.5 s or more after the previous one). */
    const ratios: number[] = [];
    let prevHead: [number, number, number, number] = [0, 0, 0, 0];
    run(layer, ctx, 600_000, (i, t, pose) => {
      if (layer.count !== count) {
        if (layer.count !== count + 1) skipped++;
        count = layer.count;
        onsets.push(t - layer.sinceSaccade);
        const [rot, tilt, ix, iy] = prevHead;
        if (Math.abs(ix) >= 1) ratios.push(rot / ((ix / 10) * 0.12));
        if (Math.abs(iy) >= 1) ratios.push(tilt / ((iy / 10) * 0.12));
        if (count >= 2) radii.push(Math.hypot(ix, iy));
      }
      const x = pose[Ch.IrisX]!;
      const y = pose[Ch.IrisY]!;
      maxIris = Math.max(maxIris, Math.hypot(layer.irisX, layer.irisY));
      maxPoseIris = Math.max(maxPoseIris, Math.hypot(x, y));
      // A realised saccade: the iris starts moving after a quiet half second.
      const moving = Math.abs(x - lastX) + Math.abs(y - lastY) > 1e-3;
      if (moving && t - quietSince >= 0.5) moveSteps.push(t);
      if (moving) quietSince = t;
      lastX = x;
      lastY = y;
      prevHead = [pose[Ch.HeadRot]!, pose[Ch.HeadTilt]!, x, y];
    });
    const setCalls = setSpy.mock.calls.length;
    const stepCalls = stepSpy.mock.calls.length;
    setSpy.mockRestore();
    stepSpy.mockRestore();
    const intervals = diffs(onsets);

    it('never configures or steps the bank itself', () => {
      expect(setCalls).toBe(0);
      expect(stepCalls).toBe(600_000);
    });

    it('schedules saccades U(1.5, 4) s apart', () => {
      expect(skipped).toBe(0);
      expect(onsets.length).toBeGreaterThan(3000);
      expect(Math.min(...intervals)).toBeGreaterThanOrEqual(1.5 - 1e-9);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(4 + 1e-9);
      // Uniform: spans the range, mean 2.75.
      expect(Math.min(...intervals)).toBeLessThan(1.55);
      expect(Math.max(...intervals)).toBeGreaterThan(3.95);
      expect(Math.abs(mean(intervals) - 2.75)).toBeLessThanOrEqual(0.05);
    });

    it('moves the iris in the pose exactly once per saccade, [1.5, 4] s apart within one step', () => {
      expect(moveSteps).toHaveLength(onsets.length);
      for (const d of diffs(moveSteps)) {
        expect(d).toBeGreaterThanOrEqual(1.5 - DT - 1e-9);
        expect(d).toBeLessThanOrEqual(4 + DT + 1e-9);
      }
    });

    it('keeps |iris| ≤ 10 and uses the whole range', () => {
      expect(maxIris).toBeLessThanOrEqual(10);
      expect(maxPoseIris).toBeLessThanOrEqual(10 + 1e-5);
      expect(maxIris).toBeGreaterThan(9.9);
    });

    it('spreads the saccade targets uniformly over the disc: half of them within 10/√2', () => {
      expect(radii.length).toBeGreaterThan(3000);
      expect(Math.max(...radii)).toBeLessThanOrEqual(10 + 1e-5);
      const inner = radii.filter((r) => r < 10 / Math.SQRT2).length / radii.length;
      expect(Math.abs(inner - 0.5)).toBeLessThanOrEqual(0.03);
    });

    it('has the head settled at 30 % ± 3 % of the follow angle before each saccade', () => {
      expect(ratios.length).toBeGreaterThan(3000);
      for (const r of ratios) {
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      }
    });

    it('touches only its two springs, and only their targets', () => {
      for (let s = 0; s < BANK_SIZE; s++) {
        if (s === IDX.headRot || s === IDX.headTilt) continue;
        expect([ctx.springs.target[s], ctx.springs.pos[s], ctx.springs.vel[s]]).toEqual([0, 0, 0]);
      }
      expect(ctx.springs.target[IDX.headRot]).toBeCloseTo(followOf(layer.irisX), 7);
      expect(ctx.springs.target[IDX.headTilt]).toBeCloseTo(followOf(layer.irisY), 7);
    });
  });

  it.each<{ name: string; lookAt: LookAt; ux: number; uy: number }>([
    { name: 'far right', lookAt: { x: 1500, y: 385 }, ux: 1, uy: 0 },
    { name: 'far left', lookAt: { x: -500, y: 385 }, ux: -1, uy: 0 },
    { name: 'far down', lookAt: { x: 500, y: 1385 }, ux: 0, uy: 1 },
    { name: 'far up', lookAt: { x: 500, y: -615 }, ux: 0, uy: -1 },
    { name: 'up and right', lookAt: { x: 800, y: -15 }, ux: 0.6, uy: -0.8 },
  ])(
    'with lookAt $name, turns the iris fully toward it and settles the head at 0.3 ± 0.03 of the follow',
    ({ lookAt, ux, uy }) => {
      const { pose, layer } = settle(lookAt);
      const x = pose[Ch.IrisX]!;
      const y = pose[Ch.IrisY]!;
      expect(x).toBeCloseTo(10 * ux, 4);
      expect(y).toBeCloseTo(10 * uy, 4);
      expect(Math.hypot(layer.irisX, layer.irisY)).toBeLessThanOrEqual(10);
      if (ux !== 0) {
        const r = pose[Ch.HeadRot]! / ((x / 10) * 0.12);
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      } else {
        expect(Math.abs(pose[Ch.HeadRot]!)).toBeLessThan(1e-6);
      }
      if (uy !== 0) {
        const r = pose[Ch.HeadTilt]! / ((y / 10) * 0.12);
        expect(r).toBeGreaterThanOrEqual(0.27);
        expect(r).toBeLessThanOrEqual(0.33);
      } else {
        expect(Math.abs(pose[Ch.HeadTilt]!)).toBeLessThan(1e-6);
      }
      // Signs: rotations are clockwise-positive on screen, y down.
      expect(Math.sign(pose[Ch.HeadRot]!)).toBe(Math.sign(Math.round(ux * 10)));
      expect(Math.sign(pose[Ch.HeadTilt]!)).toBe(Math.sign(Math.round(uy * 10)));
    },
  );

  it('scales the iris with the distance inside LOOK_SATURATE, and looks straight at the eyes centre', () => {
    const near = settle({ x: EYES_CENTER.x + 0.3 * LOOK_SATURATE, y: EYES_CENTER.y + 0.4 * LOOK_SATURATE });
    expect(near.pose[Ch.IrisX]).toBeCloseTo(0.3 * 10, 4);
    expect(near.pose[Ch.IrisY]).toBeCloseTo(0.4 * 10, 4);
    const centre = settle({ x: EYES_CENTER.x, y: EYES_CENTER.y });
    expect(centre.pose[Ch.IrisX]).toBe(0);
    expect(centre.pose[Ch.IrisY]).toBe(0);
    expect(centre.pose[Ch.HeadRot]).toBe(0);
  });

  it('rejects bad spring indices', () => {
    expect(() => createGaze({ headRot: -1, headTilt: 0 })).toThrow(RangeError);
    expect(() => createGaze({ headRot: 0, headTilt: 1.5 })).toThrow(RangeError);
    const layer = createGaze({ headRot: 0, headTilt: BANK_SIZE });
    expect(() => layer.update(DT, createPose(), makeCtx())).toThrow(RangeError);
  });
});

describe('ear twitch', () => {
  it('uses the spec constants: one twitch per U(6, 15) s through f = 6 Hz, ζ = 0.35 springs', () => {
    expect(EAR_SPRING).toEqual({ freqHz: 6, zeta: 0.35 });
    expect(EAR_TWITCH_MIN).toBe(6);
    expect(EAR_TWITCH_MAX).toBe(15);
  });

  it('flicks an ear from rest to 12° ± 0.5 (the #77 earTwitch swing) with EAR_TWITCH_DV at SUBSTEP', () => {
    const bank = new SpringBank(1);
    bank.set(0, EAR_SPRING.freqHz, EAR_SPRING.zeta);
    bank.impulse(0, EAR_TWITCH_DV);
    let peak = 0;
    for (let i = 0; i < 0.3 / SUBSTEP; i++) {
      bank.step(SUBSTEP);
      peak = Math.max(peak, bank.pos[0]!);
    }
    expect(Math.abs(peak * (180 / Math.PI) - 12)).toBeLessThanOrEqual(0.5);
  });

  describe('over 10 000 s at dt = 1/60 (seed 0x7467)', () => {
    const layer = createEarTwitch({ earL: IDX.earL, earR: IDX.earR });
    const ctx = makeCtx();
    const { springs } = ctx;
    const setSpy = vi.spyOn(springs, 'set');
    const stepSpy = vi.spyOn(springs, 'step');
    const onsets: number[] = [];
    /** Every step in which an ear spring's velocity jumped: its time and the two jumps. */
    const kicks: { t: number; right: boolean; dL: number; dR: number }[] = [];
    let count = 0;
    let skipped = 0;
    let poseMatches = true;
    /** Sign of the first swing after each kick: +1 clockwise, −1 counter-clockwise. */
    const firstSwing: { right: boolean; sign: number }[] = [];
    const pose = createPose();
    for (let i = 0; i < 600_000; i++) {
      const t = (i + 1) * DT;
      springs.step(DT);
      const vL = springs.vel[IDX.earL]!;
      const vR = springs.vel[IDX.earR]!;
      pose.fill(0);
      layer.update(DT, pose, ctx);
      const dL = springs.vel[IDX.earL]! - vL;
      const dR = springs.vel[IDX.earR]! - vR;
      if (dL !== 0 || dR !== 0) kicks.push({ t, right: dR !== 0, dL, dR });
      if (layer.count !== count) {
        if (layer.count !== count + 1) skipped++;
        count = layer.count;
        onsets.push(t - layer.sinceTwitch);
      }
      if (pose[Ch.EarRotL] !== springs.pos[IDX.earL] || pose[Ch.EarRotR] !== springs.pos[IDX.earR]) {
        poseMatches = false;
      }
      const last = kicks.at(-1);
      if (last !== undefined && firstSwing.length < kicks.length && t - last.t >= 0.05) {
        firstSwing.push({ right: last.right, sign: Math.sign(pose[last.right ? Ch.EarRotR : Ch.EarRotL]!) });
      }
    }
    const setCalls = setSpy.mock.calls.length;
    const stepCalls = stepSpy.mock.calls.length;
    setSpy.mockRestore();
    stepSpy.mockRestore();
    const intervals = diffs(onsets);

    it('never configures or steps the bank itself', () => {
      expect(setCalls).toBe(0);
      expect(stepCalls).toBe(600_000);
    });

    it('schedules twitches U(6, 15) s apart', () => {
      expect(skipped).toBe(0);
      expect(onsets.length).toBeGreaterThan(800);
      expect(Math.min(...intervals)).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(15 + 1e-9);
      expect(Math.min(...intervals)).toBeLessThan(6.2);
      expect(Math.max(...intervals)).toBeGreaterThan(14.8);
      expect(Math.abs(mean(intervals) - 10.5)).toBeLessThanOrEqual(0.3);
    });

    it('kicks exactly one ear spring per twitch, by EAR_TWITCH_DV outward, [6, 15] s apart within one step', () => {
      expect(kicks).toHaveLength(onsets.length);
      for (const k of kicks) {
        expect(k.right ? k.dL : k.dR).toBe(0);
        if (k.right) expect(k.dR).toBeCloseTo(EAR_TWITCH_DV, 4);
        else expect(k.dL).toBeCloseTo(-EAR_TWITCH_DV, 4);
      }
      for (const d of diffs(kicks.map((k) => k.t))) {
        expect(d).toBeGreaterThanOrEqual(6 - DT - 1e-9);
        expect(d).toBeLessThanOrEqual(15 + DT + 1e-9);
      }
      const right = kicks.filter((k) => k.right).length;
      expect(right).toBe(layer.right);
      expect(Math.abs(right / kicks.length - 0.5)).toBeLessThanOrEqual(0.05);
    });

    it('flicks each ear outward: right ear clockwise (+), left ear counter-clockwise (−)', () => {
      expect(firstSwing).toHaveLength(kicks.length);
      for (const s of firstSwing) expect(s.sign).toBe(s.right ? 1 : -1);
    });

    it('adds the springs’ positions to EarRotL/EarRotR, and leaves every other spring alone', () => {
      expect(poseMatches).toBe(true);
      for (let s = 0; s < BANK_SIZE; s++) {
        expect(springs.target[s]).toBe(0);
        if (s !== IDX.earL && s !== IDX.earR) expect([springs.pos[s], springs.vel[s]]).toEqual([0, 0]);
      }
    });
  });

  it('rejects bad spring indices', () => {
    expect(() => createEarTwitch({ earL: -1, earR: 0 })).toThrow(RangeError);
    expect(() => createEarTwitch({ earL: 0, earR: Number.NaN })).toThrow(RangeError);
    const layer = createEarTwitch({ earL: BANK_SIZE, earR: 0 });
    expect(() => layer.update(DT, createPose(), makeCtx())).toThrow(RangeError);
  });
});

describe('mood', () => {
  it('uses the spec constants: τ = 8 s, Blush ×0.3, brows ×(−3)', () => {
    expect(MOOD_TAU).toBe(8);
    expect(MOOD_BLUSH).toBe(0.3);
    expect(MOOD_BROW).toBe(-3);
  });

  it('decays joy and annoy to 1/e in 8 s ± 0.1, in the scalars and in the pose', () => {
    const mood = createMood();
    mood.bump('joy', 1);
    mood.bump('annoy', 1);
    const ctx = makeCtx();
    const crossed = { joy: Number.NaN, annoy: Number.NaN, blush: Number.NaN, brow: Number.NaN };
    run(mood, ctx, 900, (_i, t, pose) => {
      if (Number.isNaN(crossed.joy) && mood.joy <= 1 / Math.E) crossed.joy = t;
      if (Number.isNaN(crossed.annoy) && mood.annoy <= 1 / Math.E) crossed.annoy = t;
      if (Number.isNaN(crossed.blush) && pose[Ch.Blush]! <= 0.3 / Math.E) crossed.blush = t;
      if (Number.isNaN(crossed.brow) && pose[Ch.BrowL]! >= -3 / Math.E) crossed.brow = t;
    });
    for (const t of Object.values(crossed)) expect(Math.abs(t - 8)).toBeLessThanOrEqual(0.1);
  });

  it('adds Blush = 0.3·joy and BrowL = BrowR = −3·annoy, whatever the weights', () => {
    const mood = createMood();
    mood.bump('joy', 0.5);
    mood.bump('annoy', 0.25);
    const ctx = makeCtx(SEED, { blink: 0, breathing: 0, gaze: 0, ears: 0 });
    const pose = createPose();
    pose[Ch.Blush] = 0.1;
    pose[Ch.BrowL] = 2;
    mood.update(DT, pose, ctx);
    const decay = Math.exp(-DT / 8);
    expect(mood.joy).toBeCloseTo(0.5 * decay, 12);
    expect(mood.annoy).toBeCloseTo(0.25 * decay, 12);
    expect(pose[Ch.Blush]).toBeCloseTo(0.1 + 0.3 * 0.5 * decay, 6);
    expect(pose[Ch.BrowL]).toBeCloseTo(2 - 3 * 0.25 * decay, 6);
    expect(pose[Ch.BrowR]).toBeCloseTo(-3 * 0.25 * decay, 6);
    for (let c = 0; c < CH_COUNT; c++) {
      if (c !== Ch.Blush && c !== Ch.BrowL && c !== Ch.BrowR) expect(pose[c]).toBe(0);
    }
  });

  it('clamps joy and annoy to [0, 1] and rejects a non-finite bump', () => {
    const mood = createMood();
    mood.bump('joy', 5);
    expect(mood.joy).toBe(1);
    mood.bump('joy', -3);
    expect(mood.joy).toBe(0);
    mood.bump('annoy', 0.4);
    mood.bump('annoy', 0.4);
    expect(mood.annoy).toBeCloseTo(0.8, 12);
    expect(mood.joy).toBe(0);
    expect(() => mood.bump('joy', Number.NaN)).toThrow(RangeError);
    expect(() => mood.bump('annoy', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

/** The channels each weighted layer may write. */
const WEIGHTED: {
  name: keyof LayerWeights;
  make: () => Layer;
  channels: number[];
}[] = [
  { name: 'blink', make: () => createBlink(), channels: [Ch.LidL, Ch.LidR] },
  { name: 'breathing', make: () => createBreathing(), channels: [Ch.BodySquash, Ch.BellyJiggle] },
  {
    name: 'gaze',
    make: () => createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt }),
    channels: [Ch.IrisX, Ch.IrisY, Ch.HeadRot, Ch.HeadTilt],
  },
  {
    name: 'ears',
    make: () => createEarTwitch({ earL: IDX.earL, earR: IDX.earR }),
    channels: [Ch.EarRotL, Ch.EarRotR],
  },
];

/** A base pose with every channel non-zero, so "adds" is told apart from "overwrites". */
function base(): Pose {
  const p = createPose();
  for (let c = 0; c < CH_COUNT; c++) p[c] = 0.25 * ((c % 5) - 2) + 0.1;
  return p;
}

describe('weights', () => {
  /** Per-step deltas (pose − base) of `layer` at weight `w` for its key, other weights 0.37, over 60 s. */
  function deltas(entry: (typeof WEIGHTED)[number], w: number): Float64Array {
    const layer = entry.make();
    const ctx = makeCtx(SEED, { blink: 0.37, breathing: 0.37, gaze: 0.37, ears: 0.37, [entry.name]: w });
    const b = base();
    const pose = createPose();
    const steps = 3600;
    const out = new Float64Array(steps * CH_COUNT);
    for (let i = 0; i < steps; i++) {
      ctx.springs.step(DT);
      pose.set(b);
      layer.update(DT, pose, ctx);
      for (let c = 0; c < CH_COUNT; c++) out[i * CH_COUNT + c] = pose[c]! - b[c]!;
    }
    return out;
  }

  it.each(WEIGHTED.map((e) => [e.name, e] as const))(
    '%s adds nothing at weight 0, its full amount at 1 and half at 0.5, on its own channels only',
    (_name, entry) => {
      const full = deltas(entry, 1);
      const half = deltas(entry, 0.5);
      const none = deltas(entry, 0);
      let moved = 0;
      let noneNonZero = 0;
      let foreign = 0;
      let halfErr = 0;
      for (let i = 0; i < full.length; i++) {
        const c = i % CH_COUNT;
        if (none[i] !== 0) noneNonZero++;
        if (!entry.channels.includes(c)) {
          if (full[i] !== 0 || half[i] !== 0) foreign++;
          continue;
        }
        halfErr = Math.max(halfErr, Math.abs(half[i]! - 0.5 * full[i]!));
        if (Math.abs(full[i]!) > 1e-3) moved++;
      }
      expect(noneNonZero).toBe(0);
      expect(foreign).toBe(0);
      expect(halfErr).toBeLessThanOrEqual(1e-6);
      expect(moved).toBeGreaterThan(10);
    },
  );

  it('gives the full amount at weight 1: the iris, the springs and the breathing formula', () => {
    const gaze = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
    const ctx = makeCtx();
    run(gaze, ctx, 600, (_i, _t, pose) => {
      expect(pose[Ch.IrisX]).toBe(Math.fround(gaze.irisX));
      expect(pose[Ch.IrisY]).toBe(Math.fround(gaze.irisY));
      expect(pose[Ch.HeadRot]).toBe(ctx.springs.pos[IDX.headRot]);
      expect(pose[Ch.HeadTilt]).toBe(ctx.springs.pos[IDX.headTilt]);
    });
  });
});

/** All five layers with their context and pose, stepped by `stepAll`. */
interface AllLayers {
  ctx: AnimContext;
  mood: MoodLayer;
  layers: Layer[];
  pose: Pose;
  lookAt: LookAt;
}

function makeAll(seed: number): AllLayers {
  const mood = createMood();
  return {
    ctx: makeCtx(seed),
    mood,
    layers: [
      createBlink(),
      createBreathing(),
      createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt }),
      createEarTwitch({ earL: IDX.earL, earR: IDX.earR }),
      mood,
    ],
    pose: createPose(),
    lookAt: { x: 900, y: 200 },
  };
}

/**
 * Step `i` of all five layers, the app's way (#81: the bank, then the layers, on a cleared pose). `lookAt` is
 * set during steps 1200–1499 of every 3000, and mood is bumped every 1000 steps. Allocates nothing itself.
 */
function stepAll(h: AllLayers, i: number): void {
  const k = i % 3000;
  h.ctx.lookAt = k >= 1200 && k < 1500 ? h.lookAt : null;
  if (i % 1000 === 500) h.mood.bump(i % 2000 === 500 ? 'joy' : 'annoy', 0.6);
  h.ctx.springs.step(DT);
  h.pose.fill(0);
  for (let l = 0; l < h.layers.length; l++) h.layers[l]!.update(DT, h.pose, h.ctx);
}

/** The pose after each of `steps` steps of all five layers, concatenated. */
function runAll(seed: number, steps: number): Float32Array {
  const h = makeAll(seed);
  const out = new Float32Array(steps * CH_COUNT);
  for (let i = 0; i < steps; i++) {
    stepAll(h, i);
    out.set(h.pose, i * CH_COUNT);
  }
  return out;
}

describe('determinism', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays the same pose sequence for the same seed, and a different one for another seed', () => {
    const steps = 7200;
    const a = runAll(SEED, steps);
    const b = runAll(SEED, steps);
    const c = runAll(SEED + 1, steps);
    let sameDiffers = 0;
    let otherDiffers = 0;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) sameDiffers++;
      if (a[i] !== c[i]) otherDiffers++;
    }
    expect(sameDiffers).toBe(0);
    expect(otherDiffers).toBeGreaterThan(1000);
  });

  it('never calls Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('a layer called Math.random');
    });
    expect(() => runAll(SEED, 7200)).not.toThrow();
  });
});

/** A source of step sizes. */
type DtSource = () => number;

/** The app's substep and a seeded variable step in [1/240, 1/30]; each call starts a fresh sequence. */
const DT_CASES: { name: string; make: () => DtSource }[] = [
  { name: 'SUBSTEP (1/120 s)', make: () => () => SUBSTEP },
  {
    name: 'a seeded variable dt in [1/240, 1/30]',
    make: () => {
      const r = mulberry32(0xd7);
      return () => uniform(r, 1 / 240, 1 / 30);
    },
  },
];

/**
 * Steps `layer` the app's way with steps from `next` until the simulated time reaches `until`; after each
 * step, `each(t, dt, pose)` observes it, t being the sum of the steps so far (compensated summation, so t
 * stays exact to ~1e-12 s over 10 000 s of small steps).
 */
function runUntil(
  layer: Layer,
  ctx: AnimContext,
  next: DtSource,
  until: number,
  each: (t: number, dt: number, pose: Pose) => void,
): void {
  const pose = createPose();
  let t = 0;
  let lost = 0;
  while (t < until) {
    const dt = next();
    const y = dt - lost;
    const sum = t + y;
    lost = sum - t - y;
    t = sum;
    ctx.springs.step(dt);
    pose.fill(0);
    layer.update(dt, pose, ctx);
    each(t, dt, pose);
  }
}

/** A layer with an event counter, and the seconds since its latest event. */
interface Timed {
  layer: Layer & { readonly count: number };
  since: () => number;
}

const TIMED: { name: string; make: () => Timed }[] = [
  {
    name: 'blink onsets',
    make: () => {
      const layer = createBlink();
      return { layer, since: () => layer.sinceOnset };
    },
  },
  {
    name: 'saccades',
    make: () => {
      const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
      return { layer, since: () => layer.sinceSaccade };
    },
  },
  {
    name: 'ear twitches',
    make: () => {
      const layer = createEarTwitch({ earL: IDX.earL, earR: IDX.earR });
      return { layer, since: () => layer.sinceTwitch };
    },
  },
];

/** The exact event times (t − since) of a fresh `timed` layer over 10 000 s with steps from `next`. */
function eventTimes(timed: Timed, next: DtSource): number[] {
  const out: number[] = [];
  let count = 0;
  runUntil(timed.layer, makeCtx(), next, 10_000, (t) => {
    if (timed.layer.count !== count) {
      count = timed.layer.count;
      out.push(t - timed.since());
    }
  });
  return out;
}

describe('dt robustness: exact timing at any step (the app runs the layers at SUBSTEP = 1/120 s)', () => {
  const reference = TIMED.map((timed) => eventTimes(timed.make(), () => DT));

  describe.each(DT_CASES)('at $name', ({ make }) => {
    it.each(TIMED.map((timed, k) => [timed.name, k] as const))(
      'dates the %s exactly as at dt = 1/60 (within 1e-9 s)',
      (_name, k) => {
        const ref = reference[k]!.filter((t) => t < 9990);
        const got = eventTimes(TIMED[k]!.make(), make()).filter((t) => t < 9990);
        expect(ref.length).toBeGreaterThan(600);
        expect(got).toHaveLength(ref.length);
        let maxErr = 0;
        for (let j = 0; j < ref.length; j++) maxErr = Math.max(maxErr, Math.abs(got[j]! - ref[j]!));
        expect(maxErr).toBeLessThanOrEqual(1e-9);
      },
    );

    it('shuts the first single blink at 0.06 s within one step, and has it open at the first step from 0.18 s', () => {
      const layer = createBlink();
      let count = 0;
      let doubles = 0;
      /** `count` of the first single blink, once it has started. */
      let single = 0;
      let onset = Number.NaN;
      let prevPhase = Number.NaN;
      let shutPhase = Number.NaN;
      let shutPrevPhase = Number.NaN;
      let openLid = Number.NaN;
      runUntil(layer, makeCtx(), make(), 60, (t, _dt, pose) => {
        if (layer.count !== count) {
          if (single === 0 && layer.doubles === doubles) {
            single = layer.count;
            onset = t - layer.sinceOnset;
          }
          count = layer.count;
          doubles = layer.doubles;
        }
        if (single === 0 || layer.count !== single) return;
        const phase = t - onset;
        const lid = pose[Ch.LidL]!;
        if (Number.isNaN(shutPhase) && lid >= 1 - 1e-6) {
          shutPhase = phase;
          shutPrevPhase = prevPhase;
        }
        if (Number.isNaN(openLid) && phase >= 0.18) openLid = lid;
        prevPhase = phase;
      });
      expect(single).toBeGreaterThan(0);
      // The first step whose phase is at or past 0.06 s is the first shut one.
      expect(shutPhase).toBeGreaterThanOrEqual(0.06 - 1e-9);
      expect(shutPrevPhase).toBeLessThan(0.06);
      expect(openLid).toBeLessThanOrEqual(1e-6);
    });

    it('decays mood to 1/e in 8 s ± 0.1', () => {
      const mood = createMood();
      mood.bump('joy', 1);
      mood.bump('annoy', 1);
      let joyAt = Number.NaN;
      let annoyAt = Number.NaN;
      runUntil(mood, makeCtx(), make(), 9, (t) => {
        if (Number.isNaN(joyAt) && mood.joy <= 1 / Math.E) joyAt = t;
        if (Number.isNaN(annoyAt) && mood.annoy <= 1 / Math.E) annoyAt = t;
      });
      expect(Math.abs(joyAt - 8)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(annoyAt - 8)).toBeLessThanOrEqual(0.1);
    });

    it('breathes 0.012·sin(2π·0.25·t) (belly + 0.2 cycles) within 1e-7, t = Σdt', () => {
      let maxErr = 0;
      runUntil(createBreathing(), makeCtx(), make(), 80, (t, _dt, pose) => {
        maxErr = Math.max(
          maxErr,
          Math.abs(pose[Ch.BodySquash]! - 0.012 * Math.sin(TAU * 0.25 * t)),
          Math.abs(pose[Ch.BellyJiggle]! - 0.012 * Math.sin(TAU * 0.25 * t + 0.2 * TAU)),
        );
      });
      expect(maxErr).toBeLessThanOrEqual(1e-7);
    });

    it.each<[string, LookAt]>([
      ['right', { x: 1500, y: 385 }],
      ['down', { x: 500, y: 1385 }],
    ])('settles the head at 30 %% ± 3 %% of the follow with lookAt held to the %s', (_side, lookAt) => {
      const layer = createGaze({ headRot: IDX.headRot, headTilt: IDX.headTilt });
      const ctx = makeCtx();
      ctx.lookAt = lookAt;
      const last = createPose();
      runUntil(layer, ctx, make(), 5, (_t, _dt, pose) => {
        last.set(pose);
      });
      const [iris, head] = lookAt.x !== EYES_CENTER.x ? [Ch.IrisX, Ch.HeadRot] : [Ch.IrisY, Ch.HeadTilt];
      expect(Math.abs(last[iris]!)).toBeGreaterThan(9.99);
      const r = last[head]! / ((last[iris]! / 10) * 0.12);
      expect(r).toBeGreaterThanOrEqual(0.27);
      expect(r).toBeLessThanOrEqual(0.33);
    });
  });
});

/** The `gc` function, exposed once at runtime with Node built-ins only (no `--expose-gc` flag needed). */
let exposedGc: (() => void) | undefined;

/** Runs a full garbage collection (the pattern of src/anim/clip.test.ts). */
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

describe('allocation: no layer allocates per update', () => {
  it('makes no array or typed-array allocation over 60 000 steps of all five layers', () => {
    const h = makeAll(SEED);
    stepAll(h, 0);
    const allocations = countAllocations(() => {
      for (let i = 1; i <= 60_000; i++) stepAll(h, i);
    });
    expect(allocations).toBe(0);
  });

  it('grows the heap by < 1 MB over 50 000 steps of all five layers, once V8 has optimised them', () => {
    const h = makeAll(SEED);
    let i = 0;
    const steps50k = (): void => {
      for (let n = 0; n < 50_000; n++) stepAll(h, i++);
    };
    // As in src/anim/clip.test.ts: warm up so V8's optimising tiers take over (the interpreter boxes every
    // double), then take the best of up to 20 runs, each from a freshly collected heap; a run during which any
    // GC ran counts as +Infinity. A layer that really allocates does so in every run: one 32-byte object per
    // update of one layer is 1.6 MB here.
    forceGc();
    for (let w = 0; w < 10; w++) steps50k();
    const LIMIT = 1_048_576;
    let best = heapGrowth(steps50k);
    for (let trial = 1; trial < 20 && best >= LIMIT; trial++) best = Math.min(best, heapGrowth(steps50k));
    expect(best).toBeLessThan(LIMIT);
  });

  it('both meters have teeth (positive controls)', () => {
    expect(countAllocations(() => void new Float32Array(1))).toBe(1);
    expect(countAllocations(() => void Array.from({ length: 3 }))).toBeGreaterThan(0);
    const kept: number[][] = [];
    const growth = heapGrowth(() => {
      for (let n = 0; n < 10_000; n++) kept.push(Array.from({ length: 64 }, (_, j) => j + 0.5));
    });
    expect(kept).toHaveLength(10_000);
    expect(growth).toBeGreaterThanOrEqual(1_048_576);
  });
});
