import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import {
  butterworthHighpass,
  butterworthHighpassCoefficients,
  butterworthLowpass,
  butterworthLowpassCoefficients,
  cascade,
  peaking,
  peakingCoefficients,
  type Biquad,
} from './biquad.ts';
import {
  highpassQ,
  highpassQCoefficients,
  highShelf,
  highShelfCoefficients,
  type BiquadCoefficients,
} from './biquad.ts';

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

const hpf80At48k = (): Biquad => butterworthHighpass(48_000, 80);
const hpf200At16k = (): Biquad => butterworthHighpass(16_000, 200);
const lpf3400At16k = (): Biquad => butterworthLowpass(16_000, 3400);
const gate16k = (): Biquad =>
  cascade(
    butterworthHighpass(16_000, 200),
    butterworthHighpass(16_000, 200),
    butterworthLowpass(16_000, 3400),
  );

const FILTERS: ReadonlyArray<readonly [string, () => Biquad]> = [
  ['HPF 80 Hz @ 48 kHz', hpf80At48k],
  ['HPF 200 Hz @ 16 kHz', hpf200At16k],
  ['LPF 3400 Hz @ 16 kHz', lpf3400At16k],
  ['gate band-limit cascade (HPF 200 x2, LPF 3400) @ 16 kHz', gate16k],
];

describe('butterworthHighpass 80 Hz @ 48 kHz (validation 1)', () => {
  it('is -3.01 dB at 80 Hz', () => {
    expect(Math.abs(gainDb(hpf80At48k, 48_000, 80) + 3.01)).toBeLessThanOrEqual(0.05);
  });

  it('is at most -23.5 dB at 20 Hz', () => {
    expect(gainDb(hpf80At48k, 48_000, 20)).toBeLessThanOrEqual(-23.5);
  });

  it('is 0 dB at 1 kHz', () => {
    expect(Math.abs(gainDb(hpf80At48k, 48_000, 1000))).toBeLessThanOrEqual(0.1);
  });
});

describe('gate band-limit filters @ 16 kHz (validation 2)', () => {
  it('HPF 200 Hz is -3.01 dB at 200 Hz', () => {
    expect(Math.abs(gainDb(hpf200At16k, 16_000, 200) + 3.01)).toBeLessThanOrEqual(0.05);
  });

  it('LPF 3400 Hz is -3.01 dB at 3400 Hz', () => {
    expect(Math.abs(gainDb(lpf3400At16k, 16_000, 3400) + 3.01)).toBeLessThanOrEqual(0.05);
  });

  it('LPF 3400 Hz is 0 dB at 1 kHz', () => {
    expect(Math.abs(gainDb(lpf3400At16k, 16_000, 1000))).toBeLessThanOrEqual(0.2);
  });

  it('LPF 3400 Hz is at most -12 dB at 7 kHz', () => {
    expect(gainDb(lpf3400At16k, 16_000, 7000)).toBeLessThanOrEqual(-12);
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

/** Test-local DF2T with the same float64 recurrence as the module's Section. */
function df2t(c: BiquadCoefficients, x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = c.b0 * xi + s1;
    s1 = c.b1 * xi - c.a1 * yi + s2;
    s2 = c.b2 * xi - c.a2 * yi;
    y[i] = yi;
  }
  return y;
}

function impulse(n: number): Float32Array {
  const x = new Float32Array(n);
  x[0] = 1;
  return x;
}

/** |H(e^jω)| in dB at f, evaluated analytically from the coefficients. */
function responseDb(c: BiquadCoefficients, fs: number, f: number): number {
  const w = (2 * Math.PI * f) / fs;
  const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
  const ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
  const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
  const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
  return 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
}

describe('highShelf / highpassQ (BS.1770 forms)', () => {
  // ITU-R BS.1770 analog prototypes, as in libebur128.
  const SHELF_F0 = 1681.974450955533;
  const SHELF_GAIN_DB = 3.999843853973347;
  const SHELF_Q = 0.7071752369554196;
  const RLB_F0 = 38.13547087602444;
  const RLB_Q = 0.5003270373238773;

  it('reproduce the BS.1770-4 K-weighting coefficients at 48 kHz within 1e-6', () => {
    const s = highShelfCoefficients(48000, SHELF_F0, SHELF_GAIN_DB, SHELF_Q);
    expect(Math.abs(s.b0 - 1.53512485958697)).toBeLessThan(1e-6);
    expect(Math.abs(s.b1 - -2.69169618940638)).toBeLessThan(1e-6);
    expect(Math.abs(s.b2 - 1.19839281085285)).toBeLessThan(1e-6);
    expect(Math.abs(s.a1 - -1.69065929318241)).toBeLessThan(1e-6);
    expect(Math.abs(s.a2 - 0.73248077421585)).toBeLessThan(1e-6);
    const r = highpassQCoefficients(48000, RLB_F0, RLB_Q);
    expect(r.b0).toBe(1);
    expect(r.b1).toBe(-2);
    expect(r.b2).toBe(1);
    expect(Math.abs(r.a1 - -1.99004745483398)).toBeLessThan(1e-6);
    expect(Math.abs(r.a2 - 0.99007225036621)).toBeLessThan(1e-6);
  });

  it('the factories run exactly their coefficient functions (bit-exact impulse response)', () => {
    const x = impulse(256);
    const s = highShelf(48000, SHELF_F0, SHELF_GAIN_DB, SHELF_Q).process(x);
    const sRef = df2t(highShelfCoefficients(48000, SHELF_F0, SHELF_GAIN_DB, SHELF_Q), x);
    expect(firstMismatch(s, sRef)).toBe(-1);
    const r = highpassQ(48000, RLB_F0, RLB_Q).process(x);
    const rRef = df2t(highpassQCoefficients(48000, RLB_F0, RLB_Q), x);
    expect(firstMismatch(r, rRef)).toBe(-1);
  });

  it('highShelf: unity DC gain, 0 dB at 50 Hz, +4 dB at 20 kHz', () => {
    const c = highShelfCoefficients(48000, SHELF_F0, SHELF_GAIN_DB, SHELF_Q);
    expect(Math.abs((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(responseDb(c, 48000, 50))).toBeLessThan(0.01);
    expect(Math.abs(responseDb(c, 48000, 20000) - 4)).toBeLessThan(0.01);
  });

  it('highpassQ: blocks DC, attenuates 20 Hz, Nyquist-side gain 1 + K/q + K²', () => {
    const c = highpassQCoefficients(48000, RLB_F0, RLB_Q);
    expect(c.b0 + c.b1 + c.b2).toBe(0);
    expect(responseDb(c, 48000, 20)).toBeLessThanOrEqual(-10);
    const K = Math.tan((Math.PI * RLB_F0) / 48000);
    const expected = 20 * Math.log10(1 + K / RLB_Q + K * K);
    expect(Math.abs(responseDb(c, 48000, 20000) - expected)).toBeLessThan(0.001);
  });

  it('reject invalid parameters with RangeError', () => {
    expect(() => highShelf(48000, 0, 4, 0.7)).toThrow(RangeError);
    expect(() => highShelf(48000, 24000, 4, 0.7)).toThrow(RangeError);
    expect(() => highShelf(48000, 1000, 4, 0)).toThrow(RangeError);
    expect(() => highShelf(48000, 1000, Number.NaN, 0.7)).toThrow(RangeError);
    expect(() => highpassQ(48000, 38, -1)).toThrow(RangeError);
    expect(() => highpassQ(48000, 38, Number.NaN)).toThrow(RangeError);
    expect(() => highpassQ(Number.NaN, 38, 0.5)).toThrow(RangeError);
  });

  it('are stable: impulse-response energy in samples 48000…96000 < 1e-12', () => {
    const x = impulse(96_000);
    for (const f of [highShelf(48000, SHELF_F0, SHELF_GAIN_DB, SHELF_Q), highpassQ(48000, RLB_F0, RLB_Q)]) {
      const y = f.process(x);
      let e = 0;
      for (let i = 48_000; i < 96_000; i++) e += y[i]! * y[i]!;
      expect(e).toBeLessThan(1e-12);
    }
  });
});

/** The constructors' inline formulas before T115 (RBJ cookbook, Q = √½), kept to pin "outputs unchanged". */
function butterworthBeforeT115(kind: 'hp' | 'lp', fs: number, cutoff: number): BiquadCoefficients {
  const w0 = (2 * Math.PI * cutoff) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (kind === 'hp' ? (1 + cosw) / 2 : (1 - cosw) / 2) / a0;
  const b1 = kind === 'hp' ? -(1 + cosw) / a0 : (1 - cosw) / a0;
  return { b0, b1, b2: b0, a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0 };
}
const BUTTERWORTH_CASES = [
  [48_000, 80],
  [48_000, 320],
  [48_000, 5000],
  [44_100, 5000],
  [16_000, 200],
  [16_000, 3400],
] as const;

describe('butterworthHighpassCoefficients / butterworthLowpassCoefficients', () => {
  it.each(BUTTERWORTH_CASES)('equal the pre-T115 formulas exactly (fs %d, fc %d)', (fs, fcHz) => {
    expect(butterworthHighpassCoefficients(fs, fcHz)).toEqual(butterworthBeforeT115('hp', fs, fcHz));
    expect(butterworthLowpassCoefficients(fs, fcHz)).toEqual(butterworthBeforeT115('lp', fs, fcHz));
  });

  it.each(BUTTERWORTH_CASES)('the factories run exactly their coefficients (fs %d, fc %d)', (fs, fcHz) => {
    const x = noise(1024, 8);
    expect(
      firstMismatch(butterworthHighpass(fs, fcHz).process(x), df2t(butterworthBeforeT115('hp', fs, fcHz), x)),
    ).toBe(-1);
    expect(
      firstMismatch(butterworthLowpass(fs, fcHz).process(x), df2t(butterworthBeforeT115('lp', fs, fcHz), x)),
    ).toBe(-1);
  });

  it('are −3.01 dB at fc analytically, with unity gain at DC (low-pass) and Nyquist (high-pass)', () => {
    const hp = butterworthHighpassCoefficients(48_000, 320);
    const lp = butterworthLowpassCoefficients(48_000, 5000);
    expect(Math.abs(responseDb(hp, 48_000, 320) + 3.0103)).toBeLessThan(1e-3);
    expect(Math.abs(responseDb(lp, 48_000, 5000) + 3.0103)).toBeLessThan(1e-3);
    expect(Math.abs((lp.b0 + lp.b1 + lp.b2) / (1 + lp.a1 + lp.a2) - 1)).toBeLessThan(1e-12);
    expect(Math.abs((hp.b0 - hp.b1 + hp.b2) / (1 - hp.a1 + hp.a2) - 1)).toBeLessThan(1e-12);
  });

  it('throw RangeError unless 0 < fc < fs/2 and fs is finite', () => {
    for (const f of [butterworthHighpassCoefficients, butterworthLowpassCoefficients]) {
      expect(() => f(48_000, 0)).toThrow(RangeError);
      expect(() => f(48_000, 24_000)).toThrow(RangeError);
      expect(() => f(Number.NaN, 1000)).toThrow(RangeError);
    }
  });
});

describe('peaking (RBJ peaking EQ, duck plan T115)', () => {
  it.each([10, -9])('is %d dB ±0.05 dB on a 1 kHz sine at its centre (48 kHz, Q 2; acceptance 1)', (g) => {
    const measured = gainDb(() => peaking(48_000, 1000, g, 2), 48_000, 1000);
    expect(Math.abs(measured - g)).toBeLessThanOrEqual(0.05);
  });

  it('peakingCoefficients: exactly gainDb at f0, 0 dB at DC and Nyquist, falling off monotonically below f0', () => {
    for (const [fs, f0, g, q] of [
      [48_000, 1600, 10, 3],
      [48_000, 700, -9, 1.4],
      [44_100, 3100, 6, 2.5],
      [16_000, 3100, 6, 2.5],
    ] as const) {
      const c = peakingCoefficients(fs, f0, g, q);
      expect(Math.abs(responseDb(c, fs, f0) - g)).toBeLessThan(1e-9);
      expect(Math.abs((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2) - 1)).toBeLessThan(1e-12);
      expect(Math.abs((c.b0 - c.b1 + c.b2) / (1 - c.a1 + c.a2) - 1)).toBeLessThan(1e-12);
      expect(c.a1).toBe(c.b1);
      let prev = Math.abs(g);
      for (const r of [0.9, 0.7, 0.5, 0.25, 0.1]) {
        const now = Math.abs(responseDb(c, fs, f0 * r));
        expect(now).toBeLessThan(prev);
        prev = now;
      }
    }
  });

  it('gainDb 0 is the identity (b = a, bit-exact output)', () => {
    const c = peakingCoefficients(48_000, 1600, 0, 3);
    expect([c.b0, c.b1, c.b2]).toEqual([1, c.a1, c.a2]);
    const x = noise(4800, 9);
    expect(firstMismatch(peaking(48_000, 1600, 0, 3).process(x), df2t(c, x))).toBe(-1);
  });

  it('the factory runs exactly its coefficients (bit-exact on noise)', () => {
    const x = noise(4800, 10);
    const ref = df2t(peakingCoefficients(44_100, 700, -9, 1.4), x);
    expect(firstMismatch(peaking(44_100, 700, -9, 1.4).process(x), ref)).toBe(-1);
  });

  it('is stable: impulse-response energy in samples 48000…96000 < 1e-12', () => {
    const y = peaking(48_000, 1600, 10, 3).process(impulse(96_000));
    let e = 0;
    for (let i = 48_000; i < 96_000; i++) e += y[i]! * y[i]!;
    expect(e).toBeLessThan(1e-12);
  });

  it('rejects invalid parameters with RangeError', () => {
    expect(() => peaking(48_000, 0, 6, 1)).toThrow(RangeError);
    expect(() => peaking(48_000, 24_000, 6, 1)).toThrow(RangeError);
    expect(() => peaking(Number.NaN, 1000, 6, 1)).toThrow(RangeError);
    expect(() => peaking(48_000, 1000, 6, 0)).toThrow(RangeError);
    expect(() => peaking(48_000, 1000, 6, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => peaking(48_000, 1000, Number.NaN, 1)).toThrow(RangeError);
    expect(() => peakingCoefficients(48_000, 1000, Number.NEGATIVE_INFINITY, 1)).toThrow(RangeError);
  });
});
