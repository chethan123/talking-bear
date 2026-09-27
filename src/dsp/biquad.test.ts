import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import { butterworthHighpass, butterworthLowpass, cascade, type Biquad } from './biquad.ts';

/** Float32 bit patterns, so comparisons are bit-exact (+0 vs -0 and NaN payloads count). */
function bits(a: Float32Array): Uint32Array {
  return new Uint32Array(a.buffer, a.byteOffset, a.length);
}

/** First index where a and b differ bit-for-bit, 0 if the lengths differ, or -1 if identical. */
function firstMismatch(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  const ua = bits(a);
  const ub = bits(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return i;
  return -1;
}

/** Uniform white noise in [-1, 1) from a seeded PRNG. */
function noise(n: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

/** Steady-state gain in dB at f: toneLevelDb(out) - toneLevelDb(in) over the last 0.5 s of a 1 s sine. */
function gainDb(make: () => Biquad, fs: number, f: number): number {
  const x = sine(f, fs, 1);
  const y = make().process(x);
  const from = x.length - Math.round(0.5 * fs);
  return toneLevelDb(y, f, fs, from, x.length) - toneLevelDb(x, f, fs, from, x.length);
}

const gate16k = (): Biquad =>
  cascade(
    butterworthHighpass(16_000, 200),
    butterworthHighpass(16_000, 200),
    butterworthLowpass(16_000, 3400),
  );

const FILTERS: ReadonlyArray<readonly [string, () => Biquad]> = [
  ['HPF 80 Hz @ 48 kHz', () => butterworthHighpass(48_000, 80)],
  ['HPF 200 Hz @ 16 kHz', () => butterworthHighpass(16_000, 200)],
  ['LPF 3400 Hz @ 16 kHz', () => butterworthLowpass(16_000, 3400)],
  ['gate band-limit cascade (HPF 200 x2, LPF 3400) @ 16 kHz', gate16k],
];

describe('butterworthHighpass 80 Hz @ 48 kHz (validation 1)', () => {
  const make = (): Biquad => butterworthHighpass(48_000, 80);

  it('is -3.01 dB at 80 Hz', () => {
    expect(Math.abs(gainDb(make, 48_000, 80) + 3.01)).toBeLessThanOrEqual(0.05);
  });

  it('is at most -23.5 dB at 20 Hz', () => {
    expect(gainDb(make, 48_000, 20)).toBeLessThanOrEqual(-23.5);
  });

  it('is 0 dB at 1 kHz', () => {
    expect(Math.abs(gainDb(make, 48_000, 1000))).toBeLessThanOrEqual(0.1);
  });
});

describe('gate band-limit filters @ 16 kHz (validation 2)', () => {
  it('HPF 200 Hz is -3.01 dB at 200 Hz', () => {
    expect(Math.abs(gainDb(() => butterworthHighpass(16_000, 200), 16_000, 200) + 3.01)).toBeLessThanOrEqual(
      0.05,
    );
  });

  const lpf = (): Biquad => butterworthLowpass(16_000, 3400);

  it('LPF 3400 Hz is -3.01 dB at 3400 Hz', () => {
    expect(Math.abs(gainDb(lpf, 16_000, 3400) + 3.01)).toBeLessThanOrEqual(0.05);
  });

  it('LPF 3400 Hz is 0 dB at 1 kHz', () => {
    expect(Math.abs(gainDb(lpf, 16_000, 1000))).toBeLessThanOrEqual(0.2);
  });

  it('LPF 3400 Hz is at most -12 dB at 7 kHz', () => {
    expect(gainDb(lpf, 16_000, 7000)).toBeLessThanOrEqual(-12);
  });
});

describe.each(FILTERS)('%s', (_name, make) => {
  it('streams bit-exactly across random chunk sizes (validation 3)', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.array(fc.integer({ min: 1, max: 700 }), { minLength: 1, maxLength: 64 }),
        (seed, sizes) => {
          const x = noise(4800, seed);
          const whole = make().process(x);
          const f = make();
          const out = new Float32Array(x.length);
          let pos = 0;
          for (let k = 0; pos < x.length; k++) {
            const end = Math.min(x.length, pos + sizes[k % sizes.length]!);
            f.process(x.subarray(pos, end), out.subarray(pos, end));
            pos = end;
          }
          expect(firstMismatch(out, whole)).toBe(-1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reset() makes it behave like a fresh filter (validation 4)', () => {
    const f = make();
    f.process(noise(4800, 1));
    f.reset();
    const x = noise(4800, 2);
    expect(firstMismatch(f.process(x), make().process(x))).toBe(-1);
  });

  it('process(x, x) works in place (validation 5)', () => {
    const x = noise(4800, 3);
    const ref = make().process(x);
    const buf = x.slice();
    const r = make().process(buf, buf);
    expect(r).toBe(buf);
    expect(firstMismatch(buf, ref)).toBe(-1);
  });

  it('is stable: impulse response energy in samples 48 000..96 000 is < 1e-12 (validation 6)', () => {
    const x = new Float32Array(96_001);
    x[0] = 1;
    const y = make().process(x);
    let energy = 0;
    for (let n = 48_000; n <= 96_000; n++) energy += y[n]! * y[n]!;
    expect(energy).toBeLessThan(1e-12);
  });

  it('writes into the given out array and returns it', () => {
    const x = noise(256, 4);
    const copy = x.slice();
    const out = new Float32Array(256);
    expect(make().process(x, out)).toBe(out);
    expect(firstMismatch(out, make().process(x))).toBe(-1);
    expect(firstMismatch(x, copy)).toBe(-1);
  });

  it('throws RangeError when out.length !== x.length', () => {
    expect(() => make().process(new Float32Array(8), new Float32Array(7))).toThrow(RangeError);
  });
});

describe('Butterworth factories', () => {
  it.each([
    ['highpass', butterworthHighpass],
    ['lowpass', butterworthLowpass],
  ] as const)('%s throws RangeError unless 0 < cutoff < fs/2', (_name, factory) => {
    for (const cutoff of [0, -1, 24_000, 30_000, Number.NaN]) {
      expect(() => factory(48_000, cutoff)).toThrow(RangeError);
    }
    expect(() => factory(Number.POSITIVE_INFINITY, 1000)).toThrow(RangeError);
    expect(() => factory(Number.NaN, 1000)).toThrow(RangeError);
    expect(() => factory(48_000, 23_999)).not.toThrow();
    expect(() => factory(48_000, 1)).not.toThrow();
  });
});

describe('cascade', () => {
  it('equals running the stages one after another', () => {
    const x = noise(4800, 5);
    const expected = butterworthLowpass(16_000, 3400).process(
      butterworthHighpass(16_000, 200).process(butterworthHighpass(16_000, 200).process(x)),
    );
    expect(firstMismatch(gate16k().process(x), expected)).toBe(-1);
  });

  it('does not modify x when out is omitted or distinct', () => {
    const x = noise(512, 6);
    const copy = x.slice();
    gate16k().process(x);
    gate16k().process(x, new Float32Array(512));
    expect(firstMismatch(x, copy)).toBe(-1);
  });

  it('with no stages is the identity', () => {
    const x = noise(64, 7);
    const y = cascade().process(x);
    expect(y).not.toBe(x);
    expect(firstMismatch(y, x)).toBe(-1);
    const copy = x.slice();
    expect(cascade().process(x, x)).toBe(x);
    expect(firstMismatch(x, copy)).toBe(-1);
  });
});

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
