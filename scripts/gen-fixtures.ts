// Deterministic synthetic audio fixtures for unit tests (test/fixtures) and fake-mic e2e tests
// (e2e/fixtures). No real-voice audio (plan Q2): every signal is synthesised from the seeded
// mulberry32 PRNG only, so reruns are byte-identical.
//
// Every file is 48 kHz mono PCM16 with 1.0 s of leading digital zeros and at least 0.3 s of trailing
// digital zeros: Chromium's fake mic re-delivers its last buffer forever after the end of the file
// (plan §4.9.3), so the tail must be silence.
//
// Usage: pnpm fixtures (node scripts/gen-fixtures.ts)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mulberry32 } from '../test/dsp-helpers.ts';
import { writeWav } from '../test/wav.ts';

export const SEED = 0xbea2;
export const SAMPLE_RATE = 48_000;
/** 1.0 s of leading digital zeros. */
export const LEAD_SAMPLES = 48_000;
/** 0.3 s of trailing digital zeros (knock has a longer tail). */
export const TAIL_SAMPLES = 14_400;

const PEAK_DBFS = -12;

export type FixtureTarget = 'test' | 'e2e';

/** A speech span in sample indices, half-open: samples start … end − 1. */
export interface SpeechSpan {
  start: number;
  end: number;
}

/** The sidecar JSON written next to each WAV file. Every value is an integer. */
export interface FixtureSidecar {
  sampleRate: number;
  lengthSamples: number;
  /** Half-open [start, end) sample-index spans; empty when the file has no speech. */
  speech: SpeechSpan[];
  f0?: number;
  snrDb?: number;
  seed: number;
}

export interface Fixture {
  name: string;
  targets: FixtureTarget[];
  samples: Float32Array;
  sidecar: FixtureSidecar;
}

type Rng = () => number;

/** Uniform white noise in [−1, 1): one rng draw per sample. */
function whiteNoise(rng: Rng, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 2 * rng() - 1;
  return x;
}

/** Pink noise: Paul Kellet's refined filter applied to white noise from `rng`. */
function pinkNoise(rng: Rng, n: number): Float64Array {
  const x = new Float64Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = 2 * rng() - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    // b6 is a one-sample delay: the output uses the previous sample's b6, then b6 is updated.
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return x;
}

function sine(freq: number, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return x;
}

/** Logarithmic chirp from f0 to f1 over n samples: sin(φ(t)), φ(t) = 2π·f0·T/ln(f1/f0)·(e^(t·ln(f1/f0)/T) − 1). */
function logChirp(f0: number, f1: number, n: number): Float64Array {
  const x = new Float64Array(n);
  const T = n / SAMPLE_RATE;
  const k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    x[i] = Math.sin(((2 * Math.PI * f0 * T) / k) * (Math.exp((t * k) / T) - 1));
  }
  return x;
}

function meanSquare(x: Float64Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return sum / x.length;
}

/** Scales x in place so that 20·log10(rms) = db (full scale 1.0). */
function scaleToRmsDb(x: Float64Array, db: number): Float64Array {
  const gain = 10 ** (db / 20) / Math.sqrt(meanSquare(x));
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * gain;
  return x;
}

/** Scales x in place so that max|x| = 10^(db/20). */
function scaleToPeakDb(x: Float64Array, db: number): Float64Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const gain = 10 ** (db / 20) / peak;
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * gain;
  return x;
}

/** One 2nd-order Klatt resonator: y = A·x + B·y1 + C·y2 (unity gain at DC). */
function resonate(x: Float64Array, freq: number, bandwidth: number): Float64Array {
  const C = -Math.exp((-2 * Math.PI * bandwidth) / SAMPLE_RATE);
  const B = 2 * Math.exp((-Math.PI * bandwidth) / SAMPLE_RATE) * Math.cos((2 * Math.PI * freq) / SAMPLE_RATE);
  const A = 1 - B - C;
  const y = new Float64Array(x.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = A * x[i]! + B * y1 + C * y2;
    y[i] = v;
    y2 = y1;
    y1 = v;
  }
  return y;
}

const FADE_SAMPLES = 960; // 20 ms raised-cosine fade

function fadeIn(i: number): number {
  return 0.5 * (1 - Math.cos((Math.PI * i) / FADE_SAMPLES));
}

/**
 * Synthetic vowel: a jittered impulse train at f0 (±1 % period jitter) through three resonators
 * (F1 700/80, F2 1220/90, F3 2600/120 Hz), times a 4 Hz syllabic envelope and 20 ms raised-cosine
 * fades, peak-normalised to −12 dBFS.
 */
function vowel(rng: Rng, f0: number, durationS: number): Float64Array {
  const n = Math.round(durationS * SAMPLE_RATE);
  const excitation = new Float64Array(n);
  let pos = 0;
  while (Math.round(pos) < n) {
    excitation[Math.round(pos)] = 1;
    pos += (SAMPLE_RATE / f0) * (1 + 0.01 * (2 * rng() - 1));
  }
  let y = resonate(excitation, 700, 80);
  y = resonate(y, 1220, 90);
  y = resonate(y, 2600, 120);
  for (let i = 0; i < n; i++) {
    let gain = 0.5 * (1 - Math.cos((2 * Math.PI * 4 * i) / SAMPLE_RATE));
    if (i < FADE_SAMPLES) gain *= fadeIn(i);
    if (i >= n - FADE_SAMPLES) gain *= fadeIn(n - 1 - i);
    y[i] = y[i]! * gain;
  }
  return scaleToPeakDb(y, PEAK_DBFS);
}

/**
 * Mixes noise into signal at the given SNR over the whole span: the noise is scaled so that
 * mean(noise²) = mean(signal²) / 10^(snrDb/10). No renormalisation, no clipping.
 */
function mixAtSnr(signal: Float64Array, noise: Float64Array, snrDb: number): Float64Array {
  const gain = Math.sqrt(meanSquare(signal) / (10 ** (snrDb / 10) * meanSquare(noise)));
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i]! + gain * noise[i]!;
  return out;
}

const KNOCK_BURST_SAMPLES = 1920; // 40 ms
const KNOCK_BURST_OFFSETS = [0, 72_000, 144_000]; // 1.0, 2.5 and 4.0 s in the file
const KNOCK_TAU_S = 0.008;

/** Three 40 ms white-noise bursts with exponential decay (τ = 8 ms), each peaking at −12 dBFS. */
function knock(rng: Rng): Float64Array {
  const sound = new Float64Array(KNOCK_BURST_OFFSETS.at(-1)! + KNOCK_BURST_SAMPLES);
  for (const offset of KNOCK_BURST_OFFSETS) {
    const burst = whiteNoise(rng, KNOCK_BURST_SAMPLES);
    for (let i = 0; i < burst.length; i++) burst[i] = burst[i]! * Math.exp(-(i / SAMPLE_RATE) / KNOCK_TAU_S);
    sound.set(scaleToPeakDb(burst, PEAK_DBFS), offset);
  }
  return sound;
}

interface FixtureSound {
  sound: Float64Array;
  /** Trailing zeros; defaults to TAIL_SAMPLES. */
  tail?: number;
  /** Whether the whole sound span is one speech span. */
  speech?: boolean;
  f0?: number;
  snrDb?: number;
}

interface FixtureSpec {
  name: string;
  targets: FixtureTarget[];
  build: (rng: Rng) => FixtureSound;
}

const TEST: FixtureTarget[] = ['test'];
const BOTH: FixtureTarget[] = ['test', 'e2e'];

const seconds = (s: number): number => Math.round(s * SAMPLE_RATE);

const FIXTURE_SPECS: FixtureSpec[] = [
  { name: 'silence_2s', targets: TEST, build: () => ({ sound: new Float64Array(seconds(2)) }) },
  {
    name: 'noise_white_-60dbfs_3s',
    targets: TEST,
    build: (rng) => ({ sound: scaleToRmsDb(whiteNoise(rng, seconds(3)), -60) }),
  },
  {
    name: 'noise_pink_-40dbfs_5s',
    targets: TEST,
    build: (rng) => ({ sound: scaleToRmsDb(pinkNoise(rng, seconds(5)), -40) }),
  },
  {
    name: 'sine_1k_-20dbfs_1s',
    targets: TEST,
    build: () => ({ sound: scaleToRmsDb(sine(1000, seconds(1)), -20) }),
  },
  {
    name: 'chirp_80-400_2s',
    targets: TEST,
    build: () => ({ sound: scaleToPeakDb(logChirp(80, 400, seconds(2)), PEAK_DBFS) }),
  },
  {
    name: 'vowel_f0-140',
    targets: BOTH,
    build: (rng) => ({ sound: vowel(rng, 140, 1.5), speech: true, f0: 140 }),
  },
  {
    name: 'vowel_f0-300',
    targets: BOTH,
    build: (rng) => ({ sound: vowel(rng, 300, 1.5), speech: true, f0: 300 }),
  },
  {
    name: 'vowel_f0-140_pink_snr10',
    targets: BOTH,
    build: (rng) => {
      // The vowel is drawn first (sample-identical to vowel_f0-140); the noise continues the same rng.
      const v = vowel(rng, 140, 1.5);
      const noise = pinkNoise(rng, v.length);
      return { sound: mixAtSnr(v, noise, 10), speech: true, f0: 140, snrDb: 10 };
    },
  },
  {
    name: 'knock',
    targets: BOTH,
    // The file ends 1.0 s after the end of the last burst.
    build: (rng) => ({ sound: knock(rng), tail: seconds(1) }),
  },
  {
    name: 'long_12s',
    targets: BOTH,
    build: (rng) => ({ sound: vowel(rng, 140, 12), speech: true, f0: 140 }),
  },
  {
    name: 'vowel_short_100ms',
    targets: TEST,
    build: (rng) => ({ sound: vowel(rng, 140, 0.1), speech: true, f0: 140 }),
  },
];

/** Builds every fixture in memory. Each fixture gets a fresh mulberry32(SEED), so order doesn't matter. */
export function buildFixtures(): Fixture[] {
  return FIXTURE_SPECS.map(({ name, targets, build }) => {
    const { sound, tail = TAIL_SAMPLES, speech = false, f0, snrDb } = build(mulberry32(SEED));
    const samples = new Float32Array(LEAD_SAMPLES + sound.length + tail);
    samples.set(sound, LEAD_SAMPLES);
    const sidecar: FixtureSidecar = {
      sampleRate: SAMPLE_RATE,
      lengthSamples: samples.length,
      speech: speech ? [{ start: LEAD_SAMPLES, end: LEAD_SAMPLES + sound.length }] : [],
      ...(f0 === undefined ? {} : { f0 }),
      ...(snrDb === undefined ? {} : { snrDb }),
      seed: SEED,
    };
    return { name, targets, samples, sidecar };
  });
}

/** The exact bytes written for a fixture: a 48 kHz mono PCM16 WAV and its sidecar JSON. */
export function encodeFixture(fixture: Fixture): { wav: Uint8Array; json: string } {
  return {
    wav: writeWav([fixture.samples], SAMPLE_RATE, 'pcm16'),
    json: `${JSON.stringify(fixture.sidecar, null, 2)}\n`,
  };
}

/** Writes every fixture under `root` (test/fixtures and e2e/fixtures); returns the relative paths written. */
export function writeFixtures(root: string): string[] {
  const written: string[] = [];
  for (const fixture of buildFixtures()) {
    const { wav, json } = encodeFixture(fixture);
    for (const target of fixture.targets) {
      const dir = `${target}/fixtures`;
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, `${fixture.name}.wav`), wav);
      writeFileSync(join(root, dir, `${fixture.name}.json`), json);
      written.push(`${dir}/${fixture.name}.wav`, `${dir}/${fixture.name}.json`);
    }
  }
  return written;
}

/** The repository root: the parent of scripts/. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

if (import.meta.main) {
  for (const path of writeFixtures(REPO_ROOT)) console.log(`wrote ${path}`);
}
