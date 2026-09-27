import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mulberry32, rmsDb, sine } from '../../test/dsp-helpers.ts';
import { readWav } from '../../test/wav.ts';
import type { BiquadCoefficients } from './biquad.ts';
import {
  integratedLoudness,
  kWeighting,
  kWeightingCoefficients,
  LOUDNESS,
  truePeakDbtp,
  voiceGainDb,
} from './normalize.ts';
import { resampleOffline } from './resample.ts';

// BS.1770-4 Table 1 / Table 2 coefficients at 48 kHz, as pinned by the issue.
const PINNED_SHELF: BiquadCoefficients = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const PINNED_RLB: BiquadCoefficients = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

/** Float64 two-stage DF2T reference with the given coefficients. */
function referenceKWeighting(x: Float32Array, stages: readonly BiquadCoefficients[]): Float64Array {
  const y = Float64Array.from(x);
  for (const c of stages) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i]!;
      const yi = c.b0 * xi + s1;
      s1 = c.b1 * xi - c.a1 * yi + s2;
      s2 = c.b2 * xi - c.a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

function meanSquare(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! * x[i]!;
  return sum / (to - from);
}

function noise(n: number, seed: number, amp = 1): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (2 * rand() - 1);
  return x;
}

describe('kWeighting', () => {
  it('2: coefficients at 48 kHz match BS.1770-4 within 1e-6', () => {
    const [shelf, rlb] = kWeightingCoefficients(48000);
    for (const [got, want] of [
      [shelf, PINNED_SHELF],
      [rlb, PINNED_RLB],
    ] as const) {
      for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
        expect(Math.abs(got[key] - want[key])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('the returned filter runs those stages: impulse response matches the pinned reference within 1e-6', () => {
    const x = new Float32Array(4096);
    x[0] = 1;
    const y = kWeighting(48000).process(x);
    const ref = referenceKWeighting(x, [PINNED_SHELF, PINNED_RLB]);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i]! - ref[i]!));
    expect(maxErr).toBeLessThanOrEqual(1e-6);
  });

  it('rejects an invalid fs with RangeError', () => {
    for (const fs of [0, Number.NaN, 3000]) expect(() => kWeighting(fs)).toThrow(RangeError);
  });
});

describe('integratedLoudness', () => {
  it('2: full-scale 997 Hz sine, 10 s: −3.01 ± 0.05 LUFS at 48 kHz, ± 0.1 at 44.1 and 16 kHz', () => {
    expect(Math.abs(integratedLoudness(sine(997, 48000, 10, 1), 48000) - -3.01)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(integratedLoudness(sine(997, 44100, 10, 1), 44100) - -3.01)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(integratedLoudness(sine(997, 16000, 10, 1), 16000) - -3.01)).toBeLessThanOrEqual(0.1);
  });

  it('2: −23 dBFS-amplitude 1 kHz sine, 10 s at 48 kHz: −26.01 ± 0.05 LUFS', () => {
    const x = sine(1000, 48000, 10, 10 ** (-23 / 20));
    expect(Math.abs(integratedLoudness(x, 48000) - -26.01)).toBeLessThanOrEqual(0.05);
  });

  it('short-clip rule: a 200 ms full-scale sine reads −3.01 ± 0.1 (no zero-padding)', () => {
    const x = sine(997, 48000, 0.2, 1);
    expect(x.length).toBeLessThan(0.4 * 48000);
    expect(Math.abs(integratedLoudness(x, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
  });

  it('short-clip rule: equals −0.691 + 10·log10(mean square of the whole K-weighted clip)', () => {
    const x = noise(4800, 11, 0.3);
    const expected = -0.691 + 10 * Math.log10(meanSquare(kWeighting(48000).process(x)));
    expect(Math.abs(integratedLoudness(x, 48000) - expected)).toBeLessThanOrEqual(1e-9);
  });

  it('short-clip rule is ungated: a ≈ −103 LUFS 100 ms clip is finite', () => {
    const l = integratedLoudness(sine(997, 48000, 0.1, 1e-5), 48000);
    expect(Number.isFinite(l)).toBe(true);
    expect(l).toBeLessThan(-90);
  });

  it('absolute gate: a 10 s clip at ≈ −78 LUFS is −Infinity; its 200 ms version is finite', () => {
    const amp = 10 ** (-75 / 20);
    expect(integratedLoudness(sine(997, 48000, 10, amp), 48000)).toBe(-Infinity);
    const short = integratedLoudness(sine(997, 48000, 0.2, amp), 48000);
    expect(Math.abs(short - -78.01)).toBeLessThanOrEqual(0.2);
  });

  it('relative gate: 5 s at full scale then 5 s at −20 dB reads −3.01 ± 0.2, above the ungated mean', () => {
    const fs = 48000;
    const x = sine(997, fs, 10, 1);
    for (let i = 5 * fs; i < x.length; i++) x[i] = x[i]! * 0.1;
    const gated = integratedLoudness(x, fs);
    expect(Math.abs(gated - -3.01)).toBeLessThanOrEqual(0.2);
    // Ungated all-blocks mean: every 400 ms block (B = 19200, H = 4800) of the K-weighted signal.
    const y = kWeighting(fs).process(x);
    const blockLen = 19200;
    const hop = 4800;
    let sum = 0;
    let count = 0;
    for (let start = 0; start + blockLen <= y.length; start += hop) {
      sum += meanSquare(y, start, start + blockLen);
      count++;
    }
    expect(count).toBe(Math.floor((x.length - blockLen) / hop) + 1);
    const ungated = -0.691 + 10 * Math.log10(sum / count);
    expect(gated).toBeGreaterThan(ungated);
  });

  it('silence and empty input are −Infinity', () => {
    expect(integratedLoudness(new Float32Array(480_000), 48000)).toBe(-Infinity);
    expect(integratedLoudness(new Float32Array(4800), 48000)).toBe(-Infinity);
    expect(integratedLoudness(new Float32Array(0), 48000)).toBe(-Infinity);
  });

  it('boundary: exactly 0.4·fs samples uses one gated block; one sample fewer uses the short-clip rule', () => {
    const block = sine(997, 48000, 0.4, 1);
    expect(block.length).toBe(19200);
    expect(Math.abs(integratedLoudness(block, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
    const shorter = block.slice(0, 19199);
    expect(Math.abs(integratedLoudness(shorter, 48000) - -3.01)).toBeLessThanOrEqual(0.1);
    // One gated block of silence is gated out, while the short-clip rule is ungated.
    const quiet = sine(997, 48000, 0.4, 1e-5);
    expect(integratedLoudness(quiet, 48000)).toBe(-Infinity);
    expect(Number.isFinite(integratedLoudness(quiet.slice(0, 19199), 48000))).toBe(true);
  });

  it('rejects an invalid fs with RangeError', () => {
    const x = new Float32Array(100);
    for (const fs of [0, Number.NaN, 3000]) expect(() => integratedLoudness(x, fs)).toThrow(RangeError);
    expect(() => integratedLoudness(new Float32Array(0), 0)).toThrow(RangeError);
  });
});

// ITU-R BS.1770-4 Annex 2 coefficient table, as printed: 12 rows (taps) × 4 columns (phases 0–3). This is a second,
// independent transcription; read row by row it is the interleaved 48-tap filter h[4k + p].
const ANNEX2_TABLE: readonly (readonly [number, number, number, number])[] = [
  [0.001708984375, -0.0291748046875, -0.0189208984375, -0.00830078125],
  [0.010986328125, 0.029296875, 0.0330810546875, 0.014892578125],
  [-0.0196533203125, -0.0517578125, -0.0582275390625, -0.026611328125],
  [0.033203125, 0.089111328125, 0.1015625, 0.047607421875],
  [-0.0594482421875, -0.16650390625, -0.2003173828125, -0.102294921875],
  [0.1373291015625, 0.465087890625, 0.77978515625, 0.97216796875],
  [0.97216796875, 0.77978515625, 0.465087890625, 0.1373291015625],
  [-0.102294921875, -0.2003173828125, -0.16650390625, -0.0594482421875],
  [0.047607421875, 0.1015625, 0.089111328125, 0.033203125],
  [-0.026611328125, -0.0582275390625, -0.0517578125, -0.0196533203125],
  [0.014892578125, 0.0330810546875, 0.029296875, 0.010986328125],
  [-0.00830078125, -0.0189208984375, -0.0291748046875, 0.001708984375],
];
const H48 = ANNEX2_TABLE.flat();

/** Reference true peak: the 4× zero-stuffed x fully convolved with the 48-tap h, max |y| in dB. */
function directTruePeakDb(x: Float32Array): number {
  const v = new Float64Array(4 * x.length);
  for (let i = 0; i < x.length; i++) v[4 * i] = x[i]!;
  let peak = 0;
  for (let j = 0; j < v.length + H48.length - 1; j++) {
    let acc = 0;
    for (let i = 0; i < H48.length; i++) {
      const idx = j - i;
      if (idx >= 0 && idx < v.length) acc += H48[i]! * v[idx]!;
    }
    peak = Math.max(peak, Math.abs(acc));
  }
  return 20 * Math.log10(peak);
}

const FS = 48000;
const FADE_SAMPLES = 960;

/** One 2nd-order Klatt resonator (unity gain at DC), as in scripts/gen-fixtures.ts. */
function resonate(x: Float64Array, freq: number, bandwidth: number): Float64Array {
  const C = -Math.exp((-2 * Math.PI * bandwidth) / FS);
  const B = 2 * Math.exp((-Math.PI * bandwidth) / FS) * Math.cos((2 * Math.PI * freq) / FS);
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

function fadeIn(i: number): number {
  return 0.5 * (1 - Math.cos((Math.PI * i) / FADE_SAMPLES));
}

/**
 * The vowel_short_100ms-style synthetic vowel of scripts/gen-fixtures.ts (whose vowel() is not exported):
 * a jittered impulse train at f0 through resonators F1 700/80, F2 1220/90, F3 2600/120 Hz, a 4 Hz syllabic
 * envelope, 20 ms raised-cosine fades, peak-normalised to −12 dBFS; 48 kHz.
 */
function synthVowel(rng: () => number, f0: number, durationS: number): Float32Array {
  const n = Math.round(durationS * FS);
  const excitation = new Float64Array(n);
  let pos = 0;
  while (Math.round(pos) < n) {
    excitation[Math.round(pos)] = 1;
    pos += (FS / f0) * (1 + 0.01 * (2 * rng() - 1));
  }
  let y = resonate(excitation, 700, 80);
  y = resonate(y, 1220, 90);
  y = resonate(y, 2600, 120);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let gain = 0.5 * (1 - Math.cos((2 * Math.PI * 4 * i) / FS));
    if (i < FADE_SAMPLES) gain *= fadeIn(i);
    if (i >= n - FADE_SAMPLES) gain *= fadeIn(n - 1 - i);
    y[i] = y[i]! * gain;
    peak = Math.max(peak, Math.abs(y[i]!));
  }
  const g = 10 ** (-12 / 20) / peak;
  return Float32Array.from(y, (v) => v * g);
}

/** x scaled so that its RMS is `db` dBFS. */
function atRmsDb(x: Float32Array, db: number): Float32Array {
  const g = 10 ** (db / 20) / Math.sqrt(meanSquare(x));
  return Float32Array.from(x, (v) => v * g);
}

/** x multiplied by 10^(gainDb/20) into a new array. */
function applyGain(x: Float32Array, gainDb: number): Float32Array {
  const g = 10 ** (gainDb / 20);
  return Float32Array.from(x, (v) => v * g);
}

describe('truePeakDbtp', () => {
  it('the Annex 2 table: 48 taps, every value a multiple of 2^-13, symmetric', () => {
    expect(H48.length).toBe(48);
    for (const v of H48) expect(Number.isInteger(v * 8192)).toBe(true);
    for (let i = 0; i < 48; i++) expect(H48[i]).toBe(H48[47 - i]);
  });

  it('polyphase result equals the direct zero-stuffed 48-tap convolution within 1e-9 dB', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const x = noise(64, seed);
      expect(Math.abs(truePeakDbtp(x) - directTruePeakDb(x))).toBeLessThanOrEqual(1e-9);
    }
    const x = noise(1000, 99);
    expect(Math.abs(truePeakDbtp(x) - directTruePeakDb(x))).toBeLessThanOrEqual(1e-9);
  });

  it('6: inter-sample peak — 12 kHz sine at 48 kHz, amplitude 0.5, phase π/4 reads −6.02 ± 0.2 dBTP', () => {
    const x = sine(12000, FS, 1, 0.5, Math.PI / 4);
    let samplePeak = 0;
    for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(Math.abs(20 * Math.log10(samplePeak) - -9.03)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(truePeakDbtp(x) - -6.02)).toBeLessThanOrEqual(0.2);
  });

  it('scans the filter drain after the last sample and the onset before the first', () => {
    const expected = 20 * Math.log10(0.97216796875);
    const last = new Float32Array(100);
    last[99] = 1;
    expect(Math.abs(truePeakDbtp(last) - expected)).toBeLessThanOrEqual(1e-9);
    const first = new Float32Array(100);
    first[0] = 1;
    expect(Math.abs(truePeakDbtp(first) - expected)).toBeLessThanOrEqual(1e-9);
  });

  it('full-scale 997 Hz sine reads 0 ± 0.2 dBTP; scaling by 0.25 lowers it by 12.041 dB', () => {
    const x = sine(997, FS, 0.5, 1);
    const tp = truePeakDbtp(x);
    expect(Math.abs(tp)).toBeLessThanOrEqual(0.2);
    const quarter = Float32Array.from(x, (v) => v * 0.25);
    expect(Math.abs(truePeakDbtp(quarter) - (tp - 12.041))).toBeLessThanOrEqual(1e-3);
  });

  it('silence and empty input are −Infinity', () => {
    expect(truePeakDbtp(new Float32Array(1000))).toBe(-Infinity);
    expect(truePeakDbtp(new Float32Array(0))).toBe(-Infinity);
  });
});

describe('voiceGainDb', () => {
  it('3: short clip — a 150 ms "hi" at ratio 0.5 gets a finite gain within the caps', () => {
    const v = synthVowel(mulberry32(0xbea2), 140, 0.15);
    expect(v.length).toBe(7200);
    const y = resampleOffline(v, 0.5);
    expect(y.length).toBe(3600);
    expect(y.length).toBeLessThan(0.4 * FS);
    expect(Number.isFinite(integratedLoudness(y, FS))).toBe(true);
    const g = voiceGainDb(y, FS, true);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeLessThanOrEqual(LOUDNESS.maxMakeupDb);
    expect(g).toBeLessThanOrEqual(LOUDNESS.ceilingDbtp - truePeakDbtp(y) + 1e-12);
  });

  it('4: whisper vs normal — the make-up cap keeps the whisper quieter', () => {
    const v = synthVowel(mulberry32(0xbea2), 140, 1.5);
    const whisper = atRmsDb(v, -45);
    const normal = atRmsDb(v, -25);
    expect(Math.abs(rmsDb(whisper) - -45)).toBeLessThan(0.01);
    const gw = voiceGainDb(whisper, FS, true);
    const gn = voiceGainDb(normal, FS, true);
    expect(gw).toBe(12);
    const lw = integratedLoudness(applyGain(whisper, gw), FS);
    const ln = integratedLoudness(applyGain(normal, gn), FS);
    expect(lw).toBeLessThan(ln);
    expect(Math.abs(ln - LOUDNESS.targetLufs)).toBeLessThanOrEqual(0.1);
  });

  it('5: unvoiced white noise at −40 dBFS is never amplified', () => {
    const x = atRmsDb(noise(2 * FS, 5), -40);
    const g = voiceGainDb(x, FS, false);
    expect(g).toBeLessThanOrEqual(0);
    expect(g).toBe(0);
  });

  it('loud unvoiced input is attenuated to the target', () => {
    const x = atRmsDb(noise(2 * FS, 6), -10);
    const l = integratedLoudness(x, FS);
    const g = voiceGainDb(x, FS, false);
    expect(g).toBeLessThan(0);
    expect(g).toBe(Math.min(Math.min(0, -20 - l), -3 - truePeakDbtp(x)));
  });

  it('loud voiced input is only attenuated', () => {
    const x = sine(997, FS, 2, 0.5);
    const l = integratedLoudness(x, FS);
    const g = voiceGainDb(x, FS, true);
    expect(g).toBeLessThan(0);
    expect(g).toBe(Math.min(Math.min(-20 - l, 12), -3 - truePeakDbtp(x)));
  });

  it('the true-peak ceiling binds for a sparse click train', () => {
    const x = new Float32Array(FS);
    for (let i = 0; i < x.length; i += 4800) x[i] = 0.9;
    const g = voiceGainDb(x, FS, true);
    expect(g).toBe(-3 - truePeakDbtp(x));
    expect(g).toBeLessThan(12);
  });

  it('silence and empty input get exactly 0 dB', () => {
    for (const voiced of [true, false]) {
      expect(voiceGainDb(new Float32Array(FS), FS, voiced)).toBe(0);
      expect(voiceGainDb(new Float32Array(0), FS, voiced)).toBe(0);
    }
  });

  it('respects custom options', () => {
    const normal = atRmsDb(synthVowel(mulberry32(0xbea2), 140, 1.5), -25);
    const o = { targetLufs: -30, maxMakeupDb: 6, ceilingDbtp: -1 };
    const l = integratedLoudness(normal, FS);
    const tp = truePeakDbtp(normal);
    const g = voiceGainDb(normal, FS, true, o);
    expect(g).toBe(Math.min(-30 - l, 6, -1 - tp));
    expect(g).toBeLessThan(0);
  });
});

describe('6: true-peak ceiling on every test/fixtures WAV', () => {
  const dir = join(fileURLToPath(new URL('../../', import.meta.url)), 'test', 'fixtures');
  const wavs = readdirSync(dir)
    .filter((f) => f.endsWith('.wav'))
    .toSorted();

  it('finds the fixture WAVs', () => {
    expect(wavs.length).toBeGreaterThanOrEqual(11);
  });

  it.each(wavs)('%s: true peak after voiceGainDb ≤ −3.0 dBTP + 0.05 (voiced and unvoiced)', (name) => {
    const { sampleRate, channels } = readWav(readFileSync(join(dir, name)));
    for (const ch of channels) {
      for (const voiced of [true, false]) {
        const g = voiceGainDb(ch, sampleRate, voiced);
        expect(Number.isFinite(g)).toBe(true);
        expect(truePeakDbtp(applyGain(ch, g))).toBeLessThanOrEqual(-3.0 + 0.05);
      }
    }
  });
});
