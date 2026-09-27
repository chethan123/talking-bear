import { describe, expect, it } from 'vitest';

import { mulberry32 as referenceMulberry32 } from '../../../test/dsp-helpers.ts';
import { exponential, mulberry32, uniform } from '../rng.ts';

/**
 * The seed of the single-seed statistical tests ("T67"); fixed, so each run replays the same draws. It is
 * central, not lucky: 3.5066 s and 15.47 % doubles, where 171 of seeds 1–200 pass the issue's ±0.1 s mean
 * check (the tolerance is ≈ 1.5 standard errors); the 100-seed pooled test below doesn't depend on it.
 */
const SEED = 0x7467;

function mean(xs: readonly number[]): number {
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

function sampleStd(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
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
