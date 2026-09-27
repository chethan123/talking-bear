import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';

describe('dsp-helpers', () => {
  it('toneLevelDb reads a full-scale sine as 0 dB and rmsDb as -3.01 dB', () => {
    const x = sine(1000, 48_000, 1, 1);
    expect(x.length).toBe(48_000);
    expect(Math.abs(toneLevelDb(x, 1000, 48_000, 24_000, 48_000))).toBeLessThanOrEqual(0.01);
    expect(Math.abs(rmsDb(x) - 20 * Math.log10(Math.SQRT1_2))).toBeLessThanOrEqual(0.01);
  });

  it('toneLevelDb reads the default 0.5 amplitude as -6.02 dB', () => {
    const x = sine(1000, 48_000, 1);
    expect(Math.abs(toneLevelDb(x, 1000, 48_000, 24_000, 48_000) - 20 * Math.log10(0.5))).toBeLessThanOrEqual(
      0.01,
    );
  });

  it('toneLevelDb has no scalloping loss for a tone off the analysis bin grid', () => {
    const x = sine(1234.5, 48_000, 1, 1, 0.3);
    expect(Math.abs(toneLevelDb(x, 1234.5, 48_000, 24_000, 48_000))).toBeLessThanOrEqual(0.01);
  });

  it('toneLevelDb rejects other frequencies', () => {
    const x = sine(3000, 48_000, 1, 1);
    expect(toneLevelDb(x, 1000, 48_000, 24_000, 48_000)).toBeLessThanOrEqual(-80);
  });

  it('rmsDb of digital silence is -400 dB', () => {
    expect(rmsDb(new Float32Array(100))).toBeCloseTo(-400, 6);
  });

  it('helpers reject invalid ranges', () => {
    const x = new Float32Array(10);
    expect(() => rmsDb(x, 5, 5)).toThrow(RangeError);
    expect(() => rmsDb(x, -1, 5)).toThrow(RangeError);
    expect(() => rmsDb(x, 0, 11)).toThrow(RangeError);
    expect(() => rmsDb(x, 0.5, 5)).toThrow(RangeError);
    expect(() => toneLevelDb(x, 100, 1000, 3, 4)).toThrow(RangeError);
  });

  it('mulberry32 is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    let differs = false;
    for (let i = 0; i < 10_000; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
      if (va !== c()) differs = true;
    }
    expect(differs).toBe(true);
  });
});
