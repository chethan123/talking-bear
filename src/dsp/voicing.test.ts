import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, sine } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import { createGateFilter } from './energy-gate.ts';
import { resampleOffline } from './resample.ts';
import { VOICED_THRESHOLD, createVoicing } from './voicing.ts';

const FS = 16000;
/** 10 ms hop and 32 ms window at 16 kHz (plan §4.2.1 step 5). */
const HOP = 160;
const WIN = 512;
/** Fixture rate; the fixtures' 16 kHz versions are resampleOffline(x, 1 / 3). */
const FIXTURE_FS = 48000;
const FIXTURES = new URL('../../test/fixtures/', import.meta.url);

/**
 * The issue's formula, written out literally: for each lag, all three sums over n = 0 … N−τ−1, then the
 * maximum clamped to [0, 1]; 0 when Σ x[n]² over the window is below 1e-10.
 */
function referenceScore(x: Float32Array, fs = FS, fminHz = 70, fmaxHz = 600): number {
  const n = x.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i]! * x[i]!;
  if (energy < 1e-10) return 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let lag = Math.floor(fs / fmaxHz); lag <= Math.ceil(fs / fminHz) && lag < n; lag++) {
    let num = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i <= n - lag - 1; i++) {
      num += x[i]! * x[i + lag]!;
      e0 += x[i]! * x[i]!;
      e1 += x[i + lag]! * x[i + lag]!;
    }
    best = Math.max(best, num / Math.sqrt(e0 * e1 + 1e-12));
  }
  return Math.min(1, Math.max(0, best));
}

/** Zeros with unit pulses at the given indices. */
function pulses(n: number, at: number[], amp = 1): Float32Array {
  const x = new Float32Array(n);
  for (const i of at) x[i] = amp;
  return x;
}

/** Σ x[n]², accumulated in float64 from the stored float32 values. */
function energyOf(x: Float32Array): number {
  let e = 0;
  for (const v of x) e += v * v;
  return e;
}

/** The worker's gate path for a 48 kHz signal: resampleOffline(x, 1/3), then createGateFilter(16000), streamed from sample 0. */
function gatePath(x48: Float32Array): Float32Array {
  return createGateFilter(FS).process(resampleOffline(x48, 1 / 3));
}

/**
 * The windows the worker scores: at every 10 ms hop boundary e = 160·k (e ≥ 512), the most recent 512 samples
 * [e − 512, e). Only windows lying fully inside [from, to) are returned.
 */
function hopWindows(y: Float32Array, from = 0, to = y.length): Float32Array[] {
  const out: Float32Array[] = [];
  for (let e = HOP * Math.ceil(WIN / HOP); e <= y.length; e += HOP) {
    if (e - WIN >= from && e <= to) out.push(y.subarray(e - WIN, e));
  }
  return out;
}

function scoresOf(windows: Float32Array[], fs = FS): number[] {
  const v = createVoicing(fs);
  return windows.map((w) => v.score(w));
}

function fraction(scores: number[], pass: (s: number) => boolean): number {
  return scores.filter(pass).length / scores.length;
}

interface Fixture {
  x: Float32Array;
  speech: { start: number; end: number }[];
}

function fixture(name: string): Fixture {
  const wav = readWav(readFileSync(new URL(`${name}.wav`, FIXTURES)));
  const label: Pick<Fixture, 'speech'> = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
  expect(wav.sampleRate).toBe(FIXTURE_FS);
  expect(wav.channels).toHaveLength(1);
  return { x: wav.channels[0]!, speech: label.speech };
}

/** A 48 kHz sample index as the first 16 kHz output index at or after it (output j sits at input 3j). */
function to16k(i48: number): number {
  return Math.ceil(i48 / 3);
}

/** [first, last + 1) of the non-zero samples: the sound between a fixture's leading and trailing digital zeros. */
function soundSpan(x: Float32Array): [number, number] {
  let a = 0;
  while (a < x.length && x[a] === 0) a++;
  let b = x.length;
  while (b > a && x[b - 1] === 0) b--;
  return [a, b];
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

describe('VOICED_THRESHOLD', () => {
  it('is 0.5 (plan §4.2.1 step 5)', () => {
    expect(VOICED_THRESHOLD).toBe(0.5);
  });
});

describe('createVoicing: the formula', () => {
  const rng = mulberry32(34);
  const noise = (n: number, amp: number): Float32Array => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * (2 * rng() - 1);
    return x;
  };
  const periodicPlusNoise = (n: number, period: number, noiseAmp: number): Float32Array => {
    const x = noise(n, noiseAmp);
    for (let i = 0; i < n; i++) x[i] = x[i]! + 0.5 * Math.sin((2 * Math.PI * i) / period);
    return x;
  };
  const cases: { name: string; fs: number; fmin: number; fmax: number; windows: Float32Array[] }[] = [
    {
      name: 'defaults, 512-sample windows',
      fs: 16000,
      fmin: 70,
      fmax: 600,
      windows: [
        noise(512, 0.3),
        noise(512, 1e-3),
        periodicPlusNoise(512, 80, 0.05),
        periodicPlusNoise(512, 114.3, 0.2),
        periodicPlusNoise(512, 228.6, 0.1),
      ],
    },
    {
      name: '8 kHz, 256-sample windows',
      fs: 8000,
      fmin: 70,
      fmax: 600,
      windows: [noise(256, 0.3), periodicPlusNoise(256, 40, 0.05), periodicPlusNoise(256, 57.1, 0.2)],
    },
    {
      name: '16 kHz, F0 100–400 Hz, odd lengths',
      fs: 16000,
      fmin: 100,
      fmax: 400,
      windows: [noise(300, 0.3), periodicPlusNoise(333, 45, 0.1), periodicPlusNoise(170, 60, 0.1)],
    },
  ];
  for (const { name, fs, fmin, fmax, windows } of cases) {
    it(`matches the literal formula (${name})`, () => {
      const v = createVoicing(fs, fmin, fmax);
      for (const w of windows) expect(v.score(w)).toBeCloseTo(referenceScore(w, fs, fmin, fmax), 12);
    });
  }

  it('defaults to fs 16000, F0 70–600 Hz', () => {
    const a = createVoicing();
    const b = createVoicing(16000, 70, 600);
    for (const w of [noise(512, 0.3), periodicPlusNoise(512, 100, 0.1)]) expect(a.score(w)).toBe(b.score(w));
  });

  // Two unit pulses d samples apart: only lag d has a non-zero numerator, so the score is > 0 exactly when d
  // is inside the lag range.
  const lagCases: {
    fs: number;
    fmin: number;
    fmax: number;
    n: number;
    inside: number[];
    outside: number[];
  }[] = [
    // floor(16000 / 600) = 26, ceil(16000 / 70) = 229
    { fs: 16000, fmin: 70, fmax: 600, n: 512, inside: [26, 27, 228, 229], outside: [25, 230] },
    // floor(8000 / 600) = 13, ceil(8000 / 70) = 115
    { fs: 8000, fmin: 70, fmax: 600, n: 256, inside: [13, 115], outside: [12, 116] },
    // floor(16000 / 400) = 40, ceil(16000 / 100) = 160
    { fs: 16000, fmin: 100, fmax: 400, n: 512, inside: [40, 160], outside: [39, 161] },
  ];
  for (const { fs, fmin, fmax, n, inside, outside } of lagCases) {
    it(`searches lags floor(fs/fmax) … ceil(fs/fmin) (fs ${fs}, F0 ${fmin}–${fmax} Hz)`, () => {
      const v = createVoicing(fs, fmin, fmax);
      for (const d of inside) expect(v.score(pulses(n, [100, 100 + d])), `d = ${d}`).toBeGreaterThan(0.25);
      for (const d of outside) expect(v.score(pulses(n, [100, 100 + d])), `d = ${d}`).toBe(0);
    });
  }

  it('normalises each lag over its own index ranges', () => {
    // Pulses at 100 and 329 (d = 229): at τ = 229 the head range is n = 0 … 282 (holds 100 only) and the
    // shifted range n + τ = 229 … 511 holds 329 only, so r(229) = 1 / sqrt(1 · 1 + 1e-12). Normalising by the
    // whole-window energy (2) would give 0.5.
    expect(createVoicing().score(pulses(WIN, [100, 329]))).toBeCloseTo(1, 9);
    // Both pulses inside both ranges: r(100) = 1 / sqrt(2 · 2) = 0.5.
    expect(createVoicing().score(pulses(WIN, [200, 300]))).toBeCloseTo(0.5, 9);
  });

  it('is 1, clamped to at most 1, for exactly periodic windows', () => {
    // 1000 windows repeating a random cycle. Rounding puts the unclamped peak r(period) at 1 + 2.2e-16 for a few
    // of them (8 of these 1000), so this also exercises the upper clamp.
    const v = createVoicing();
    const x = new Float32Array(WIN);
    for (const period of [80, 100, 128, 160, 200]) {
      for (let seed = 1; seed <= 200; seed++) {
        const cycleRng = mulberry32(seed);
        const cycle = new Float32Array(period);
        for (let i = 0; i < period; i++) cycle[i] = 0.5 * (2 * cycleRng() - 1);
        for (let i = 0; i < WIN; i++) x[i] = cycle[i % period]!;
        const s = v.score(x);
        expect(s, `period ${period}, seed ${seed}`).toBeLessThanOrEqual(1);
        expect(s, `period ${period}, seed ${seed}`).toBeGreaterThan(1 - 1e-9);
      }
    }
  });

  it('is in [0, 1] for any window, including non-finite samples (property)', () => {
    const v = createVoicing();
    fc.assert(
      fc.property(fc.float32Array({ minLength: 0, maxLength: 600, size: 'max' }), (x) => {
        const s = v.score(x);
        return Number.isFinite(s) && s >= 0 && s <= 1;
      }),
    );
  });

  it('matches the literal formula on arbitrary finite windows (property)', () => {
    const v = createVoicing();
    fc.assert(
      fc.property(
        fc.float32Array({
          minLength: 0,
          maxLength: 600,
          size: 'max',
          noDefaultInfinity: true,
          noNaN: true,
          min: -1,
          max: 1,
        }),
        (x) => Math.abs(v.score(x) - referenceScore(x)) <= 1e-9,
      ),
    );
  });
});

describe('createVoicing: energy guard, silence and bad input', () => {
  it('scores 0 when the window energy Σ x[n]² is below 1e-10, and computes above it', () => {
    const v = createVoicing();
    const below = pulses(WIN, [200, 300], Math.fround(Math.sqrt(0.98e-10 / 2)));
    const above = pulses(WIN, [200, 300], Math.fround(Math.sqrt(1.02e-10 / 2)));
    expect(energyOf(below)).toBeLessThan(1e-10);
    expect(energyOf(above)).toBeGreaterThan(1e-10);
    expect(v.score(below)).toBe(0);
    expect(v.score(above)).toBeGreaterThan(0);
  });

  it('scores 0 for an all-zero window and an empty or too-short window', () => {
    const v = createVoicing();
    expect(v.score(new Float32Array(WIN))).toBe(0);
    expect(v.score(new Float32Array(0))).toBe(0);
    // 26 samples: the smallest lag (26) has no terms.
    expect(v.score(pulses(26, [0, 25]))).toBe(0);
  });

  it('scores 0 for a window holding a NaN or ±Infinity sample', () => {
    const v = createVoicing();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const x = pulses(WIN, [100, 200]);
      x[300] = bad;
      expect(v.score(x), String(bad)).toBe(0);
      // In a 300-sample window, r(200) sums over n = 0 … 99 and n + τ = 200 … 299 only: a bad sample at 150
      // is in neither range, and the pulses at 50 and 250 alone would give r(200) = 1.
      const y = pulses(300, [50, 250]);
      expect(v.score(y)).toBeCloseTo(1, 9);
      y[150] = bad;
      expect(v.score(y), `${bad} outside the lag's ranges`).toBe(0);
    }
  });

  it('throws RangeError for invalid parameters', () => {
    const bad: [number, number, number][] = [
      [0, 70, 600],
      [-16000, 70, 600],
      [Number.NaN, 70, 600],
      [Number.POSITIVE_INFINITY, 70, 600],
      [16000, 0, 600],
      [16000, -70, 600],
      [16000, Number.NaN, 600],
      [16000, 600, 600],
      [16000, 600, 70],
      [16000, 70, 8001],
      [16000, 70, Number.NaN],
    ];
    for (const [fs, fmin, fmax] of bad) {
      expect(() => createVoicing(fs, fmin, fmax), `${fs} ${fmin} ${fmax}`).toThrow(RangeError);
    }
    expect(() => createVoicing(16000, 70, 8000)).not.toThrow();
  });
});

describe('createVoicing: no allocation per call', () => {
  it('the counter sees typed-array allocations (positive control)', () => {
    expect(countAllocations(() => void new Float64Array(4))).toBe(1);
    const x = new Float32Array(4);
    expect(countAllocations(() => void x.subarray(1))).toBeGreaterThan(0);
  });

  it('score() allocates nothing', () => {
    const v = createVoicing();
    const rng = mulberry32(7);
    const x = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * i) / 90) + 0.1 * (2 * rng() - 1);
    const silent = new Float32Array(WIN);
    const v8k = createVoicing(8000);
    const x8k = x.subarray(0, 256);
    let sum = 0;
    const count = countAllocations(() => {
      for (let k = 0; k < 50; k++) sum += v.score(x) + v.score(silent) + v8k.score(x8k);
    });
    expect(count).toBe(0);
    expect(sum).toBeGreaterThan(50);
  });
});

describe('Validation on the gate path (48 kHz → resampleOffline(x, 1/3) → createGateFilter(16000), 10 ms hops)', () => {
  it('1a: a 200 Hz sine scores > 0.95 in every window', () => {
    const scores = scoresOf(hopWindows(gatePath(sine(200, FIXTURE_FS, 1, 0.5))));
    expect(scores.length).toBe(97);
    expect(Math.min(...scores)).toBeGreaterThan(0.95);
  });

  it('1b: a 100 Hz sawtooth scores > 0.9 in every window', () => {
    const period = FIXTURE_FS / 100;
    const saw = new Float32Array(FIXTURE_FS);
    for (let i = 0; i < saw.length; i++) saw[i] = 0.5 * ((2 * (i % period)) / period - 1);
    const scores = scoresOf(hopWindows(gatePath(saw)));
    expect(scores.length).toBe(97);
    expect(Math.min(...scores)).toBeGreaterThan(0.9);
  });

  for (const name of ['vowel_f0-140', 'vowel_f0-300']) {
    it(`2: ${name}: ≥ 80 % of the windows fully inside the speech span score > 0.5`, () => {
      const { x, speech } = fixture(name);
      expect(speech).toHaveLength(1);
      const { start, end } = speech[0]!;
      const windows = hopWindows(gatePath(x), to16k(start), to16k(end));
      expect(windows.length).toBe(147);
      expect(fraction(scoresOf(windows), (s) => s > VOICED_THRESHOLD)).toBeGreaterThanOrEqual(0.8);
    });
  }

  // The fixtures carry 1 s of leading and 0.3 s of trailing digital zeros (scripts/gen-fixtures.ts); only the
  // windows fully inside the noise itself are counted, since silent windows would score 0 and pad the ratio.
  const noiseCases = [
    { name: 'noise_pink_-40dbfs_5s', seconds: 5, windows: 497, below: 0.5, atLeast: 0.95 },
    { name: 'noise_white_-60dbfs_3s', seconds: 3, windows: 297, below: 0.3, atLeast: 0.99 },
  ];
  for (const { name, seconds, windows: expectedWindows, below, atLeast } of noiseCases) {
    it(`3: ${name}: ≥ ${atLeast * 100} % of the noise windows score < ${below}`, () => {
      const { x } = fixture(name);
      const [a, b] = soundSpan(x);
      expect([a, b]).toEqual([FIXTURE_FS, FIXTURE_FS * (1 + seconds)]);
      const windows = hopWindows(gatePath(x), to16k(a), to16k(b));
      expect(windows.length).toBe(expectedWindows);
      expect(fraction(scoresOf(windows), (s) => s < below)).toBeGreaterThanOrEqual(atLeast);
    });
  }

  it('4: silence scores 0 (silence_2s, every window)', () => {
    const scores = scoresOf(hopWindows(gatePath(fixture('silence_2s').x)));
    expect(scores.length).toBeGreaterThan(300);
    expect(scores.every((s) => s === 0)).toBe(true);
  });

  it('createVoicing(8000) on 256-sample windows (the processVoice use): a 200 Hz sine is voiced', () => {
    const x = sine(200, 8000, 0.5, 0.5);
    const v = createVoicing(8000);
    for (let from = 0; from + 256 <= x.length; from += 160) {
      expect(v.score(x.subarray(from, from + 256))).toBeGreaterThan(0.95);
    }
  });

  it('5: cost per call (informational)', () => {
    const { x, speech } = fixture('vowel_f0-140');
    const windows = hopWindows(gatePath(x), to16k(speech[0]!.start), to16k(speech[0]!.end));
    const v = createVoicing();
    let sum = 0;
    for (let k = 0; k < 2000; k++) sum += v.score(windows[k % windows.length]!);
    const calls = 5000;
    const t0 = performance.now();
    for (let k = 0; k < calls; k++) sum += v.score(windows[k % windows.length]!);
    const us = ((performance.now() - t0) * 1000) / calls;
    console.log(`[T34 timing] voicing.score, 512 samples at 16 kHz, lags 26…229: ${us.toFixed(1)} µs/call`);
    expect(Number.isFinite(sum)).toBe(true);
    expect(us).toBeGreaterThan(0);
  });
});
