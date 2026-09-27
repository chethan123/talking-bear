import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rmsDb, sine, toneLevelDb } from '../../test/dsp-helpers.ts';
import { CUTOFF_FACTOR, DEFAULT_BETA, DEFAULT_ZERO_CROSSINGS, PHASES, resampleOffline } from './resample.ts';

/** Default cutoff c (fraction of the input Nyquist) for a ratio, exactly as the module computes it. */
function cutoffOf(ratio: number): number {
  return CUTOFF_FACTOR * Math.min(1, ratio);
}

/** L = ceil(H) = ceil(zc / c) for the default kernel. */
function halfOf(ratio: number): number {
  return Math.ceil(DEFAULT_ZERO_CROSSINGS / cutoffOf(ratio));
}

/** Steady-state middle of an output: [2·ceil(H), M − 2·ceil(H)). */
function middle(y: Float32Array, ratio: number): [number, number] {
  const edge = 2 * halfOf(ratio);
  return [edge, y.length - edge];
}

/** Test-local float64 reference of the issue's kernel formula (independent of the module's table). */
function besselI0Ref(x: number): number {
  let sum = 0;
  let fact = 1;
  for (let k = 0; k < 30; k++) {
    if (k > 0) fact *= k;
    const t = Math.pow(x / 2, k) / fact;
    sum += t * t;
  }
  return sum;
}

function hRef(t: number, c: number, zc: number, beta: number): number {
  const halfWidth = zc / c;
  const u = t / halfWidth;
  if (Math.abs(u) >= 1) return 0;
  const x = c * t;
  const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return c * sinc * (besselI0Ref(beta * Math.sqrt(1 - u * u)) / besselI0Ref(beta));
}

/** Frequency in cycles per sample from linearly interpolated zero crossings of y[from, to). */
function zeroCrossingFrequency(y: Float32Array, from: number, to: number): number {
  let count = 0;
  let first = 0;
  let last = 0;
  for (let i = from; i < to - 1; i++) {
    const a = y[i]!;
    const b = y[i + 1]!;
    if (a < 0 !== b < 0) {
      const t = i + a / (a - b);
      if (count === 0) first = t;
      last = t;
      count++;
    }
  }
  return (count - 1) / (2 * (last - first));
}

const LENGTH_RATIOS = [1 / 3, 160 / 441, 1 / 1.6, 1 / 2, 1 / 2.2, 1 / 0.75, 1 / 0.7];

/** The ratios the VAD decimator and the default voice use, with their input rates. */
const CORE_CASES = [
  { name: '48k → 16k (1/3)', ratio: 1 / 3, fsIn: 48_000 },
  { name: '44.1k → 16k (160/441)', ratio: 160 / 441, fsIn: 44_100 },
  { name: 'voice ×1.6 (1/1.6)', ratio: 1 / 1.6, fsIn: 48_000 },
];

describe('resample constants', () => {
  it('exports the kernel defaults that other modules mirror (zc 8, β 6, cutoff factor 0.9, 1024 phases)', () => {
    expect(DEFAULT_ZERO_CROSSINGS).toBe(8);
    expect(DEFAULT_BETA).toBe(6);
    expect(CUTOFF_FACTOR).toBe(0.9);
    expect(PHASES).toBe(1024);
  });
});

describe('resampleOffline', () => {
  it('[1] output length is Math.round(n * ratio) for n in [0, 5000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.constantFrom(...LENGTH_RATIOS), (n, r) => {
        // The length depends only on n and r, so the content is left at zero.
        expect(resampleOffline(new Float32Array(n), r).length).toBe(Math.round(n * r));
      }),
    );
  });

  describe('[3] passband: 4 tones up to 0.8 × cutoff stay within ±0.5 dB', () => {
    for (const { name, ratio, fsIn } of CORE_CASES) {
      it(name, () => {
        const fMax = 0.8 * cutoffOf(ratio) * (fsIn / 2);
        for (let i = 1; i <= 4; i++) {
          const f = (i / 4) * fMax;
          const x = sine(f, fsIn, 1);
          const y = resampleOffline(x, ratio);
          const [from, to] = middle(y, ratio);
          const gain = toneLevelDb(y, f, fsIn * ratio, from, to) - toneLevelDb(x, f, fsIn);
          expect(Math.abs(gain), `${f.toFixed(1)} Hz: ${gain.toFixed(3)} dB`).toBeLessThanOrEqual(0.5);
        }
      });
    }
  });

  it('[4] pitch: 300 Hz at 48 kHz through ratio 1/1.6, played at 48 kHz, is 480 Hz ± 1 %', () => {
    const ratio = 1 / 1.6;
    const y = resampleOffline(sine(300, 48_000, 1), ratio);
    const [from, to] = middle(y, ratio);
    const f = zeroCrossingFrequency(y, from, to) * 48_000;
    expect(Math.abs(f - 480) / 480, `${f.toFixed(3)} Hz`).toBeLessThanOrEqual(0.01);
  });

  it('[5] alias (voice): 18 kHz at 48 kHz through ratio 0.5 is at most −60 dBFS', () => {
    const ratio = 0.5;
    const y = resampleOffline(sine(18_000, 48_000, 1), ratio);
    const [from, to] = middle(y, ratio);
    const level = rmsDb(y, from, to);
    expect(level, `${level.toFixed(1)} dBFS`).toBeLessThanOrEqual(-60);
  });

  it('[7] upsampling: 2 kHz through ratio 1/0.75 stays within ±0.5 dB', () => {
    const ratio = 1 / 0.75;
    const x = sine(2000, 48_000, 1);
    const y = resampleOffline(x, ratio);
    const [from, to] = middle(y, ratio);
    const gain = toneLevelDb(y, 2000, 48_000 * ratio, from, to) - toneLevelDb(x, 2000, 48_000);
    expect(Math.abs(gain), `${gain.toFixed(3)} dB`).toBeLessThanOrEqual(0.5);
  });

  it('timing contract: an impulse at i = 100 gives y[j] = h(100 − j / ratio)', () => {
    for (const ratio of [1 / 3, 160 / 441, 1 / 1.6, 1 / 0.75]) {
      const x = new Float32Array(300);
      x[100] = 1;
      const y = resampleOffline(x, ratio);
      const c = cutoffOf(ratio);
      let worst = 0;
      for (let j = 0; j < y.length; j++) {
        const err = Math.abs(y[j]! - hRef(100 - j / ratio, c, DEFAULT_ZERO_CROSSINGS, DEFAULT_BETA));
        if (err > worst) worst = err;
      }
      expect(worst, `ratio ${ratio}`).toBeLessThanOrEqual(1e-5);
    }
  });

  it('throws RangeError on a non-finite or non-positive ratio', () => {
    const x = new Float32Array(16);
    for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => resampleOffline(x, r), `ratio ${r}`).toThrow(RangeError);
    }
  });

  it('throws RangeError on invalid options', () => {
    const x = new Float32Array(16);
    const bad = [
      { zeroCrossings: 0 },
      { zeroCrossings: 2.5 },
      { zeroCrossings: Number.NaN },
      { beta: -1 },
      { beta: Number.NaN },
      { beta: Number.POSITIVE_INFINITY },
      { cutoff: 0 },
      { cutoff: -0.1 },
      { cutoff: 1.1 },
      { cutoff: Number.NaN },
    ];
    for (const opts of bad) {
      expect(() => resampleOffline(x, 0.5, opts), JSON.stringify(opts)).toThrow(RangeError);
    }
    expect(resampleOffline(x, 0.5, { zeroCrossings: 4, beta: 0, cutoff: 1 }).length).toBe(8);
  });
});
