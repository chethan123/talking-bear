import { describe, expect, it } from 'vitest';
import { DEFAULT_ENERGY_PARAMS } from './energy-gate.ts';
import { activeLevelDb, DIGITAL_SILENCE_DB, passesProximity } from './proximity.ts';

const f32 = (...v: number[]): Float32Array => Float32Array.from(v);

describe('activeLevelDb', () => {
  it('is the power mean: −20 and −40 dB give ≈ −22.96 dB', () => {
    const want = 10 * Math.log10((10 ** -2 + 10 ** -4) / 2);
    expect(want).toBeCloseTo(-22.967, 3);
    expect(activeLevelDb(f32(-20, -40), 0, 2)).toBeCloseTo(want, 12);
  });

  it('returns the single value of a one-hop range, and is order independent', () => {
    expect(activeLevelDb(f32(-33.5), 0, 1)).toBeCloseTo(-33.5, 5);
    expect(activeLevelDb(f32(-40, -20), 0, 2)).toBeCloseTo(activeLevelDb(f32(-20, -40), 0, 2), 12);
  });

  it('gives −Infinity for digital silence and for an empty range', () => {
    expect(DIGITAL_SILENCE_DB).toBe(-100);
    expect(DIGITAL_SILENCE_DB).toBe(DEFAULT_ENERGY_PARAMS.ignoreBelowDb); // the energy gate's silence level
    expect(activeLevelDb(f32(-120, -120, -100.5), 0, 3)).toBe(Number.NEGATIVE_INFINITY);
    expect(activeLevelDb(f32(-20, -40), 1, 1)).toBe(Number.NEGATIVE_INFINITY);
    expect(activeLevelDb(new Float32Array(0), 0, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('ignores values below −100 dBFS and NaN, and keeps −100 itself', () => {
    const base = activeLevelDb(f32(-20, -40), 0, 2);
    expect(activeLevelDb(f32(-20, -120, Number.NaN, -40, -100.01), 0, 5)).toBeCloseTo(base, 12);
    expect(activeLevelDb(f32(-100), 0, 1)).toBeCloseTo(-100, 5);
  });

  it('reads only [from, to)', () => {
    expect(activeLevelDb(f32(0, -20, -40, 0), 1, 3)).toBeCloseTo(activeLevelDb(f32(-20, -40), 0, 2), 12);
  });

  it('wraps around the end of a ring: element i is hopDb[i % length]', () => {
    const ring = f32(-40, 0, 0, -20);
    expect(activeLevelDb(ring, 3, 5)).toBeCloseTo(activeLevelDb(f32(-20, -40), 0, 2), 12);
    expect(activeLevelDb(ring, 1, 5)).toBeCloseTo(activeLevelDb(ring, 0, 4), 12);
  });

  it.each([
    [0.5, 1],
    [0, 1.5],
    [-1, 1],
    [2, 1],
    [0, 5],
    [3, 8],
  ])('throws RangeError for [%s, %s) on a length-4 array', (from, to) => {
    expect(() => activeLevelDb(new Float32Array(4), from, to)).toThrow(RangeError);
  });
});

describe('passesProximity', () => {
  it('passes iff activeDb − floor ≥ proximityDb (the boundary passes)', () => {
    expect(passesProximity(-40, -46, 6)).toBe(true);
    expect(passesProximity(-40.001, -46, 6)).toBe(false);
    expect(passesProximity(-30, -46, 6)).toBe(true);
    expect(passesProximity(-46, -46, 0)).toBe(true);
    expect(passesProximity(-46.5, -46, 0)).toBe(false);
    expect(passesProximity(-49, -46, -3)).toBe(true);
    expect(passesProximity(-34, -46, 12)).toBe(true);
    expect(passesProximity(-34, -46, 12.5)).toBe(false);
  });

  it('fails a silent segment (−Infinity) against a finite floor', () => {
    expect(passesProximity(Number.NEGATIVE_INFINITY, -60, 0)).toBe(false);
  });

  it('always passes with a NaN floor (no floor at the onset)', () => {
    expect(passesProximity(-40, Number.NaN, 6)).toBe(true);
    expect(passesProximity(Number.NEGATIVE_INFINITY, Number.NaN, 1000)).toBe(true);
  });
});
