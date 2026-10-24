import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// `fc` is taken by highpassFir's cutoff parameter below.
import fastCheck from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import { butterworthHighpass } from './biquad.ts';
import { analyzeEnvelope } from './envelope.ts';
import { applyFades } from './fades.ts';
import { integratedLoudness, LOUDNESS, truePeakDbtp, voiceGainDb } from './normalize.ts';
import { resampleOffline } from './resample.ts';
import { PRESETS, type Envelope, type VoicePreset } from './types.ts';
import {
  applyGain,
  clipDetect,
  envelope,
  fades,
  hpfTrim,
  isVoiced,
  processVoice,
  resample,
  trimRange,
  VOICING_HOP,
  voiceStages,
  type VoiceResult,
} from './voice.ts';
import { createVoicing, VOICED_THRESHOLD } from './voicing.ts';

const FS = 48000;
const FIXTURES = join(fileURLToPath(new URL('../../', import.meta.url)), 'test', 'fixtures');

/** Channel 0 of test/fixtures/<name>.wav (every fixture is 48 kHz mono). */
function fixture(name: string): Float32Array {
  const { sampleRate, channels } = readWav(readFileSync(join(FIXTURES, `${name}.wav`)));
  expect(sampleRate).toBe(FS);
  return channels[0]!;
}

function preset(pitchRatio: number): VoicePreset {
  return { id: 'custom', pitchRatio };
}

/** The raw bits of a Float32Array, for bit-exact comparisons. */
function bits(a: Float32Array): Uint32Array {
  return new Uint32Array(a.buffer, a.byteOffset, a.length);
}

/** Asserts that a and b hold exactly the same float32 bit patterns. */
function expectSameBits(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  const ba = bits(a);
  const bb = bits(b);
  let firstDiff = -1;
  for (let i = 0; i < ba.length; i++) {
    if (ba[i] !== bb[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff).toBe(-1);
}

function expectSameEnvelope(a: Envelope, b: Envelope): void {
  expect(a.hopMs).toBe(b.hopMs);
  expectSameBits(a.jaw, b.jaw);
  expectSameBits(a.width, b.width);
  expectSameBits(a.round, b.round);
  expectSameBits(a.teeth, b.teeth);
}

function expectSameResult(a: VoiceResult, b: VoiceResult): void {
  expectSameBits(a.pcm, b.pcm);
  expectSameEnvelope(a.envelope, b.envelope);
  expect(a.durationSec).toBe(b.durationSec);
  expect(a.clipped).toBe(b.clipped);
}

/** One 2nd-order Klatt resonator (unity gain at DC), as in scripts/gen-fixtures.ts. */
function resonate(x: Float64Array, freq: number, bandwidth: number, fs: number): Float64Array {
  const C = -Math.exp((-2 * Math.PI * bandwidth) / fs);
  const B = 2 * Math.exp((-Math.PI * bandwidth) / fs) * Math.cos((2 * Math.PI * freq) / fs);
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

/**
 * A steady synthetic vowel: an impulse train at exactly f0 through the gen-fixtures formant resonators (F1
 * 700/80, F2 1220/90, F3 2600/120 Hz), mean removed, constant level (no syllabic envelope), optional
 * raised-cosine fades of `fadeMs` at both ends, peak-normalised to `peakDb` dBFS.
 */
function steadyVowel(f0: number, sec: number, peakDb: number, fs = FS, fadeMs = 0): Float32Array {
  const n = Math.round(sec * fs);
  const excitation = new Float64Array(n);
  const period = fs / f0;
  for (let k = 0; Math.round(k * period) < n; k++) excitation[Math.round(k * period)] = 1;
  let y = resonate(excitation, 700, 80, fs);
  y = resonate(y, 1220, 90, fs);
  y = resonate(y, 2600, 120, fs);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i]!;
  mean /= n;
  const fade = Math.round((fadeMs * fs) / 1000);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = y[i]! - mean;
    if (i < fade) v *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    if (i >= n - fade) v *= 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / fade);
    y[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const g = 10 ** (peakDb / 20) / peak;
  return Float32Array.from(y, (v) => v * g);
}

/** x scaled so that its RMS is `db` dBFS. */
function atRmsDb(x: Float32Array, db: number): Float32Array {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  const g = 10 ** (db / 20) / Math.sqrt(sum / x.length);
  return Float32Array.from(x, (v) => v * g);
}

/** Seeded uniform white noise of n samples at `db` dBFS RMS. */
function whiteNoise(seed: number, n: number, db: number): Float32Array {
  const rng = mulberry32(seed);
  return atRmsDb(
    Float32Array.from({ length: n }, () => 2 * rng() - 1),
    db,
  );
}

/** Zeros, then x, then zeros. */
function padded(lead: number, x: Float32Array, tail: number): Float32Array {
  const y = new Float32Array(lead + x.length + tail);
  y.set(x, lead);
  return y;
}

/** n zeros except `count` samples (every 37th from 0) set to `value`. */
function withValues(n: number, count: number, value: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < count; i++) x[i * 37] = value;
  return x;
}

/** n zeros with a 440 Hz sine (amplitude 0.5) over [from, to). */
function burst(n: number, from: number, to: number, fs = FS): Float32Array {
  const x = new Float32Array(n);
  for (let i = from; i < to; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / fs);
  return x;
}

/** 10 zero frames, one loud constant frame (−6.02 dB), one quiet constant frame `dbBelow` dB lower, 10 zero frames. */
function loudThenQuiet(dbBelow: number): Float32Array {
  const x = new Float32Array(22 * 480);
  x.fill(0.5, 10 * 480, 11 * 480);
  x.fill(0.5 * 10 ** (-dbBelow / 20), 11 * 480, 12 * 480);
  return x;
}

/**
 * 0.5 s of 25 Hz rumble at amplitude 0.01 (−43 dBFS RMS: above the −60 dB floor before the high-pass, about
 * −63 dB after it), then a 0.5 s vowel, then 0.3 s of zeros. The trim span depends on the high-pass.
 */
function rumbleThenVowel(): Float32Array {
  const x = padded(24000, steadyVowel(140, 0.5, -12), 14400);
  for (let i = 0; i < 24000; i++) x[i] = 0.01 * Math.sin((2 * Math.PI * 25 * i) / FS);
  return x;
}

/** 2 s at 8 kHz of silence with a 60-sample 400 Hz burst inside each listed window only. */
function bursts(windows: readonly number[]): Float32Array {
  const z = new Float32Array(16000);
  for (const w of windows) {
    // Window w covers [160w, 160w + 256); [160w + 98, 160w + 158) lies in no other window.
    for (let i = 0; i < 60; i++) z[160 * w + 98 + i] = 0.5 * Math.sin((2 * Math.PI * 400 * i) / 8000);
  }
  return z;
}

interface ChainRun {
  result: VoiceResult;
  /** The voiced flag the chain used. */
  voiced: boolean;
  /** The gain applyGain applied, in dB. */
  gainDb: number;
  /** The resampled clip before gain and fades (a copy). */
  resampled: Float32Array;
}

/**
 * processVoice's composition written out stage by stage (plan S1). `voicedOverride` forces the voicing
 * decision (used to build the unvoiced path).
 */
function chain(pcm: Float32Array, fs: number, p: number, noTrim = false, voicedOverride?: boolean): ChainRun {
  const clipped = clipDetect(pcm);
  const x = hpfTrim(pcm, fs, !noTrim);
  const y = resample(x, p);
  const resampled = y.slice();
  const voiced = voicedOverride ?? isVoiced(y, fs);
  const gainDb = applyGain(y, fs, voiced);
  fades(y, fs);
  const env = envelope(y, fs, p);
  return {
    result: { pcm: y, envelope: env, durationSec: y.length / fs, clipped },
    voiced,
    gainDb,
    resampled,
  };
}

describe('clipDetect (stage 1, plan §4.4)', () => {
  it('is true when at least 0.1 % of the samples have |x| > 0.99', () => {
    expect(clipDetect(withValues(10000, 10, 1.0))).toBe(true);
    expect(clipDetect(withValues(10000, 9, 1.0))).toBe(false);
    expect(clipDetect(withValues(10000, 10, -0.995))).toBe(true);
    expect(clipDetect(withValues(1000, 1, 1.0))).toBe(true);
  });

  it('compares with > 0.99 on float32 values (> and >= agree: no float32 equals 0.99)', () => {
    // Math.fround(0.99) = 0.9900000095367432 is above 0.99, so it counts; the float32 just below does not.
    expect(Math.fround(0.99)).toBeGreaterThan(0.99);
    expect(Math.fround(0.98999995)).toBeLessThan(0.99);
    expect(clipDetect(withValues(10000, 10, Math.fround(0.98999995)))).toBe(false);
    expect(clipDetect(withValues(10000, 10, Math.fround(0.99)))).toBe(true);
  });

  it('counts ±Infinity as clipped but not NaN, and an empty input is not clipped', () => {
    expect(clipDetect(withValues(10000, 10, Infinity))).toBe(true);
    expect(clipDetect(withValues(10000, 10, -Infinity))).toBe(true);
    expect(clipDetect(withValues(10000, 10, NaN))).toBe(false);
    expect(clipDetect(new Float32Array(0))).toBe(false);
  });
});

describe('trimRange (stage 3 span)', () => {
  it('keeps the frames at or above the threshold plus a 50 ms margin (48 kHz: 480-sample frames, 2400 margin)', () => {
    // Frames 100…149 hold the burst.
    expect(trimRange(burst(96000, 48000, 72000), FS)).toEqual({ start: 45600, end: 74400 });
  });

  it('uses 441-sample frames and a 2205-sample margin at 44.1 kHz', () => {
    expect(trimRange(burst(88200, 44100, 66150, 44100), 44100)).toEqual({ start: 41895, end: 68355 });
  });

  it('clamps the margin at the buffer edges', () => {
    expect(trimRange(burst(96000, 0, 24000), FS)).toEqual({ start: 0, end: 26400 });
    expect(trimRange(burst(96000, 72000, 96000), FS)).toEqual({ start: 69600, end: 96000 });
  });

  it('the last, shorter frame is a frame (peak and span)', () => {
    const x = new Float32Array(48000 + 240);
    x.fill(0.002, 4800, 5280); // frame 10, about −54 dB
    x.fill(1, 48000); // 5 ms partial last frame, 0 dB
    expect(trimRange(x, 48000)).toEqual({ start: 45600, end: 48240 });
  });

  it('leaves a clip untrimmed when no frame reaches the threshold', () => {
    expect(trimRange(new Float32Array(48000), FS)).toEqual({ start: 0, end: 48000 });
    expect(trimRange(new Float32Array(0), FS)).toEqual({ start: 0, end: 0 });
    // A 440 Hz sine at −70 dBFS RMS: every frame is below the −60 dB floor.
    const quiet = sine(440, FS, 1, 10 ** (-70 / 20) * Math.SQRT2);
    expect(trimRange(quiet, FS)).toEqual({ start: 0, end: quiet.length });
  });

  it('never trims to under 50 ms, and never trims a clip shorter than the margin', () => {
    const n = 5 * FS;
    for (const k of [0, n - 1, n / 2]) {
      const x = new Float32Array(n);
      x[k] = 1;
      const { start, end } = trimRange(x, FS);
      expect(end - start).toBeGreaterThanOrEqual(2400);
      expect(start).toBeLessThanOrEqual(k);
      expect(end).toBeGreaterThan(k);
    }
    const short = sine(440, FS, 0.03);
    expect(trimRange(short, FS)).toEqual({ start: 0, end: short.length });
  });

  it('keeps a frame exactly at the threshold side: 49.9 dB below the peak is kept, 50.1 dB is dropped', () => {
    expect(trimRange(loudThenQuiet(49.9), FS)).toEqual({ start: 2400, end: 12 * 480 + 2400 });
    expect(trimRange(loudThenQuiet(50.1), FS)).toEqual({ start: 2400, end: 11 * 480 + 2400 });
  });
});

describe('hpfTrim (stages 2 and 3)', () => {
  it('high-passes with a fresh 80 Hz Butterworth, bit for bit', () => {
    const x = rumbleThenVowel();
    expectSameBits(hpfTrim(x, FS, false), butterworthHighpass(FS, 80).process(x));
  });

  it('trims the high-passed signal (not the input) to trimRange', () => {
    const x = rumbleThenVowel();
    const full = hpfTrim(x, FS, false);
    const before = trimRange(x, FS);
    const after = trimRange(full, FS);
    // Before the high-pass the rumble is kept; after it the span starts 50 ms before the vowel.
    expect(before.start).toBe(0);
    expect(after.start).toBe(24000 - 2400);
    expectSameBits(hpfTrim(x, FS), full.subarray(after.start, after.end));
  });

  it('never returns or modifies its input', () => {
    const x = rumbleThenVowel();
    const copy = x.slice();
    expect(hpfTrim(x, FS, false)).not.toBe(x);
    expect(hpfTrim(x, FS).buffer).not.toBe(x.buffer);
    expectSameBits(x, copy);
  });

  it('attenuates a 30 Hz sine by more than 15 dB', () => {
    const x = sine(30, FS, 1, 0.5);
    expect(rmsDb(hpfTrim(x, FS, false), 4800)).toBeLessThanOrEqual(rmsDb(x, 4800) - 15);
  });

  it('throws RangeError for fs ≤ 160 Hz or non-finite', () => {
    expect(() => hpfTrim(new Float32Array(100), 100)).toThrow(RangeError);
    expect(() => hpfTrim(new Float32Array(100), NaN)).toThrow(RangeError);
  });
});

describe('resample (stage 4)', () => {
  it.each([0.75, 1.6, 2.0, 2.2])('p = %s: resampleOffline(x, 1/p), bit for bit, round(n/p) samples', (p) => {
    const x = steadyVowel(140, 0.3, -12);
    const y = resample(x, p);
    expectSameBits(y, resampleOffline(x, 1 / p));
    expect(y.length).toBe(Math.round(x.length / p));
  });
});

describe('isVoiced (stage 5)', () => {
  it('needs 3 windows above the threshold: 2 are not enough', () => {
    expect(isVoiced(bursts([5, 20]), 8000)).toBe(false);
    expect(isVoiced(bursts([5, 20, 35]), 8000)).toBe(true);
  });

  it('finds a steady vowel voiced and noise unvoiced', () => {
    expect(isVoiced(steadyVowel(140, 0.5, -12), FS)).toBe(true);
    for (const name of ['noise_white_-60dbfs_3s', 'noise_pink_-40dbfs_5s']) {
      expect(isVoiced(resample(hpfTrim(fixture(name), FS), 1.6), FS)).toBe(false);
    }
  });

  it('windows are exactly 256 samples at 0, 160, 320, … and must fit wholly', () => {
    const z = bursts([0, 1, 2]).slice(0, 576); // third window [320, 576) fits exactly
    expect(isVoiced(z, 8000)).toBe(true);
    expect(isVoiced(z.subarray(0, 575), 8000)).toBe(false);
  });

  it('is false when the 8 kHz copy is shorter than one 256-sample window', () => {
    expect(isVoiced(sine(400, 8000, 255 / 8000, 0.5), 8000)).toBe(false);
    expect(isVoiced(new Float32Array(0), FS)).toBe(false);
  });
});

describe('applyGain (stage 6)', () => {
  it.each([true, false])(
    'voiced = %s: scales in place by 10^(g/20), g = voiceGainDb, and returns g',
    (voiced) => {
      const y = resample(hpfTrim(steadyVowel(140, 0.5, -30), FS), 1.6);
      const g = voiceGainDb(y, FS, voiced);
      const k = 10 ** (g / 20);
      const expected = Float32Array.from(y, (v) => v * k);
      expect(applyGain(y, FS, voiced)).toBe(g);
      expectSameBits(y, expected);
    },
  );

  it('leaves silence unchanged (g = 0)', () => {
    const y = new Float32Array(4800);
    expect(applyGain(y, FS, true)).toBe(0);
    expect(y.every((v) => v === 0)).toBe(true);
  });
});

describe('fades and envelope (stages 7 and 8)', () => {
  it('fades is applyFades(y, fs, 8) in place', () => {
    const y = steadyVowel(140, 0.3, -12);
    const expected = y.slice();
    applyFades(expected, FS, 8);
    fades(y, FS);
    expectSameBits(y, expected);
  });

  it('envelope is analyzeEnvelope(y, fs, p)', () => {
    const y = steadyVowel(140, 0.3, -12);
    expectSameEnvelope(envelope(y, FS, 1.6), analyzeEnvelope(y, FS, 1.6));
  });
});

describe('voiceStages', () => {
  it('holds exactly the seven stages, in order', () => {
    expect(Object.keys(voiceStages)).toEqual([
      'clipDetect',
      'hpfTrim',
      'resample',
      'isVoiced',
      'applyGain',
      'fades',
      'envelope',
    ]);
    expect(voiceStages.clipDetect).toBe(clipDetect);
    expect(voiceStages.hpfTrim).toBe(hpfTrim);
    expect(voiceStages.resample).toBe(resample);
    expect(voiceStages.isVoiced).toBe(isVoiced);
    expect(voiceStages.applyGain).toBe(applyGain);
    expect(voiceStages.fades).toBe(fades);
    expect(voiceStages.envelope).toBe(envelope);
  });
});

describe('processVoice is exactly the composition of voiceStages', () => {
  const inputs: Record<string, () => Float32Array> = {
    'steady vowel': () => steadyVowel(140, 1, -12),
    'noise_pink_-40dbfs_5s': () => fixture('noise_pink_-40dbfs_5s'),
    'sine_1k_-20dbfs_1s': () => fixture('sine_1k_-20dbfs_1s'),
    '50 Hz full-scale sine': () => sine(50, FS, 1, 1),
  };

  it.each(Object.keys(inputs))('%s, p ∈ {0.75, 1.6, 2.2}, with and without trim', (name) => {
    const x = inputs[name]!();
    for (const p of [0.75, 1.6, 2.2]) {
      // The spec's 3-argument call trims; { noTrim: true } skips the trim.
      expectSameResult(processVoice(x, FS, preset(p)), chain(x, FS, p).result);
      expectSameResult(processVoice(x, FS, preset(p), { noTrim: true }), chain(x, FS, p, true).result);
    }
  });

  it('takes the clipping flag from the raw input (a 50 Hz full-scale sine loses its peaks in the high-pass)', () => {
    const x = sine(50, FS, 1, 1);
    expect(clipDetect(hpfTrim(x, FS))).toBe(false);
    expect(processVoice(x, FS, preset(1.6)).clipped).toBe(true);
  });

  it.each([1.6, 2.2])(
    'p = %s: decides voicing on the resampled clip (a quiet 100 ms vowel takes the unvoiced path)',
    (p) => {
      const x = steadyVowel(140, 0.1, -40);
      const trimmed = hpfTrim(x, FS);
      // Long enough for 3 windows before the pitch shift, too short after it.
      expect(isVoiced(trimmed, FS)).toBe(true);
      expect(isVoiced(resample(trimmed, p), FS)).toBe(false);
      const unvoiced = chain(x, FS, p, false, false);
      expectSameResult(processVoice(x, FS, preset(p)), unvoiced.result);
      // Sanity: the voiced path would have applied make-up gain, so the two paths differ.
      expect(chain(x, FS, p, false, true).gainDb).toBeGreaterThan(unvoiced.gainDb);
    },
  );
});

describe('processVoice', () => {
  it('never modifies its input and returns a standalone buffer', () => {
    const x = padded(24000, steadyVowel(140, 0.5, -12), 24000);
    const copy = x.slice();
    const r = processVoice(x, FS, preset(1.6));
    expectSameBits(x, copy);
    expect(r.pcm.buffer).not.toBe(x.buffer);
    expect(r.pcm.byteOffset).toBe(0);
    expect(r.pcm.buffer.byteLength).toBe(r.pcm.byteLength);
  });

  it('reports durationSec = pcm.length / fs and one envelope frame per 10 ms hop', () => {
    const r = processVoice(steadyVowel(140, 0.7, -12), FS, preset(1.6));
    expect(r.durationSec).toBe(r.pcm.length / FS);
    for (const track of [r.envelope.jaw, r.envelope.width, r.envelope.round, r.envelope.teeth]) {
      expect(track.length).toBe(Math.ceil(r.pcm.length / 480));
    }
  });

  it('treats NaN and ±Infinity input samples as 0: finite output and envelope', () => {
    const clean = steadyVowel(140, 1, -12);
    const dirty = clean.slice();
    const positions = [100, 20000, 47000, 5000, 30000, 12345, 40000];
    const values = [NaN, NaN, NaN, Infinity, Infinity, -Infinity, -Infinity];
    const zeroed = clean.slice();
    positions.forEach((pos, i) => {
      dirty[pos] = values[i]!;
      zeroed[pos] = 0;
    });
    const r = processVoice(dirty, FS, preset(1.6));
    expect(r.pcm.every((v) => Number.isFinite(v))).toBe(true);
    for (const track of [r.envelope.jaw, r.envelope.width, r.envelope.round, r.envelope.teeth]) {
      expect(track.every((v) => Number.isFinite(v))).toBe(true);
    }
    // 4 infinite samples out of 48 000 do not reach 0.1 %, so both inputs are unclipped.
    expectSameResult(r, processVoice(zeroed, FS, preset(1.6)));

    const oneInfinity = new Float32Array(1000);
    oneInfinity[500] = Infinity;
    expect(processVoice(oneInfinity, FS, preset(1.6)).clipped).toBe(true);
    const nanOnly = new Float32Array(1000).fill(NaN);
    const nanResult = processVoice(nanOnly, FS, preset(1.6));
    expect(nanResult.clipped).toBe(false);
    expect(nanResult.pcm.every((v) => v === 0)).toBe(true);
  });

  it('clamps finite samples to ±1e30: input near the float32 maximum still gives a finite output and envelope', () => {
    const r = processVoice(new Float32Array(48000).fill(3.4e38), FS, PRESETS.cub);
    expect(r.pcm.length).toBeGreaterThan(0);
    expect(r.pcm.every((v) => Number.isFinite(v))).toBe(true);
    for (const track of [r.envelope.jaw, r.envelope.width, r.envelope.round, r.envelope.teeth]) {
      expect(track.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it('returns an empty, unclipped result for an empty input', () => {
    const r = processVoice(new Float32Array(0), FS, preset(1.6));
    expect(r.pcm.length).toBe(0);
    expect(r.durationSec).toBe(0);
    expect(r.clipped).toBe(false);
    for (const track of [r.envelope.jaw, r.envelope.width, r.envelope.round, r.envelope.teeth]) {
      expect(track.length).toBe(0);
    }
  });

  it('throws RangeError for an invalid fs (the K-weighting needs fs > 3364 Hz) or pitch ratio', () => {
    const x = steadyVowel(140, 0.2, -12);
    for (const fs of [100, NaN, 3000]) {
      expect(() => processVoice(x, fs, preset(1.6))).toThrow(RangeError);
    }
    for (const p of [0, -1, NaN, Infinity]) {
      expect(() => processVoice(x, FS, preset(p))).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Validation 1–7 of #64.

const P_VALUES = [0.75, 1.6, 2.0, 2.2] as const;

describe('Validation 1: length', () => {
  it.each([48000, 44100])(
    'fs = %s: a continuous vowel (nothing to trim) gives round(n / p) ± 1 samples',
    (fs) => {
      const x = steadyVowel(140, 1, -12, fs);
      expect(trimRange(hpfTrim(x, fs, false), fs)).toEqual({ start: 0, end: x.length });
      for (const p of P_VALUES) {
        const out = processVoice(x, fs, preset(p));
        expect(Math.abs(out.pcm.length - Math.round(x.length / p))).toBeLessThanOrEqual(1);
      }
    },
  );
});

/** YIN search range. */
const YIN_FMIN = 60;
const YIN_FMAX = 1000;

/**
 * Test-only YIN (de Cheveigné & Kawahara 2002, steps 2–5) on the window x[start, start + w) and lags up to
 * τmax = ceil(fs / fmin): difference function d(τ) = Σ_{j<w} (x[start+j] − x[start+j+τ])², cumulative mean
 * normalised difference d'(τ) = d(τ)·τ / Σ_{k=1..τ} d(k), absolute threshold (the first τ ≥ floor(fs / fmax)
 * with d' below thr, then down to its local minimum) and parabolic interpolation of d' around it. Returns f0
 * in Hz, or null when no d'(τ) ≤ τmax is below thr. Reads x up to start + w + τmax + 1.
 */
function yinF0(x: Float32Array, fs: number, start: number, w: number, thr = 0.1): number | null {
  const tauMin = Math.max(2, Math.floor(fs / YIN_FMAX));
  const tauMax = Math.ceil(fs / YIN_FMIN);
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0;
    for (let j = 0; j < w; j++) {
      const diff = x[start + j]! - x[start + j + tau]!;
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmndf = new Float64Array(tauMax + 2);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau]!;
    cmndf[tau] = running > 0 ? (d[tau]! * tau) / running : 1;
  }
  let tau = tauMin;
  while (tau <= tauMax && cmndf[tau]! >= thr) tau++;
  if (tau > tauMax) return null;
  while (tau < tauMax && cmndf[tau + 1]! < cmndf[tau]!) tau++;
  const a = cmndf[tau - 1]!;
  const b = cmndf[tau]!;
  const c = cmndf[tau + 1]!;
  const den = a - 2 * b + c;
  const shift = den > 0 ? (0.5 * (a - c)) / den : 0;
  return fs / (tau + shift);
}

/** Median YIN f0 over 30 ms windows every 10 ms inside [from, to), and how many windows gave an estimate. */
function medianF0(x: Float32Array, fs: number, from: number, to: number): { f0: number; count: number } {
  const w = Math.round(0.03 * fs);
  const hop = Math.round(0.01 * fs);
  const tauMax = Math.ceil(fs / YIN_FMIN);
  const estimates: number[] = [];
  for (let s = from; s + w + tauMax + 1 <= to; s += hop) {
    const f = yinF0(x, fs, s, w);
    if (f !== null) estimates.push(f);
  }
  const sorted = estimates.toSorted((p, q) => p - q);
  return { f0: sorted[sorted.length >> 1] ?? NaN, count: sorted.length };
}

describe('Validation 2: pitch (YIN, trim disabled)', () => {
  const vowel = fixture('vowel_f0-140');
  // The fixture's speech span (its sidecar JSON): samples 48000 … 119999.
  const input = medianF0(vowel, FS, 48000, 120000);

  it('the test YIN is accurate: a 3-harmonic 173.3 Hz tone within ±0.1 %, the fixture vowel at 140 Hz ±1 %', () => {
    const f0 = 173.3;
    const x = Float32Array.from({ length: FS }, (_, i) => {
      const t = (2 * Math.PI * f0 * i) / FS;
      return 0.3 * Math.sin(t) + 0.2 * Math.sin(2 * t + 1) + 0.1 * Math.sin(3 * t + 2);
    });
    const tone = medianF0(x, FS, 0, x.length);
    expect(tone.count).toBeGreaterThanOrEqual(20);
    expect(Math.abs(tone.f0 / f0 - 1)).toBeLessThanOrEqual(0.001);
    expect(input.count).toBeGreaterThanOrEqual(20);
    expect(Math.abs(input.f0 / 140 - 1)).toBeLessThanOrEqual(0.01);
  });

  it.each(P_VALUES)('p = %s: output f0 = input f0 × p ± 1 %', (p) => {
    const out = processVoice(vowel, FS, preset(p), { noTrim: true }).pcm;
    const measured = medianF0(out, FS, Math.round(48000 / p), Math.round(120000 / p));
    expect(measured.count).toBeGreaterThanOrEqual(20);
    expect(Math.abs(measured.f0 / (input.f0 * p) - 1)).toBeLessThanOrEqual(0.01);
  });
});

describe('Validation 3: alias on the production path', () => {
  it('an 18 kHz tone (amplitude 0.5, 48 kHz) through chipmunk (p = 2): unvoiced, gain ≤ 0 dB, ≤ −60 dBFS', () => {
    const x = sine(18000, FS, 1, 0.5);
    const out = processVoice(x, FS, { id: 'chipmunk', pitchRatio: 2 });
    const run = chain(x, FS, 2);
    expectSameResult(out, run.result);
    expect(run.voiced).toBe(false);
    expect(run.gainDb).toBeLessThanOrEqual(0);
    // Steady state: everything but the 8 ms fades at each end.
    const fade = Math.round(0.008 * FS);
    expect(rmsDb(out.pcm, fade, out.pcm.length - fade)).toBeLessThanOrEqual(-60);
  });
});

describe('Validation 4: loudness', () => {
  it.each(P_VALUES)(
    'p = %s: a whisper-level vowel (−45 dBFS) comes out quieter than a normal one (−25 dBFS)',
    (p) => {
      const vowel = steadyVowel(140, 1, -12);
      const whisper = atRmsDb(vowel, -45);
      const normal = atRmsDb(vowel, -25);
      // Both are voiced, so the difference comes from the +12 dB make-up cap.
      expect(chain(whisper, FS, p).voiced).toBe(true);
      expect(chain(normal, FS, p).voiced).toBe(true);
      const whisperOut = processVoice(whisper, FS, preset(p)).pcm;
      const normalOut = processVoice(normal, FS, preset(p)).pcm;
      expect(rmsDb(whisperOut)).toBeLessThan(rmsDb(normalOut));
    },
  );

  const wavs = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.wav'))
    .toSorted();

  it('finds the fixture WAVs', () => {
    expect(wavs.length).toBeGreaterThanOrEqual(11);
  });

  // One test per fixture keeps each well inside the default timeout.
  it.each(wavs)('%s: true peak ≤ −3 dBTP (+0.05) at every p', (file) => {
    const x = fixture(file.slice(0, -'.wav'.length));
    for (const p of P_VALUES) {
      expect(truePeakDbtp(processVoice(x, FS, preset(p)).pcm)).toBeLessThanOrEqual(-3 + 0.05);
    }
  });

  const noises: Record<string, () => Float32Array> = {
    'noise_white_-60dbfs_3s': () => fixture('noise_white_-60dbfs_3s'),
    'noise_pink_-40dbfs_5s': () => fixture('noise_pink_-40dbfs_5s'),
    'white noise at −50 dBFS (1 s)': () => whiteNoise(0x7e53, FS, -50),
  };

  it.each(Object.keys(noises))('%s: noise-only input is not amplified', (name) => {
    const x = noises[name]!();
    for (const p of P_VALUES) {
      const run = chain(x, FS, p);
      expect(run.voiced).toBe(false);
      expect(run.gainDb).toBeLessThanOrEqual(0);
      const out = processVoice(x, FS, preset(p)).pcm;
      expect(rmsDb(out)).toBeLessThanOrEqual(rmsDb(run.resampled) + 1e-6);
    }
  });
});

/** Zeroth-order modified Bessel function of the first kind (power series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/** Linear-phase high-pass FIR: δ minus a Kaiser(β)-windowed sinc low-pass with cutoff fc (−6 dB at fc). */
function highpassFir(fc: number, fs: number, taps: number, beta: number): Float64Array {
  const h = new Float64Array(taps);
  const m = (taps - 1) / 2;
  const wc = fc / fs;
  for (let i = 0; i < taps; i++) {
    const t = i - m;
    const lowpass = t === 0 ? 2 * wc : Math.sin(2 * Math.PI * wc * t) / (Math.PI * t);
    const win = besselI0(beta * Math.sqrt(1 - (t / m) ** 2)) / besselI0(beta);
    h[i] = -lowpass * win;
  }
  h[m] = h[m]! + 1;
  return h;
}

/** |H(f)| of the FIR h in dB. */
function responseDb(h: Float64Array, f: number, fs: number): number {
  let re = 0;
  let im = 0;
  for (let k = 0; k < h.length; k++) {
    re += h[k]! * Math.cos((2 * Math.PI * f * k) / fs);
    im -= h[k]! * Math.sin((2 * Math.PI * f * k) / fs);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

/**
 * Energy of the zero-delay filtered signal (h ∗ x)[j] = Σ_k h[k]·x[j + m − k] (m = half the length) over j in
 * [from, to), with x = 0 outside [0, x.length): the clip plays out of and into silence.
 */
function filteredEnergy(h: Float64Array, x: Float32Array, from: number, to: number): number {
  const m = (h.length - 1) / 2;
  let energy = 0;
  for (let j = from; j < to; j++) {
    let s = 0;
    for (let k = 0; k < h.length; k++) {
      const i = j + m - k;
      if (i >= 0 && i < x.length) s += h[k]! * x[i]!;
    }
    energy += s * s;
  }
  return energy;
}

function energyOf(x: Float32Array, from: number, to: number): number {
  let energy = 0;
  for (let i = from; i < to; i++) energy += x[i]! * x[i]!;
  return energy;
}

describe('Validation 5: no clicks (spectral boundary test)', () => {
  // The 6 kHz–Nyquist band is split off with a 255-tap linear-phase high-pass over the whole zero-padded
  // output, not with a spectrum of the isolated 20 ms segment: a rectangular window on the segment measures its
  // own cut at 20 ms (about −30 dB even on a clean clip), and a Hann window weights the boundary sample by 0 and
  // hides the click. The transition band lies below 6 kHz (−6 dB at 5 kHz), so the filter also counts some
  // 4–6 kHz energy: stricter than the literal band. The filter's ringing outside the clip is counted too.
  const h = highpassFir(5000, FS, 255, 10);
  const half = (h.length - 1) / 2;
  const segment = Math.round(0.02 * FS);

  /** [first, last] 20 ms: band energy / total energy of the same 20 ms, in dB. */
  function boundaryRatiosDb(y: Float32Array): [number, number] {
    const n = y.length;
    const head = filteredEnergy(h, y, -half, segment) / energyOf(y, 0, segment);
    const tail = filteredEnergy(h, y, n - segment, n + half) / energyOf(y, n - segment, n);
    return [10 * Math.log10(head), 10 * Math.log10(tail)];
  }

  /** A full-scale 1 kHz sine starting at +1 and ending near +0.99: cut abruptly at both ends. */
  function abruptSine(): Float32Array {
    return sine(1000, FS, 1, 1, Math.PI / 2);
  }

  it('the band-split filter passes ≥ 6 kHz at 0 dB and rejects ≤ 4 kHz by ≥ 104 dB', () => {
    for (const f of [1000, 1600, 3000, 4000]) expect(responseDb(h, f, FS)).toBeLessThanOrEqual(-104);
    expect(Math.abs(responseDb(h, 5000, FS) + 6.02)).toBeLessThanOrEqual(0.1);
    for (const f of [6000, 8000, 12000, 20000, 23000]) {
      expect(Math.abs(responseDb(h, f, FS))).toBeLessThanOrEqual(0.01);
    }
  });

  it('a full-scale 1 kHz sine cut abruptly at both ends, at p = 1.6: ≤ −50 dB in the first and last 20 ms', () => {
    const x = abruptSine();
    expect(x[0]).toBe(1);
    expect(x[x.length - 1]).toBeGreaterThan(0.99);
    const [head, tail] = boundaryRatiosDb(processVoice(x, FS, PRESETS.cub).pcm);
    expect(head).toBeLessThanOrEqual(-50);
    expect(tail).toBeLessThanOrEqual(-50);
  });

  it('negative control: without the fades the same measurement sees the clicks (> −50 dB)', () => {
    const y = resample(hpfTrim(abruptSine(), FS), 1.6);
    applyGain(y, FS, isVoiced(y, FS));
    const [head, tail] = boundaryRatiosDb(y);
    expect(head).toBeGreaterThan(-50);
    expect(tail).toBeGreaterThan(-50);
  });
});

describe('Validation 6: trim', () => {
  // A steady vowel with 20 ms raised-cosine fades (as gen-fixtures), aligned to the 10 ms frame grid. The
  // fixture vowel_f0-140 (4 Hz syllabic envelope) padded to 1 s of zeros trims to exactly ±10.00 ms, on the
  // tolerance boundary, and a vowel with an abrupt end keeps one more frame of 80 Hz high-pass ring-down
  // (+10 ms), so neither is used here.
  it('a vowel with 1 s of leading and trailing zeros is trimmed to the vowel ± 50 ms (±10 ms)', () => {
    const vowel = steadyVowel(140, 0.5, -12, FS, 20);
    const x = padded(FS, vowel, FS);
    const { start, end } = trimRange(hpfTrim(x, FS, false), FS);
    expect(Math.abs(start - (FS - 2400))).toBeLessThanOrEqual(480);
    expect(Math.abs(end - (FS + vowel.length + 2400))).toBeLessThanOrEqual(480);
    const out = processVoice(x, FS, PRESETS.cub);
    const expected = Math.round((vowel.length + 4800) / 1.6);
    expect(Math.abs(out.pcm.length - expected)).toBeLessThanOrEqual(Math.round(960 / 1.6) + 1);
  });
});

/** `sec` seconds of speech-like input: a 0.4 s vowel every 0.5 s, with 20 % of the slots white noise instead. */
function speechLike(sec: number): Float32Array {
  const x = new Float32Array(Math.round(sec * FS));
  const vowel = steadyVowel(140, 0.4, -12);
  const rng = mulberry32(0x7e53);
  for (let s = 0; s + vowel.length <= x.length; s += FS / 2) {
    x.set(rng() < 0.8 ? vowel : whiteNoise(Math.floor(rng() * 2 ** 32), vowel.length, -26), s);
  }
  return x;
}

/** The median of a non-empty list (the upper one for an even count). */
function median(a: readonly number[]): number {
  return a.toSorted((p, q) => p - q)[a.length >> 1]!;
}

describe('Validation 7: timing (informational)', () => {
  it('logs the ms per second of audio for a 10 s clip at p = 1.6', { timeout: 60_000 }, () => {
    const x = speechLike(10);
    const seconds = x.length / FS;
    const names = [
      'clipDetect',
      'hpfTrim',
      'resample',
      'isVoiced',
      'applyGain',
      'fades',
      'envelope',
    ] as const;
    const stageMs: Record<(typeof names)[number], number[]> = {
      clipDetect: [],
      hpfTrim: [],
      resample: [],
      isVoiced: [],
      applyGain: [],
      fades: [],
      envelope: [],
    };
    const totalMs: number[] = [];
    const runs = 5;
    // Run 0 warms up. Each run starts from the input, and the in-place stages get fresh copies made outside
    // the timed regions, so the gain and the fades never compound across runs.
    for (let run = 0; run <= runs; run++) {
      let t = performance.now();
      clipDetect(x);
      const clipMs = performance.now() - t;
      t = performance.now();
      const trimmed = hpfTrim(x, FS);
      const hpfMs = performance.now() - t;
      t = performance.now();
      const y = resample(trimmed, 1.6);
      const resampleMs = performance.now() - t;
      t = performance.now();
      const voiced = isVoiced(y, FS);
      const voicedMs = performance.now() - t;
      const gained = y.slice();
      t = performance.now();
      applyGain(gained, FS, voiced);
      const gainMs = performance.now() - t;
      const faded = gained.slice();
      t = performance.now();
      fades(faded, FS);
      const fadesMs = performance.now() - t;
      t = performance.now();
      envelope(faded, FS, 1.6);
      const envelopeMs = performance.now() - t;
      t = performance.now();
      processVoice(x, FS, PRESETS.cub);
      const allMs = performance.now() - t;
      if (run === 0) continue;
      stageMs.clipDetect.push(clipMs);
      stageMs.hpfTrim.push(hpfMs);
      stageMs.resample.push(resampleMs);
      stageMs.isVoiced.push(voicedMs);
      stageMs.applyGain.push(gainMs);
      stageMs.fades.push(fadesMs);
      stageMs.envelope.push(envelopeMs);
      totalMs.push(allMs);
    }
    const total = median(totalMs);
    const stages = names.map((name) => `${name} ${(median(stageMs[name]) / seconds).toFixed(2)}`).join(', ');
    console.log(
      `[T53 timing] processVoice, ${seconds} s of 48 kHz speech-like input at p = 1.6: total ${total.toFixed(1)} ms ` +
        `(${(total / seconds).toFixed(2)} ms per second of audio, median of ${runs}); stages ms/s: ${stages}`,
    );
    expect(Number.isFinite(total)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Duck plan T114: the isVoiced early exit and the true-peak block skip change no output bit.

/** isVoiced as it was before T114 (the whole 8 kHz copy made offline), kept verbatim as the reference. */
function isVoicedBeforeT114(y: Float32Array, fs: number): boolean {
  const z = resampleOffline(y, 8000 / fs);
  const voicing = createVoicing(8000);
  let count = 0;
  for (let s = 0; s + 256 <= z.length; s += 160) {
    if (voicing.score(z.subarray(s, s + 256)) > VOICED_THRESHOLD) {
      count++;
      if (count >= 3) return true;
    }
  }
  return false;
}

/** BS.1770-4 Annex 2 true-peak FIR, phase-major (tap k of phase p at p·12 + k), as normalize.ts holds it. */
const TRUE_PEAK_FIR_BEFORE = new Float64Array([
  0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
  0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125,
  -0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625,
  -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375, -0.0189208984375,
  0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625,
  -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875, -0.00830078125,
  0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625,
  -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
]);

/** truePeakDbtp as it was before T114 (every output scanned), kept verbatim as the reference. */
function truePeakDbtpBeforeT114(x: Float32Array): number {
  const TP_TAPS = 12;
  const n = x.length;
  const f = TRUE_PEAK_FIR_BEFORE;
  let peak = 0;
  for (let m = 0; m < n + TP_TAPS - 1; m++) {
    const kLo = m >= n ? m - n + 1 : 0;
    const kHi = m < TP_TAPS - 1 ? m : TP_TAPS - 1;
    let y0 = 0;
    let y1 = 0;
    let y2 = 0;
    let y3 = 0;
    for (let k = kLo; k <= kHi; k++) {
      const v = x[m - k]!;
      y0 += f[k]! * v;
      y1 += f[TP_TAPS + k]! * v;
      y2 += f[2 * TP_TAPS + k]! * v;
      y3 += f[3 * TP_TAPS + k]! * v;
    }
    const a = Math.max(Math.abs(y0), Math.abs(y1), Math.abs(y2), Math.abs(y3));
    if (a > peak) peak = a;
  }
  return 20 * Math.log10(peak);
}

/**
 * processVoice as it was before T114: the same stages, with isVoicedBeforeT114 and voiceGainDb's rule written
 * out on truePeakDbtpBeforeT114. Also asserts that the new isVoiced and truePeakDbtp agree on the stage inputs.
 */
function processVoiceBeforeT114(pcm: Float32Array, fs: number, p: number, label: string): VoiceResult {
  const clipped = clipDetect(pcm);
  const y = resample(hpfTrim(pcm, fs), p);
  const voiced = isVoicedBeforeT114(y, fs);
  expect(isVoiced(y, fs), label).toBe(voiced);
  const l = integratedLoudness(y, fs);
  let loudGain = 0;
  if (l !== -Infinity) {
    loudGain = voiced
      ? Math.min(LOUDNESS.targetLufs - l, LOUDNESS.maxMakeupDb)
      : Math.min(0, LOUDNESS.targetLufs - l);
  }
  const tp = truePeakDbtpBeforeT114(y);
  expect(truePeakDbtp(y), label).toBe(tp);
  const g = Math.min(loudGain, LOUDNESS.ceilingDbtp - tp);
  const k = 10 ** (g / 20);
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * k;
  applyFades(y, fs, 8);
  const env = analyzeEnvelope(y, fs, p);
  return { pcm: y, envelope: env, durationSec: y.length / fs, clipped };
}

const PRESET_LIST: readonly VoicePreset[] = [PRESETS.cub, PRESETS.chipmunk, PRESETS.bigbear];

describe('T114: isVoiced early exit and true-peak block skip are exact', () => {
  const fixtureNames = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.wav'))
    .toSorted()
    .map((f) => f.slice(0, -'.wav'.length));
  const CORPUS = join(FIXTURES, '..', 'corpus', 'speech');
  const corpusFiles = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.wav'))
    .toSorted();

  it('finds the fixture and corpus WAVs', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(11);
    expect(corpusFiles.length).toBeGreaterThanOrEqual(100);
  });

  it.each(fixtureNames)(
    '%s: processVoice is bit-identical to the pre-T114 chain for every preset, and isVoiced agrees',
    (name) => {
      const x = fixture(name);
      for (const pr of PRESET_LIST) {
        const label = `${name} ${pr.id}`;
        expectSameResult(processVoice(x, FS, pr), processVoiceBeforeT114(x, FS, pr.pitchRatio, label));
      }
      // isVoiced on the raw fixture, after the chain at the other test pitch ratio, and at 44.1 kHz for cub.
      expect(isVoiced(x, FS), name).toBe(isVoicedBeforeT114(x, FS));
      const y22 = resample(hpfTrim(x, FS), 2.2);
      expect(isVoiced(y22, FS), name).toBe(isVoicedBeforeT114(y22, FS));
      const y441 = resample(hpfTrim(resampleOffline(x, 44100 / FS), 44100), PRESETS.cub.pitchRatio);
      expect(isVoiced(y441, 44100), `${name} 44.1 kHz cub`).toBe(isVoicedBeforeT114(y441, 44100));
    },
  );

  it('isVoiced returns the same boolean as before on every test/corpus/speech WAV', () => {
    let voiced = 0;
    for (const file of corpusFiles) {
      const { sampleRate, channels } = readWav(readFileSync(join(CORPUS, file)));
      const x = channels[0]!;
      expect(isVoiced(x, sampleRate), file).toBe(isVoicedBeforeT114(x, sampleRate));
      // Through the chain's pitch shift as processVoice calls it, at the corpus rate (16 kHz), for every preset.
      // (The fixtures above cover 48 and 44.1 kHz; a 48 kHz pass over the corpus would add about 2 s.)
      const trimmed = hpfTrim(x, sampleRate);
      for (const pr of PRESET_LIST) {
        const y = resample(trimmed, pr.pitchRatio);
        const before = isVoicedBeforeT114(y, sampleRate);
        expect(isVoiced(y, sampleRate), `${file} ${pr.id}`).toBe(before);
        if (before) voiced++;
      }
    }
    // Most takes are voiced, so the early exit is exercised (the whisper renders are not).
    expect(voiced).toBeGreaterThan(0.75 * PRESET_LIST.length * corpusFiles.length);
  });

  it('isVoiced agrees with the pre-T114 function when only the flushed tail completes the third window', () => {
    // A 200 Hz tone over the last 50, 55 or 60 ms of 0.25 s of silence, for 8 kHz copy lengths across one hop:
    // only the last few windows are voiced, and in some cases the third one ends in the samples that only
    // flush() emits (an isVoiced that skipped the windows after flush() fails some of these cases).
    let voiced = 0;
    let cases = 0;
    for (const fs of [8000, 16000, 44100, 48000]) {
      for (const ms of [50, 55, 60]) {
        for (let extra = 0; extra < VOICING_HOP; extra += 3) {
          const n = Math.round(((2000 + extra) * fs) / 8000);
          const y = new Float32Array(n);
          const len = Math.round((ms / 1000) * fs);
          for (let i = 0; i < len; i++) y[n - len + i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / fs);
          const before = isVoicedBeforeT114(y, fs);
          expect(isVoiced(y, fs), `fs ${fs}, ${ms} ms, n ${n}`).toBe(before);
          if (before) voiced++;
          cases++;
        }
      }
    }
    expect(voiced).toBeGreaterThan(0);
    expect(voiced).toBeLessThan(cases);
  });

  it('isVoiced returns the same boolean as before on random bursts (property)', () => {
    const input = fastCheck.record({
      fs: fastCheck.constantFrom(8000, 16000, 44100, 48000),
      sec: fastCheck.double({ min: 0, max: 1.2, noNaN: true }),
      bursts: fastCheck.array(
        fastCheck.tuple(
          fastCheck.oneof(fastCheck.constant(1), fastCheck.double({ min: 0, max: 1, noNaN: true })),
          fastCheck.integer({ min: 4, max: 80 }),
        ),
        { maxLength: 4 },
      ),
    });
    fastCheck.assert(
      fastCheck.property(input, ({ fs, sec, bursts: list }) => {
        const n = Math.round(sec * fs);
        const y = new Float32Array(n);
        // Short 200 Hz bursts (`ms` long) at fractional positions; position 1 puts one at the very end.
        for (const [at, ms] of list) {
          const len = Math.min(n, Math.round((ms / 1000) * fs));
          const from = Math.round(at * (n - len));
          for (let i = 0; i < len; i++) y[from + i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / fs);
        }
        return isVoiced(y, fs) === isVoicedBeforeT114(y, fs);
      }),
      { numRuns: 200 },
    );
  });
});
