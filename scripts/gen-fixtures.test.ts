import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { mulberry32, rmsDb, toneLevelDb } from '../test/dsp-helpers.ts';
import { readWav } from '../test/wav.ts';
import type { FixtureSidecar } from './gen-fixtures.ts';
import {
  LEAD_SAMPLES,
  REPO_ROOT,
  SAMPLE_RATE,
  SEED,
  TAIL_SAMPLES,
  buildFixtures,
  encodeFixture,
} from './gen-fixtures.ts';

interface ExpectedFixture {
  name: string;
  targets: string[];
  /** Samples of sound between the lead and tail zeros. */
  sound: number;
  tail: number;
  total: number;
  speech?: boolean;
  f0?: number;
  snrDb?: number;
}

const TEST = ['test'];
const BOTH = ['test', 'e2e'];

// The fixture table of #16 in samples (ORCH-PLAN v4): lead 48 000 + sound + tail = total.
const EXPECTED: ExpectedFixture[] = [
  { name: 'silence_2s', targets: BOTH, sound: 96_000, tail: 14_400, total: 158_400 },
  { name: 'noise_white_-60dbfs_3s', targets: TEST, sound: 144_000, tail: 14_400, total: 206_400 },
  { name: 'noise_pink_-40dbfs_5s', targets: TEST, sound: 240_000, tail: 14_400, total: 302_400 },
  { name: 'sine_1k_-20dbfs_1s', targets: TEST, sound: 48_000, tail: 14_400, total: 110_400 },
  { name: 'chirp_80-400_2s', targets: TEST, sound: 96_000, tail: 14_400, total: 158_400 },
  { name: 'vowel_f0-140', targets: BOTH, sound: 72_000, tail: 14_400, total: 134_400, speech: true, f0: 140 },
  { name: 'vowel_f0-300', targets: BOTH, sound: 72_000, tail: 14_400, total: 134_400, speech: true, f0: 300 },
  {
    name: 'vowel_f0-140_pink_snr10',
    targets: BOTH,
    sound: 72_000,
    tail: 14_400,
    total: 134_400,
    speech: true,
    f0: 140,
    snrDb: 10,
  },
  { name: 'knock', targets: BOTH, sound: 145_920, tail: 48_000, total: 241_920 },
  { name: 'long_12s', targets: BOTH, sound: 576_000, tail: 14_400, total: 638_400, speech: true, f0: 140 },
  {
    name: 'vowel_short_100ms',
    targets: TEST,
    sound: 4_800,
    tail: 14_400,
    total: 67_200,
    speech: true,
    f0: 140,
  },
  // #116: the noisy.spec fake mic (e2e only).
  { name: 'noise_pink_-20dbfs_20s', targets: ['e2e'], sound: 960_000, tail: 14_400, total: 1_022_400 },
];

const FILES = EXPECTED.flatMap((e) => e.targets.map((target) => ({ ...e, target })));

function wavPath(target: string, name: string): string {
  return join(REPO_ROOT, target, 'fixtures', `${name}.wav`);
}

function jsonPath(target: string, name: string): string {
  return join(REPO_ROOT, target, 'fixtures', `${name}.json`);
}

/** Decoded mono samples of a committed fixture. */
function load(name: string, target = 'test'): Float32Array {
  const { sampleRate, channels } = readWav(readFileSync(wavPath(target, name)));
  expect(sampleRate).toBe(SAMPLE_RATE);
  expect(channels).toHaveLength(1);
  return channels[0]!;
}

/** Index of the first non-zero sample in x[from, to), or −1. */
function firstNonZero(x: Float32Array, from: number, to: number): number {
  for (let i = from; i < to; i++) if (x[i] !== 0) return i;
  return -1;
}

function peakDb(x: Float32Array, from = 0, to = x.length): number {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]!));
  return 20 * Math.log10(peak);
}

function expectedSidecar(e: ExpectedFixture): Record<string, unknown> {
  return {
    sampleRate: 48_000,
    lengthSamples: e.total,
    speech: e.speech === true ? [{ start: 48_000, end: 48_000 + e.sound }] : [],
    ...(e.f0 === undefined ? {} : { f0: e.f0 }),
    ...(e.snrDb === undefined ? {} : { snrDb: e.snrDb }),
    seed: 48_802,
  };
}

const built = buildFixtures();

test('constants match the issue', () => {
  expect(SEED).toBe(0xbea2);
  expect(SEED).toBe(48_802);
  expect(SAMPLE_RATE).toBe(48_000);
  expect(LEAD_SAMPLES).toBe(48_000);
  expect(TAIL_SAMPLES).toBe(14_400);
  for (const e of EXPECTED) expect(LEAD_SAMPLES + e.sound + e.tail).toBe(e.total);
});

test('the generator builds exactly the fixture table', () => {
  expect(built.map((f) => ({ name: f.name, targets: f.targets, length: f.samples.length }))).toEqual(
    EXPECTED.map((e) => ({ name: e.name, targets: e.targets, length: e.total })),
  );
});

describe.each(FILES)('$target/fixtures/$name', (e) => {
  test('committed bytes equal a fresh generation (deterministic)', () => {
    const fixture = built.find((f) => f.name === e.name)!;
    const { wav, json } = encodeFixture(fixture);
    expect(Buffer.from(wav).equals(readFileSync(wavPath(e.target, e.name)))).toBe(true);
    expect(readFileSync(jsonPath(e.target, e.name), 'utf8')).toBe(json);
  });

  test('is 48 kHz mono with 1.0 s lead zeros, 14 400 tail zeros and a matching sidecar', () => {
    const x = load(e.name, e.target);
    const sidecar: FixtureSidecar = JSON.parse(readFileSync(jsonPath(e.target, e.name), 'utf8'));
    const expected = expectedSidecar(e);
    expect(sidecar).toStrictEqual(expected);
    expect(Object.keys(sidecar)).toEqual(Object.keys(expected));

    expect(x).toHaveLength(sidecar.lengthSamples);
    expect(x).toHaveLength(e.total);
    expect(firstNonZero(x, 0, 48_000)).toBe(-1);
    expect(firstNonZero(x, x.length - 14_400, x.length)).toBe(-1);
    expect(firstNonZero(x, x.length - e.tail, x.length)).toBe(-1);

    for (const span of sidecar.speech) {
      expect(span.start).toBeGreaterThanOrEqual(LEAD_SAMPLES);
      expect(span.start).toBeLessThan(span.end);
      expect(span.end).toBeLessThanOrEqual(x.length - TAIL_SAMPLES);
    }
  });
});

/** The directory a fixture is loaded from: test/fixtures, or e2e/fixtures for an e2e-only one. */
function targetOf(name: string): string {
  return EXPECTED.find((e) => e.name === name)!.targets[0]!;
}

/** End (exclusive) of a fixture's sound span. */
function soundEnd(name: string): number {
  return LEAD_SAMPLES + EXPECTED.find((e) => e.name === name)!.sound;
}

/**
 * f0 of x[from, to) by normalised autocorrelation: the lag in [fs/500, fs/60] with the highest
 * normalised correlation, refined by parabolic interpolation.
 */
function autocorrelationF0(x: Float32Array, from: number, to: number): number {
  const minLag = Math.floor(SAMPLE_RATE / 500);
  const maxLag = Math.ceil(SAMPLE_RATE / 60);
  const r = new Float64Array(maxLag + 2);
  let bestLag = minLag;
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = from; i + lag < to; i++) {
      xy += x[i]! * x[i + lag]!;
      xx += x[i]! * x[i]!;
      yy += x[i + lag]! * x[i + lag]!;
    }
    r[lag] = xy / Math.sqrt(xx * yy);
    if (lag >= minLag && lag <= maxLag && r[lag]! > r[bestLag]!) bestLag = lag;
  }
  const [a, b, c] = [r[bestLag - 1]!, r[bestLag]!, r[bestLag + 1]!];
  return SAMPLE_RATE / (bestLag + (a - c) / (2 * (a - 2 * b + c)));
}

/** Frequency (on a `step`-Hz grid in [lo, hi]) of the strongest Hann-windowed component of x[from, to). */
function spectralPeakHz(
  x: Float32Array,
  from: number,
  to: number,
  lo: number,
  hi: number,
  step: number,
): number {
  let best = lo;
  let bestDb = -Infinity;
  for (let f = lo; f <= hi; f += step) {
    const db = toneLevelDb(x, f, SAMPLE_RATE, from, to);
    if (db > bestDb) {
      bestDb = db;
      best = f;
    }
  }
  return best;
}

/**
 * Mean power spectral density of x[from, to) over [fLo, fHi) in dB (arbitrary reference): Hann-windowed
 * 4800-sample segments (10 Hz bins), one Goertzel filter per bin, averaged over bins and segments.
 */
function bandDensityDb(x: Float32Array, from: number, to: number, fLo: number, fHi: number): number {
  const n = 4800;
  const binHz = SAMPLE_RATE / n;
  const window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  let sum = 0;
  let count = 0;
  for (let start = from; start + n <= to; start += n) {
    for (let k = Math.ceil(fLo / binHz); k * binHz < fHi; k++) {
      const coeff = 2 * Math.cos((2 * Math.PI * k) / n);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = window[i]! * x[start + i]! + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      sum += s1 * s1 + s2 * s2 - coeff * s1 * s2;
      count++;
    }
  }
  return 10 * Math.log10(sum / count);
}

describe('signal levels', () => {
  test('silence_2s is all zeros', () => {
    const x = load('silence_2s');
    expect(firstNonZero(x, 0, x.length)).toBe(-1);
  });

  test.each([
    ['noise_white_-60dbfs_3s', -60],
    ['noise_pink_-40dbfs_5s', -40],
    ['sine_1k_-20dbfs_1s', -20],
    ['noise_pink_-20dbfs_20s', -20],
  ])('%s has RMS %d dBFS over the sound span', (name, db) => {
    const x = load(name, targetOf(name));
    expect(Math.abs(rmsDb(x, LEAD_SAMPLES, soundEnd(name)) - db)).toBeLessThanOrEqual(0.05);
  });

  test.each(['chirp_80-400_2s', 'vowel_f0-140', 'vowel_f0-300', 'long_12s', 'vowel_short_100ms'])(
    '%s peaks at −12 dBFS',
    (name) => {
      expect(Math.abs(peakDb(load(name)) + 12)).toBeLessThanOrEqual(0.01);
    },
  );

  test('vowel_f0-140_pink_snr10 is vowel_f0-140 plus noise at 10 dB SNR', () => {
    const vowel = load('vowel_f0-140');
    const mixed = load('vowel_f0-140_pink_snr10');
    let signal = 0;
    let noise = 0;
    for (let i = LEAD_SAMPLES; i < soundEnd('vowel_f0-140'); i++) {
      const d = mixed[i]! - vowel[i]!;
      signal += vowel[i]! * vowel[i]!;
      noise += d * d;
    }
    expect(Math.abs(10 * Math.log10(signal / noise) - 10)).toBeLessThanOrEqual(0.05);
  });

  test('the noise in vowel_f0-140_pink_snr10 covers exactly the sound span, evenly', () => {
    const vowel = load('vowel_f0-140');
    const mixed = load('vowel_f0-140_pink_snr10');
    const start = LEAD_SAMPLES;
    const end = soundEnd('vowel_f0-140');
    const noise = mixed.map((v, i) => v - vowel[i]!);
    expect(firstNonZero(noise, 0, start)).toBe(-1);
    expect(firstNonZero(noise, end, noise.length)).toBe(-1);
    const spanDb = rmsDb(noise, start, end);
    const window = 4800; // 100 ms
    for (let from = start; from < end; from += window) {
      expect(Math.abs(rmsDb(noise, from, from + window) - spanDb)).toBeLessThanOrEqual(6);
    }
  });

  // Mean PSD over one octave near 100 Hz minus one decade higher: pink noise (PSD ∝ 1/f) reads 10 dB,
  // white noise 0 dB.
  test.each([
    ['noise_pink_-40dbfs_5s', 10],
    ['noise_white_-60dbfs_3s', 0],
    ['noise_pink_-20dbfs_20s', 10],
  ])('%s: PSD in 100–200 Hz is %d ± 2 dB above 1–2 kHz', (name, db) => {
    const x = load(name, targetOf(name));
    const slope =
      bandDensityDb(x, LEAD_SAMPLES, soundEnd(name), 100, 200) -
      bandDensityDb(x, LEAD_SAMPLES, soundEnd(name), 1000, 2000);
    expect(Math.abs(slope - db)).toBeLessThanOrEqual(2);
  });

  test('knock has three 40 ms bursts peaking at −12 dBFS, 1.5 s apart, and zeros elsewhere', () => {
    const x = load('knock');
    const starts = [48_000, 120_000, 192_000];
    let from = 0;
    for (const start of starts) {
      expect(firstNonZero(x, from, start)).toBe(-1);
      expect(Math.abs(peakDb(x, start, start + 1920) + 12)).toBeLessThanOrEqual(0.01);
      from = start + 1920;
    }
    expect(firstNonZero(x, from, x.length)).toBe(-1);
  });
});

describe.each(EXPECTED.filter((e) => e.speech === true))('$name voice', (e) => {
  // A 0.5 s window in the middle of the sound span (the whole span for vowel_short_100ms).
  const length = Math.min(24_000, e.sound);
  const from = LEAD_SAMPLES + (e.sound - length) / 2;
  const to = from + length;
  const f0 = e.f0!;

  test('f0 by autocorrelation is within ±2 % of the sidecar f0', () => {
    expect(Math.abs(autocorrelationF0(load(e.name), from, to) / f0 - 1)).toBeLessThanOrEqual(0.02);
  });

  // F1 is 700 Hz. The spectrum has lines at the harmonics of f0 only, so the strongest line in
  // 300–1000 Hz is the harmonic nearest F1: 700 Hz itself for f0 140 (inside 630–770 Hz), 600 Hz for f0 300.
  test('the spectral peak in 300–1000 Hz is the harmonic of f0 nearest F1 (700 Hz)', () => {
    const nearest = Math.round(700 / f0) * f0;
    const peak = spectralPeakHz(load(e.name), from, to, 300, 1000, 5);
    expect(Math.abs(peak - nearest)).toBeLessThanOrEqual(0.02 * nearest);
  });
});

/** The canonical mulberry32 (Tommy Ettinger), transcribed. */
function referenceMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('mulberry32 matches the canonical reference implementation', () => {
  for (const seed of [0, 1, 0xbea2, 0xffffffff]) {
    const actual = mulberry32(seed);
    const expected = referenceMulberry32(seed);
    for (let i = 0; i < 10_000; i++) expect(actual()).toBe(expected());
  }
});

test('the generator uses only the seeded rng', () => {
  const source = readFileSync(new URL('./gen-fixtures.ts', import.meta.url), 'utf8');
  expect(source.length).toBeGreaterThan(0);
  expect(source).not.toContain('Math.random');
});
