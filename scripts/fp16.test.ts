import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fp16ToFp32 } from '../src/dsp/silero/weights.ts';
import { encodeFp16LE, fp32ToFp16Bits } from './fp16.ts';

describe('fp32ToFp16Bits', () => {
  it.each([
    ['1.0', 1, 0x3c00],
    ['-2', -2, 0xc000],
    ['65504 (largest finite)', 65504, 0x7bff],
    ['65519 (rounds down to 65504)', 65519, 0x7bff],
    ['2^-14 ≈ 6.1e-5 (smallest normal)', 2 ** -14, 0x0400],
    ['6.1e-5 literal (nearer the largest subnormal)', 6.1e-5, 0x03ff],
    ['1023.5 · 2^-24 (tie, rounds up to the smallest normal)', 1023.5 * 2 ** -24, 0x0400],
    ['2^-24 ≈ 5.96e-8 (smallest subnormal)', 2 ** -24, 0x0001],
    ['5.96e-8 literal', 5.96e-8, 0x0001],
    ['2^-25 (tie, rounds to even 0)', 2 ** -25, 0x0000],
    ['3 · 2^-25 (tie, rounds to even 2 · 2^-24)', 3 * 2 ** -25, 0x0002],
    ['2^-26 (underflows to +0)', 2 ** -26, 0x0000],
    ['-2^-26 (underflows to -0)', -(2 ** -26), 0x8000],
    ['+0', 0, 0x0000],
    ['-0', -0, 0x8000],
    ['1 + 2^-11 (tie, rounds to even 1.0)', 1 + 2 ** -11, 0x3c00],
    ['1 + 3 · 2^-11 (tie, rounds to even 1 + 2^-9)', 1 + 3 * 2 ** -11, 0x3c02],
    ['2 − 2^-12 (mantissa carry into the exponent)', 2 - 2 ** -12, 0x4000],
    ['0.1', 0.1, 0x2e66],
  ])('%s', (_name, value, bits) => {
    expect(fp32ToFp16Bits(value)).toBe(bits);
  });

  it.each([65520, -65520, 1e6, Infinity, -Infinity, NaN])(
    'throws on %s (overflow or non-finite)',
    (value) => {
      expect(() => fp32ToFp16Bits(value)).toThrow(RangeError);
    },
  );

  it('round-trips every finite fp16 bit pattern through fp16ToFp32', () => {
    for (let h = 0; h < 0x10000; h++) {
      if (((h >>> 10) & 0x1f) === 0x1f) continue; // ±Inf and NaN
      if (fp32ToFp16Bits(fp16ToFp32(h)) !== h) throw new Error(`0x${h.toString(16)} does not round-trip`);
    }
  });

  it('rounds every finite float32 below 65520 in magnitude to the nearest fp16, ties to even', () => {
    fc.assert(
      fc.property(
        fc.float({
          noNaN: true,
          noDefaultInfinity: true,
          min: Math.fround(-65519.99),
          max: Math.fround(65519.99),
        }),
        (x) => {
          const h = fp32ToFp16Bits(x);
          const sign = h & 0x8000;
          const mag = h & 0x7fff;
          const err = Math.abs(x - fp16ToFp32(h));
          // Neighbours in magnitude on the same side of zero (the one below 0 is the opposite-sign subnormal).
          const below = mag > 0 ? fp16ToFp32(sign | (mag - 1)) : -fp16ToFp32(sign | 1);
          const above = mag < 0x7bff ? fp16ToFp32(sign | (mag + 1)) : Infinity;
          const errBelow = Math.abs(x - below);
          const errAbove = Math.abs(x - above);
          expect(err).toBeLessThanOrEqual(errBelow);
          expect(err).toBeLessThanOrEqual(errAbove);
          if (err !== 0 && (err === errBelow || err === errAbove)) expect(h & 1).toBe(0);
          // The sign is kept, including for results that underflow to zero.
          expect(sign !== 0).toBe(Object.is(x, -0) || x < 0);
        },
      ),
      { numRuns: 20_000, seed: 0x7f16 },
    );
  });
});

describe('encodeFp16LE', () => {
  it('writes little-endian fp16 back to back', () => {
    expect([...encodeFp16LE([1, -2, 65504])]).toEqual([0x00, 0x3c, 0x00, 0xc0, 0xff, 0x7b]);
  });

  it('throws when any value overflows', () => {
    expect(() => encodeFp16LE([1, 70000])).toThrow(RangeError);
  });
});
