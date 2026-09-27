import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rmsDb, sine } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import { butterworthHighpass } from './biquad.ts';
import { analyzeEnvelope } from './envelope.ts';
import { applyFades } from './fades.ts';
import { voiceGainDb } from './normalize.ts';
import { resampleOffline } from './resample.ts';
import type { Envelope, VoicePreset } from './types.ts';
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
  voiceStages,
  type VoiceResult,
} from './voice.ts';

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
