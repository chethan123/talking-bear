import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import {
  butterworthHighpass,
  butterworthHighpassCoefficients,
  butterworthLowpass,
  butterworthLowpassCoefficients,
  peaking,
  peakingCoefficients,
  type BiquadCoefficients,
} from './biquad.ts';
import { DUCK, DUCK_TUNE_BOUNDS, duckStage, LP_SECTIONS, softenDuck, type DuckParams } from './duck.ts';
import { createRealFft } from './fft.ts';
import { resampleOffline } from './resample.ts';
import { DUCK_PITCH_RATIO } from './types.ts';
import { hpfTrim, SAMPLE_LIMIT } from './voice.ts';

/** Float32 bit patterns, so comparisons are bit-exact. */
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

function maxAbs(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

function noise(n: number, seed: number, amp = 1): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (rand() * 2 - 1);
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

const CORPUS = fileURLToPath(new URL('../../test/corpus/speech/', import.meta.url));
const FS = 48_000;

/** sentence-00-r0 upsampled to 48 kHz and pitched up as the chain does (plain = sinc p DUCK_PITCH_RATIO). */
function plainSentence(): Float32Array {
  const w = readWav(readFileSync(`${CORPUS}sentence-00-r0.wav`));
  const x = resampleOffline(w.channels[0]!, FS / w.sampleRate);
  return resampleOffline(hpfTrim(x, FS, false), 1 / DUCK_PITCH_RATIO);
}

/** The 8 corners of DUCK_TUNE_BOUNDS over amHz × amMix × peak1Db (p doesn't enter the stage). */
function boundCorners(): Array<Readonly<DuckParams>> {
  const out: Array<Readonly<DuckParams>> = [];
  for (const amHz of DUCK_TUNE_BOUNDS.amHz)
    for (const amMix of DUCK_TUNE_BOUNDS.amMix)
      for (const peak1Db of DUCK_TUNE_BOUNDS.peak1Db) out.push({ ...DUCK, amHz, amMix, peak1Db });
  return out;
}

const label = (d: Readonly<DuckParams>): string => `amHz ${d.amHz} amMix ${d.amMix} peak1Db ${d.peak1Db}`;

/** DUCK, softenDuck(DUCK) and the 8 bound corners (acceptance 2). */
const PARAM_SETS: ReadonlyArray<readonly [string, Readonly<DuckParams>]> = [
  ['DUCK', DUCK],
  ['softenDuck(DUCK)', softenDuck(DUCK)],
  ...boundCorners().map((d) => [`corner ${label(d)}`, d] as const),
];

/** Product of the analytic magnitudes of the 8 sections, in dB. */
function analyticDb(d: Readonly<DuckParams>, fs: number, f: number): number {
  const sections = [
    butterworthHighpassCoefficients(fs, d.hpHz),
    peakingCoefficients(fs, d.dipHz, d.dipDb, d.dipQ),
    peakingCoefficients(fs, d.peak1Hz, d.peak1Db, d.peak1Q),
    peakingCoefficients(fs, d.peak2Hz, d.peak2Db, d.peak2Q),
  ];
  for (let k = 0; k < LP_SECTIONS; k++) sections.push(butterworthLowpassCoefficients(fs, d.lpHz));
  expect(sections).toHaveLength(8);
  return sections.reduce((db, c) => db + responseDb(c, fs, f), 0);
}

/** Inputs for the shaper bound (acceptance 5). */
const shaperInputs = (): ReadonlyArray<readonly [string, Float32Array]> => [
  ['sentence-00-r0 (plain p 1.45)', plainSentence()],
  ['white noise', noise(24_000, 1)],
  ['loud 3 kHz tone', sine(3000, FS, 0.5, 0.95)],
  ['near-square 440 Hz', sine(440, FS, 0.5, 1).map((v) => Math.max(-0.3, Math.min(0.3, v)))],
];

const inside = (v: number, [lo, hi]: readonly [number, number]): boolean => v >= lo && v <= hi;

describe('parameters', () => {
  it('DUCK is the frozen §3.1.2 parameter set and LP_SECTIONS is 4', () => {
    expect(DUCK).toEqual({
      amHz: 70,
      amMix: 0.35,
      hpHz: 320,
      dipHz: 700,
      dipQ: 1.4,
      dipDb: -9,
      peak1Hz: 1600,
      peak1Q: 3,
      peak1Db: 10,
      peak2Hz: 3100,
      peak2Q: 2.5,
      peak2Db: 6,
      lpHz: 5000,
      shapeMix: 1,
    });
    expect(Object.isFrozen(DUCK)).toBe(true);
    expect(LP_SECTIONS).toBe(4);
    expect(DUCK_PITCH_RATIO).toBe(1.45);
  });

  it('DUCK_TUNE_BOUNDS are p 1.30–1.60, amHz 60–80, amMix 0.20–0.40, peak1Db 6–12, and contain DUCK', () => {
    expect(DUCK_TUNE_BOUNDS).toEqual({ p: [1.3, 1.6], amHz: [60, 80], amMix: [0.2, 0.4], peak1Db: [6, 12] });
    expect(Object.isFrozen(DUCK_TUNE_BOUNDS)).toBe(true);
    expect(Object.isFrozen(DUCK_TUNE_BOUNDS.p)).toBe(true);
    expect(inside(DUCK_PITCH_RATIO, DUCK_TUNE_BOUNDS.p)).toBe(true);
    expect(inside(DUCK.amHz, DUCK_TUNE_BOUNDS.amHz)).toBe(true);
    expect(inside(DUCK.amMix, DUCK_TUNE_BOUNDS.amMix)).toBe(true);
    expect(inside(DUCK.peak1Db, DUCK_TUNE_BOUNDS.peak1Db)).toBe(true);
  });

  it('softenDuck lowers amMix by 0.15 (floor 0.05) and peak1Db by 4 (floor 2), keeps the rest, returns a new frozen object', () => {
    const s = softenDuck(DUCK);
    expect(s).not.toBe(DUCK);
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.amMix).toBeCloseTo(0.2, 12);
    expect(s.peak1Db).toBe(6);
    expect({ ...s, amMix: DUCK.amMix, peak1Db: DUCK.peak1Db }).toEqual(DUCK);
    const floored = softenDuck({ ...DUCK, amMix: 0.1, peak1Db: 4 });
    expect(floored.amMix).toBe(0.05);
    expect(floored.peak1Db).toBe(2);
    expect(DUCK.amMix).toBe(0.35); // the input is not touched
  });
});

describe('duckStage alias (acceptance 2)', () => {
  const N = 65_536;
  const START = 8192;
  const LENGTH = START + N; // 73 728
  const RAMP = 2048;
  const TONES = [1130, 2310, 3710, 4930, 6130, 7310, 8000, 8500, 9000, 10_000, 11_330, 13_700, 17_990];
  const RATES = [44_100, 48_000];
  const LIMIT_DBFS = -60;

  // 4-term Blackman-Harris window and a reusable 65 536-point real FFT (src/dsp/fft.ts).
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    win[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
  }
  const fft = createRealFft(N);
  const buf = new Float32Array(N);
  const re = new Float32Array(N / 2 + 1);
  const im = new Float32Array(N / 2 + 1);
  const power = new Float64Array(N / 2 + 1);
  function spectrum(y: Float32Array): Float64Array {
    for (let i = 0; i < N; i++) buf[i] = y[i]! * win[i]!;
    fft.forward(buf, re, im);
    for (let k = 0; k <= N / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    return power;
  }
  // Total windowed energy of a full-scale sine (the 0 dBFS reference).
  const fullScale = ((): number => {
    const p = spectrum(sine(1234.5, 48_000, N / 48_000, 1));
    let s = 0;
    for (let k = 0; k < p.length; k++) s += p[k]!;
    return s;
  })();

  /** Energy (dBFS) in bins from 50 Hz to Nyquist outside ±8 bins of every k·f ± j·amHz (k ≥ 1, j = 0…3). */
  function aliasDbfs(d: Readonly<DuckParams>, fs: number, f: number): number {
    const x = new Float32Array(LENGTH);
    const w = (2 * Math.PI * f) / fs;
    for (let i = 0; i < LENGTH; i++) {
      x[i] = 0.5 * Math.sin(w * i) * (i < RAMP ? 0.5 - 0.5 * Math.cos((Math.PI * i) / RAMP) : 1);
    }
    const p = spectrum(duckStage(x, fs, d).subarray(START, LENGTH));
    const bin = fs / N;
    const tol = 8 * bin;
    let other = 0;
    for (let k = Math.ceil(50 / bin); k < p.length; k++) {
      const hz = k * bin;
      let wanted = false;
      for (let j = -3; j <= 3 && !wanted; j++) {
        const h = hz - j * d.amHz;
        const m = Math.round(h / f);
        wanted = m >= 1 && Math.abs(h - m * f) <= tol;
      }
      if (!wanted) other += p[k]!;
    }
    return 10 * Math.log10(other / fullScale + 1e-30);
  }

  it.each(PARAM_SETS)('%s: ≤ −60 dBFS for 13 tones at 44.1 and 48 kHz', (_name, d) => {
    let worst = -Infinity;
    let at = '';
    for (const fs of RATES) {
      for (const f of TONES) {
        const db = aliasDbfs(d, fs, f);
        if (db > worst) {
          worst = db;
          at = `fs ${fs} f ${f}`;
        }
      }
    }
    expect(worst, `worst ${worst.toFixed(1)} dBFS at ${at}`).toBeLessThanOrEqual(LIMIT_DBFS);
  });

  it('the meter sees aliasing: without the low-pass, an 8 kHz tone at 44.1 kHz aliases above −60 dBFS', () => {
    // Negative control: four "low-pass" sections at 0.45·fs leave 3f = 24 kHz to fold back to 20.1 kHz.
    expect(aliasDbfs({ ...DUCK, lpHz: 0.45 * 44_100 }, 44_100, 8000)).toBeGreaterThan(LIMIT_DBFS);
  });
});

describe('duckStage EQ response (acceptance 3)', () => {
  const FREQS = [300, 700, 1600, 3100, 5000, 8000];

  it.each([
    ['DUCK', DUCK],
    ['softenDuck(DUCK)', softenDuck(DUCK)],
    ['peak1Db 12', { ...DUCK, peak1Db: 12 }],
  ] as const)(
    '%s with amMix 0, shapeMix 0: the steady-state sine gain matches the 8 sections ±0.1 dB',
    (_n, base) => {
      const d = { ...base, amMix: 0, shapeMix: 0 };
      for (const fs of [44_100, 48_000]) {
        for (const f of FREQS) {
          const x = sine(f, fs, 1);
          const y = duckStage(x, fs, d);
          const from = x.length - Math.round(0.5 * fs);
          const measured = toneLevelDb(y, f, fs, from, x.length) - toneLevelDb(x, f, fs, from, x.length);
          const expected = analyticDb(d, fs, f);
          expect(
            Math.abs(measured - expected),
            `fs ${fs} f ${f}: ${measured} vs ${expected}`,
          ).toBeLessThanOrEqual(0.1);
        }
      }
    },
  );
});

describe('duckStage AM (acceptance 4)', () => {
  it.each(PARAM_SETS)(
    '%s: a 2 kHz sine gets sidebands at 2000 ± amHz at (amMix/2)/(1 − amMix) ±0.3 dB',
    (_n, base) => {
      for (const fs of [44_100, 48_000]) {
        const d = { ...base, hpHz: 1, dipDb: 0, peak1Db: 0, peak2Db: 0, lpHz: 0.45 * fs, shapeMix: 0 };
        const x = sine(2000, fs, 2);
        const y = duckStage(x, fs, d);
        const from = Math.round(fs);
        const carrier = toneLevelDb(y, 2000, fs, from, y.length);
        const expected = 20 * Math.log10(d.amMix / 2 / (1 - d.amMix));
        for (const f of [2000 - d.amHz, 2000 + d.amHz]) {
          const rel = toneLevelDb(y, f, fs, from, y.length) - carrier;
          expect(Math.abs(rel - expected), `fs ${fs} ${f} Hz: ${rel} vs ${expected}`).toBeLessThanOrEqual(
            0.3,
          );
        }
      }
    },
  );

  it('DUCK sidebands are −11.4 dB re the carrier', () => {
    expect(20 * Math.log10(DUCK.amMix / 2 / (1 - DUCK.amMix))).toBeCloseTo(-11.4, 1);
  });
});

describe('duckStage shaper and buffers (acceptance 5)', () => {
  it('max|out| ≤ max|in after EQ| (shapeMix 0) for DUCK, shapeMix 0.5 and the corners', () => {
    for (const [name, x] of shaperInputs()) {
      for (const d of [DUCK, { ...DUCK, shapeMix: 0.5 }, ...boundCorners()]) {
        const eq = maxAbs(duckStage(x, FS, { ...d, shapeMix: 0 }));
        const out = maxAbs(duckStage(x, FS, d));
        expect(out, `${name} ${label(d)} shapeMix ${d.shapeMix}`).toBeLessThanOrEqual(eq);
        expect(out).toBeGreaterThan(0);
      }
    }
  });

  it('the clamp holds |out| ≤ peak even where the mix would overshoot (shapeMix 2)', () => {
    const x = sine(1600, FS, 0.25, 0.5);
    const eq = maxAbs(duckStage(x, FS, { ...DUCK, shapeMix: 0 }));
    const y = duckStage(x, FS, { ...DUCK, shapeMix: 2 });
    expect(maxAbs(y)).toBeLessThanOrEqual(eq);
    // Both signs reach the clamp.
    let atTop = 0;
    let atBottom = 0;
    for (let i = 0; i < y.length; i++) {
      if (y[i] === Math.fround(eq)) atTop++;
      if (y[i] === -Math.fround(eq)) atBottom++;
    }
    expect(atTop).toBeGreaterThan(1);
    expect(atBottom).toBeGreaterThan(1);
  });

  it('an all-zero input returns all zeros, of the same length', () => {
    for (const n of [0, 1, 7, 4800]) {
      const y = duckStage(new Float32Array(n), FS);
      expect(y.length).toBe(n);
      expect(y.every((v) => v === 0)).toBe(true);
    }
  });

  it('the output is a new buffer of the input length, and y is never modified', () => {
    for (const n of [1, 2, 3, 1000, 48_001]) {
      const x = noise(n, n, 0.5);
      const copy = x.slice();
      const y = duckStage(x, FS);
      expect(y).not.toBe(x);
      expect(y.buffer).not.toBe(x.buffer);
      expect(y.length).toBe(n);
      expect(firstMismatch(x, copy)).toBe(-1);
    }
  });

  it('is finite for finite input up to ±SAMPLE_LIMIT (the bound hpfTrim gives the chain)', () => {
    fc.assert(
      fc.property(
        fc.float32Array({
          min: -Math.fround(SAMPLE_LIMIT),
          max: Math.fround(SAMPLE_LIMIT),
          noNaN: true,
          minLength: 1,
          maxLength: 2000,
        }),
        fc.constantFrom(44_100, 48_000, 16_000),
        (x, fs) => {
          const y = duckStage(x, fs);
          expect(y.length).toBe(x.length);
          expect(y.every((v) => Number.isFinite(v))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
    const extremes = new Float32Array(4800);
    for (let i = 0; i < extremes.length; i++) extremes[i] = i % 3 === 0 ? SAMPLE_LIMIT : -SAMPLE_LIMIT;
    expect(duckStage(extremes, FS).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('duckStage chain order and determinism (acceptance 6)', () => {
  it('equals AM → HPF → dip → peak1 → peak2 → 4× LPF → peak-normalised cubic, bit for bit', () => {
    const x = plainSentence();
    for (const [, d] of PARAM_SETS) {
      for (const fs of [44_100, 48_000]) {
        const z = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++)
          z[i] = x[i]! * (1 - d.amMix + d.amMix * Math.sin(((2 * Math.PI * d.amHz) / fs) * i));
        butterworthHighpass(fs, d.hpHz).process(z, z);
        peaking(fs, d.dipHz, d.dipDb, d.dipQ).process(z, z);
        peaking(fs, d.peak1Hz, d.peak1Db, d.peak1Q).process(z, z);
        peaking(fs, d.peak2Hz, d.peak2Db, d.peak2Q).process(z, z);
        for (let k = 0; k < 4; k++) butterworthLowpass(fs, d.lpHz).process(z, z);
        const peak = maxAbs(z);
        for (let i = 0; i < z.length; i++) {
          const u = z[i]! / peak;
          z[i] = Math.min(peak, Math.max(-peak, 1.5 * peak * (u - (u * u * u) / 3)));
        }
        expect(firstMismatch(duckStage(x, fs, d), z), `${label(d)} fs ${fs}`).toBe(-1);
      }
    }
  });

  it('the same input twice is bit-identical, and the default parameters are DUCK', () => {
    const x = plainSentence();
    const a = duckStage(x, FS);
    const b = duckStage(x, FS);
    expect(firstMismatch(a, b)).toBe(-1);
    expect(firstMismatch(duckStage(x, FS, DUCK), a)).toBe(-1);
    const n = noise(10_000, 77, 0.3);
    expect(
      firstMismatch(duckStage(n, 44_100, softenDuck(DUCK)), duckStage(n, 44_100, softenDuck(DUCK))),
    ).toBe(-1);
  });
});

describe('duckStage errors (acceptance 7)', () => {
  it('throws RangeError for fs < 16 000 or non-finite fs', () => {
    const x = new Float32Array(100);
    for (const fs of [
      15_999,
      8000,
      0,
      -48_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => duckStage(x, fs), `fs ${fs}`).toThrow(RangeError);
    }
    expect(() => duckStage(x, 16_000)).not.toThrow();
  });

  it('throws RangeError (from biquad.ts) for a filter frequency outside (0, fs/2) or a bad Q or gain', () => {
    const x = new Float32Array(100);
    expect(() => duckStage(x, FS, { ...DUCK, lpHz: 24_000 })).toThrow(RangeError);
    expect(() => duckStage(x, FS, { ...DUCK, hpHz: 0 })).toThrow(RangeError);
    expect(() => duckStage(x, FS, { ...DUCK, peak1Q: 0 })).toThrow(RangeError);
    expect(() => duckStage(x, FS, { ...DUCK, dipDb: Number.NaN })).toThrow(RangeError);
  });
});
